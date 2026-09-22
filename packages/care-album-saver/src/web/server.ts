import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { BrightwheelClient } from '../api/client.js';
import type { Student } from '../api/schema.js';
import { loadConfig, loadSession, saveConfig, saveSession, type Config } from '../config.js';
import { Secret, scrub } from '../secrets.js';
import { cleanPastedPath, inspectCookiePaste, PASTE_CLIENT_SOURCE } from '../paste.js';
import { sync, type SyncProgress } from '../sync.js';
import { checkArchiveDir } from '../safety.js';
import { chooseFolder, openFolder, type NativeOptions } from '../native.js';
import { auditArchive, checkChildren, findDuplicates, removeDuplicates, repairManifest } from '../maintenance.js';
import * as schedule from '../schedule.js';
import { PAGE } from './page.js';

/**
 * The local setup assistant.
 *
 * Runs on the parent's own machine and is reachable only from that machine. Four controls
 * make that true, and each one blocks a real attack:
 *
 *  1. Bound to 127.0.0.1, never 0.0.0.0. On 0.0.0.0 the UI would be reachable by anyone on
 *     the same cafe or hotel wifi.
 *
 *  2. The Host header is checked against an allowlist. Without this, a hostile website can
 *     point a domain it controls at 127.0.0.1 (DNS rebinding) and then read this UI's
 *     responses from the victim's browser, because to the browser it is same-origin.
 *
 *  3. Cross-site requests are rejected via Sec-Fetch-Site and Origin. A page the parent is
 *     merely visiting can otherwise POST to http://127.0.0.1:PORT in the background.
 *
 *  4. Every request carries a one-time token printed by the CLI. Other local accounts and
 *     other processes on a shared computer cannot reach the UI without it.
 *
 * Two of the routes below — /api/choose-folder and /api/open-folder — make a process start
 * on the parent's machine, which is a step up from reading and writing this tool's own
 * files. They are guarded by all four of the controls above and by two more of their own;
 * the reasoning is written out at the routes themselves.
 */

const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function hostAllowed(header: string | undefined): boolean {
  if (!header) return false;
  const host = header.replace(/:\d+$/, '');
  return ALLOWED_HOSTS.has(host);
}

function crossSite(req: IncomingMessage): boolean {
  const fetchSite = req.headers['sec-fetch-site'];
  if (typeof fetchSite === 'string' && fetchSite !== 'same-origin' && fetchSite !== 'none') return true;
  const origin = req.headers.origin;
  if (typeof origin === 'string') {
    try {
      if (!hostAllowed(new URL(origin).host)) return true;
    } catch {
      return true;
    }
  }
  return false;
}

function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error('Request body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export interface WebUiOptions {
  port?: number;
  baseUrl?: string;
  openBrowser?: boolean;
  /**
   * How the operating system's folder chooser and file manager are launched. The suite
   * passes a stand-in, because no test can click a real dialog and none should open windows
   * on the machine running it. Nothing in the product passes anything here.
   */
  native?: NativeOptions;
}

export interface WebUiHandle {
  url: string;
  port: number;
  token: string;
  /**
   * Ask a running sync to stop, and wait until it has. It finishes the download in
   * flight and records what it saved, so nothing already on disk is lost or fetched twice.
   * Resolves at once when nothing is running.
   */
  stop: () => Promise<void>;
  /** Stops any run first: a server that vanishes mid-download leaves the manifest unsaved. */
  close: () => Promise<void>;
}

export async function startWebUi(options: WebUiOptions = {}): Promise<WebUiHandle> {
  const token = randomBytes(24).toString('base64url');
  let progress: SyncProgress = { phase: 'starting', message: 'Ready', saved: 0, skipped: 0, failed: 0 };
  let running = false;
  let lastResult: unknown = null;
  // The run in progress, if any: its abort handle and the promise that settles when sync
  // has saved the manifest and returned. `stop()` needs both — aborting is not enough,
  // because the caller (the CLI on Ctrl+C, close()) must not tear the process down while
  // the in-flight download is still being written.
  let current: { controller: AbortController; done: Promise<void> } | null = null;
  // The children on the account, as last read from Brightwheel. Kept so that choosing a
  // child in the page does not cost a round trip to Brightwheel per tick, and so that
  // "every child is ticked" can be recognised and stored as "all" (an empty list), which
  // is what keeps a child added to the account later from being silently left out.
  let children: Student[] | null = null;
  // Settings now save themselves as each control changes, so two quick ticks can arrive
  // together. Each save is a read-modify-write of one file; run them one at a time or the
  // second read can miss the first write and quietly undo it.
  let configWrites: Promise<void> = Promise.resolve();

  const withConfigLock = <T>(work: () => Promise<T>): Promise<T> => {
    const result = configWrites.then(work);
    // A refused save must not jam the queue for the saves after it.
    configWrites = result.then(() => {}, () => {});
    return result;
  };

  const readChildren = async (client: BrightwheelClient): Promise<Student[]> => {
    if (!children) {
      const me = await client.me();
      children = await client.students(me.id);
    }
    return children;
  };

  /**
   * A stored selection that names nobody on the account any more. It happens: a child
   * leaves the nursery and a sibling joins, or the parent connects a different account.
   * It is stale, not a decision to save no one — that choice cannot be made here, because
   * an empty selection is refused on save — so it is read as "all", which is what a fresh
   * setup starts from and what the page will show ticked.
   */
  const selectionIsStale = (config: Config, list: Student[]): boolean =>
    config.includeStudents.length > 0 && !list.some((s) => config.includeStudents.includes(s.id));

  /** Which of the account's children the config selects. Empty config means all of them. */
  const includedIds = (config: Config, list: Student[]): string[] =>
    config.includeStudents.length === 0 || selectionIsStale(config, list)
      ? list.map((s) => s.id)
      : list.filter((s) => config.includeStudents.includes(s.id)).map((s) => s.id);

  /**
   * Check a child selection before it is stored.
   *
   * The page sends the ids that are ticked, never the empty-means-all shorthand, so that
   * "nothing ticked" is expressible and can be refused here rather than turning into a
   * confusing "no children found" the first time a run starts.
   */
  const checkIncludeStudents = async (
    value: unknown,
  ): Promise<{ ok: true; resolved: string[] } | { ok: false; error: string }> => {
    if (!Array.isArray(value) || !value.every((v) => typeof v === 'string' && v.length > 0)) {
      return { ok: false, error: 'Could not read which children were chosen. Reload the page and try again.' };
    }
    const chosen = [...new Set(value as string[])];
    const session = await loadSession();
    if (!session) {
      // Before step 1 there is no list to have chosen from, so ids arriving now can only be
      // stale or made up, and stored unchecked they would silently filter every later run.
      // The one thing that is meaningful here is "all", the stored default.
      if (chosen.length === 0) return { ok: true, resolved: [] };
      return {
        ok: false,
        error: 'Connect to your Brightwheel account first (step 1). Children can only be chosen once the tool can see them.',
      };
    }
    if (chosen.length === 0) {
      return { ok: false, error: 'Tick at least one child. Photos are only saved for the children you tick.' };
    }
    const known = await readChildren(new BrightwheelClient({ session: session.session, baseUrl: options.baseUrl }));
    const knownIds = new Set(known.map((s) => s.id));
    if (chosen.some((id) => !knownIds.has(id))) {
      return {
        ok: false,
        error: 'One of the chosen children is no longer on this Brightwheel account. Reload the page and choose again.',
      };
    }
    return { ok: true, resolved: known.every((s) => chosen.includes(s.id)) ? [] : chosen };
  };

  /**
   * Validate a settings change and store it.
   *
   * Shared by /api/config and /api/choose-folder, so that a folder picked from the
   * operating system's dialog meets exactly the refusals a typed one does — the cloud-folder
   * warning included. A picker with its own, gentler path check would be a way around them.
   */
  type PatchResult =
    | { ok: true; config: Config; warning?: string }
    | { ok: false; error: string; field: 'archiveDir' | 'includeStudents' };

  const applyConfigPatch = async (patch: Partial<Config>): Promise<PatchResult> => {
    // Never persist a destination without checking it. This endpoint previously
    // accepted any path at all and the tool wrote a child's photos there.
    let warning: string | undefined;
    if (typeof patch.archiveDir === 'string') {
      patch.archiveDir = cleanPastedPath(patch.archiveDir);
      const verdict = checkArchiveDir(patch.archiveDir);
      if (!verdict.ok) return { ok: false, error: verdict.error ?? 'That folder cannot be used.', field: 'archiveDir' };
      patch.archiveDir = verdict.resolved;
      warning = verdict.warning;
    }
    if (patch.includeStudents !== undefined) {
      const verdict = await checkIncludeStudents(patch.includeStudents);
      if (!verdict.ok) return { ok: false, error: verdict.error, field: 'includeStudents' };
      patch.includeStudents = verdict.resolved;
    }
    const config = await withConfigLock(async () => {
      const merged = { ...(await loadConfig()), ...patch };
      // /api/children reads a stale selection as "all"; write it down as that the first
      // time the file is touched, so the two never disagree. Only possible once the
      // live list has been read — the cache is not refreshed for this.
      if (children && selectionIsStale(merged, children)) merged.includeStudents = [];
      await saveConfig(merged);
      return merged;
    });
    return { ok: true, config, warning };
  };

  /**
   * Whether a folder chooser is on screen. One at a time: the dialog blocks until it is
   * answered, so a second click would leave two modal windows fighting for the parent's
   * attention and two processes waiting on them.
   */
  let choosing = false;

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Nothing here may ever be cached: the pages list children's names and photos.
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'",
    );

    if (!hostAllowed(req.headers.host)) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('Blocked: unexpected Host header. This page is only reachable from this computer.');
      return;
    }
    if (crossSite(req)) {
      res.writeHead(403, { 'content-type': 'text/plain' }).end('Blocked: cross-site request.');
      return;
    }

    const url = new URL(req.url ?? '/', `http://127.0.0.1`);
    const provided = url.searchParams.get('token') ?? (req.headers['x-setup-token'] as string) ?? '';
    if (!tokenMatches(provided, token)) {
      res.writeHead(403, { 'content-type': 'text/html' });
      res.end('<h1>Wrong or missing setup link</h1><p>Use the exact link printed in your terminal.</p>');
      return;
    }

    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    try {
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(PAGE.replace(/__TOKEN__/g, token));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/state') {
        const config = await loadConfig();
        const session = await loadSession();
        json(200, {
          hasSession: Boolean(session),
          sessionFingerprint: session?.session.fingerprint() ?? null,
          sessionSavedAt: session?.savedAt.toISOString() ?? null,
          email: session?.email ?? null,
          config,
          progress,
          running,
          lastResult,
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/session') {
        const { cookie } = JSON.parse(await readBody(req)) as { cookie?: unknown };
        // The same check the page runs as the person types: it cleans what it can, refuses
        // what is certainly something else, and its message never repeats the paste.
        const verdict = inspectCookiePaste(typeof cookie === 'string' ? cookie : '');
        if (!verdict.ok) {
          json(400, { ok: false, error: verdict.message });
          return;
        }
        const secret = new Secret(verdict.value);
        const client = new BrightwheelClient({ session: secret, baseUrl: options.baseUrl });
        const check = await client.verifySession();
        if (!check.ok) {
          json(400, { ok: false, error: scrub(check.reason) });
          return;
        }
        await saveSession(secret, check.email);
        // A different account has different children.
        children = null;
        json(200, { ok: true, email: check.email, fingerprint: secret.fingerprint() });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/config') {
        const patch = JSON.parse(await readBody(req)) as Partial<Config>;
        const saved = await applyConfigPatch(patch);
        if (!saved.ok) {
          json(400, { ok: false, error: saved.error, field: saved.field });
          return;
        }
        json(200, { ok: true, config: saved.config, warning: saved.warning });
        return;
      }

      /**
       * Open the operating system's folder chooser and store what comes back.
       *
       * This is the endpoint that makes a process start, so: what stops a website the
       * parent happens to have open from reaching it?
       *
       *  - It is POST, so it cannot be triggered by an <img>, a <link>, a redirect or a
       *    plain link — the shapes a page can emit without any cooperation from the browser.
       *  - A cross-origin POST from a page is either blocked before it is sent (no CORS
       *    preflight is answered here) or arrives carrying Sec-Fetch-Site: cross-site and an
       *    Origin header. crossSite(), which runs above every route, refuses on either.
       *  - The Host allowlist stops the DNS-rebinding variant, where the attacker's own
       *    domain resolves to 127.0.0.1 so the browser considers the request same-origin.
       *  - The token settles the rest: a page that guessed the port still cannot read the
       *    24 random bytes printed in the parent's terminal, and a form POST it could send
       *    blind would arrive without them.
       *  - And one of its own: only one dialog may be open at a time, so even a request
       *    that somehow got through cannot paper the screen with choosers.
       *
       * What the dialog returns is then a path like any other. It is handed to the same
       * applyConfigPatch as a typed one, which is what keeps checkArchiveDir's refusals
       * meaningful; and it is never passed to a shell — see src/native.ts.
       */
      if (req.method === 'POST' && url.pathname === '/api/choose-folder') {
        if (choosing) {
          json(409, { ok: false, error: 'A folder chooser is already open. Answer that one first.' });
          return;
        }
        choosing = true;
        let choice;
        try {
          choice = await chooseFolder(options.native);
        } finally {
          choosing = false;
        }
        if (!choice.ok && choice.cancelled) {
          // Closing the dialog is an answer, not a failure, and nothing changes.
          json(200, { ok: true, cancelled: true });
          return;
        }
        if (!choice.ok) {
          // A computer with no chooser is not a broken request: it is the answer, and the
          // typed field is still there. 200 with the reason, so the page can say it plainly.
          json(200, { ok: false, error: scrub(choice.error) });
          return;
        }
        const saved = await applyConfigPatch({ archiveDir: choice.path });
        if (!saved.ok) {
          json(400, { ok: false, error: saved.error, field: saved.field });
          return;
        }
        json(200, { ok: true, config: saved.config, warning: saved.warning });
        return;
      }

      /**
       * Show the archive folder in the file manager — "where did my photos go", answered
       * by taking the parent there.
       *
       * The path comes from saved settings and NEVER from the request. The body is not read
       * at all, which is the point: there is no input for a caller to steer, so this cannot
       * be turned into "open anything on this machine" even by something holding the token.
       * The guards listed on /api/choose-folder apply here in full.
       */
      if (req.method === 'POST' && url.pathname === '/api/open-folder') {
        const config = await loadConfig();
        // Re-validated here, not trusted. The stored destination passed checkArchiveDir when
        // it was saved, but a config.json edited by hand — or written by an older build, or
        // by a future bug in this endpoint's neighbour — is not required to have. Without
        // this, "open my photos folder" opens whatever absolute path is in that file: /etc
        // and an application bundle both worked when a checker tried it. The rule is that
        // this endpoint can only ever open a folder the tool would agree to archive into.
        const verdict = checkArchiveDir(config.archiveDir);
        if (!verdict.ok) {
          json(400, { ok: false, error: verdict.error, path: config.archiveDir });
          return;
        }
        const opened = await openFolder(verdict.resolved, options.native);
        json(200, opened.ok ? { ok: true, path: verdict.resolved } : { ok: false, error: scrub(opened.error), path: verdict.resolved });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/children') {
        const session = await loadSession();
        if (!session) {
          json(400, { ok: false, error: 'Not signed in yet.' });
          return;
        }
        const client = new BrightwheelClient({ session: session.session, baseUrl: options.baseUrl });
        const me = await client.me();
        // Always re-read here rather than serving the cache: this is the call the page
        // makes on load, and a child added to the account since should appear.
        children = await client.students(me.id);
        json(200, { ok: true, children, included: includedIds(await loadConfig(), children) });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/sync') {
        if (running) {
          json(409, { ok: false, error: 'Already running.' });
          return;
        }
        // Claimed here, in the same turn as the check above and before the first await.
        // Reading the session file is an await like any other, and two clicks of Start
        // landing either side of it both used to pass a check made while `running` was
        // still false. Two runs then wrote the same archive and the same manifest at once:
        // the second one's save overwrites the first one's record of what it had saved, so
        // photos on disk stop being listed as held and are downloaded again as duplicates.
        running = true;
        let session: Awaited<ReturnType<typeof loadSession>>;
        try {
          session = await loadSession();
        } catch (error) {
          // Nothing was started, so the claim has to come off or the UI is wedged for good.
          running = false;
          throw error;
        }
        if (!session) {
          running = false;
          json(400, { ok: false, error: 'Not signed in yet.' });
          return;
        }
        lastResult = null;
        const controller = new AbortController();

        // Everything that can wait lives inside this function, so that `current` is
        // published in the same synchronous turn as `running`. Reading the config file is
        // an await like any other: a stop() or close() landing in that gap used to find
        // nothing to abort, answer "nothing is running", and let the server be torn down
        // with a run about to start and no manifest saved.
        const done = (async () => {
          try {
            const config = await loadConfig();
            const client = new BrightwheelClient({
              session: session.session,
              baseUrl: options.baseUrl,
              delayMs: config.delayMs,
            });
            // Scrubbed on the way through, exactly as the CLI scrubs the same lines
            // before printing them. These go to /api/state, which the page polls and
            // renders: a warning built from an error somebody else's code wrote is the
            // one place a credential could arrive in a line nobody expected to hold one.
            const result = await sync(client, config, (p) => {
              progress = { ...p, message: scrub(p.message) };
            }, { signal: controller.signal });
            lastResult = { ...result, warnings: result.warnings.map(scrub) };
          } catch (error: unknown) {
            progress = {
              phase: 'error',
              message: scrub(error instanceof Error ? error.message : String(error)),
              saved: progress.saved,
              skipped: progress.skipped,
              failed: progress.failed,
            };
          } finally {
            running = false;
            current = null;
          }
        })();
        current = { controller, done };
        json(202, { ok: true });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/stop') {
        if (!current) {
          json(409, { ok: false, error: 'Nothing is running.' });
          return;
        }
        // Answer at once rather than after the run has wound down: the page is polling
        // and will see the "stopped" phase arrive when the in-flight download is done.
        current.controller.abort();
        json(202, { ok: true });
        return;
      }

      // ---------------------------------------------------------- the daily run
      //
      // Kept apart from /api/state on purpose. The state endpoint answers on every poll
      // while a run is going — 700ms apart — and asking launchd or systemd whether a job
      // exists is a process launch each time. This is asked when the page loads and when
      // the parent changes something, which is when the answer can have changed.

      if (req.method === 'GET' && url.pathname === '/api/schedule') {
        const config = await loadConfig();
        const session = await loadSession();
        const state = await schedule.status();
        json(200, {
          ok: true,
          schedule: state,
          // "Already set up" is a session plus a schedule. Anything less is still setup,
          // and the page must not open on a management view for a tool that has never run.
          manage: Boolean(session) && state.installed,
          proposed: await schedule.describe(state.time ?? config.schedule?.time ?? '19:00'),
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/schedule') {
        const { time } = JSON.parse(await readBody(req)) as { time?: string };
        if (!time || !schedule.parseTimeOfDay(time)) {
          json(400, { ok: false, error: 'Choose a time of day first, as hours and minutes.', field: 'scheduleTime' });
          return;
        }
        try {
          // Through the same queue as every other write to config.json. Installing a
          // schedule is a read-modify-write of that file like any settings change, and the
          // settings save themselves on each control change — so without this, ticking a box
          // while the schedule is being written loses one of the two.
          json(200, { ok: true, schedule: await withConfigLock(() => schedule.install(time)) });
        } catch (error) {
          json(400, { ok: false, error: scrub(error instanceof Error ? error.message : String(error)) });
        }
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/schedule/off') {
        try {
          json(200, { ok: true, schedule: await withConfigLock(() => schedule.remove()) });
        } catch (error) {
          json(400, { ok: false, error: scrub(error instanceof Error ? error.message : String(error)) });
        }
        return;
      }

      // ---------------------------------------------------------- looking after the archive
      //
      // Each of these reads the archive and its manifest. A run is doing the same thing at
      // the same time, and the manifest is one file: letting the two overlap is how a
      // repair writes a list that the run then overwrites, or the other way about. So they
      // wait, and the page says why rather than failing silently.

      if (req.method === 'POST' && url.pathname.startsWith('/api/maintenance/')) {
        if (running) {
          json(409, { ok: false, error: 'Photos are being saved right now. Wait for that to finish, then try again.' });
          return;
        }
        const action = url.pathname.slice('/api/maintenance/'.length);
        const config = await loadConfig();
        try {
          switch (action) {
            case 'children': {
              const session = await loadSession();
              if (!session) {
                json(400, { ok: false, error: 'Connect to your Brightwheel account first.' });
                return;
              }
              const client = new BrightwheelClient({ session: session.session, baseUrl: options.baseUrl });
              const check = await checkChildren(client, config);
              // This call has just read the account, so whatever the cache above holds is
              // the older answer of the two. Dropped rather than patched: it holds full
              // Student records and this one holds names and ids, and a half-updated cache
              // is what a stored selection is checked against when the page saves a tick.
              children = null;
              json(200, { ok: true, result: check });
              return;
            }
            case 'archive':
              json(200, { ok: true, result: await auditArchive(config) });
              return;
            case 'repair':
              json(200, { ok: true, result: await repairManifest(config) });
              return;
            case 'duplicates':
              // Reporting only. Removing is a separate request carrying the list back.
              json(200, { ok: true, result: await findDuplicates(config) });
              return;
            case 'duplicates/remove': {
              const { paths } = JSON.parse(await readBody(req)) as { paths?: unknown };
              if (!Array.isArray(paths) || !paths.every((p) => typeof p === 'string' && p.length > 0)) {
                json(400, { ok: false, error: 'Nothing was named for removal, so nothing was deleted.' });
                return;
              }
              json(200, { ok: true, result: await removeDuplicates(config, { confirm: paths as string[] }) });
              return;
            }
            default:
              json(404, { ok: false, error: 'Not found' });
              return;
          }
        } catch (error) {
          json(400, { ok: false, error: scrub(error instanceof Error ? error.message : String(error)) });
          return;
        }
      }

      if (req.method === 'POST' && url.pathname === '/api/open-folder') {
        const config = await loadConfig();
        try {
          await openFolder(config.archiveDir);
          json(200, { ok: true, archiveDir: config.archiveDir });
        } catch (error) {
          json(400, { ok: false, error: scrub(error instanceof Error ? error.message : String(error)) });
        }
        return;
      }

      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    } catch (error) {
      json(500, { ok: false, error: scrub(error instanceof Error ? error.message : String(error)) });
    }
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  const stop = async (): Promise<void> => {
    if (!current) return;
    current.controller.abort();
    // `done` never rejects: the catch above turns a failure into a progress event.
    await current.done;
  };

  return {
    url: `http://127.0.0.1:${port}/?token=${token}`,
    port,
    token,
    stop,
    close: async () => {
      await stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
