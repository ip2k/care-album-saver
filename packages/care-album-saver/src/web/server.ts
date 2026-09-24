import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { isAbsolute, sep } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { BrightwheelClient } from '../api/client.js';
import type { Student } from '../api/schema.js';
import { loadConfig, loadSession, saveConfig, saveSession, type Config } from '../config.js';
import { Secret, scrub } from '../secrets.js';
import { cleanPastedPath, inspectCookiePaste } from '../paste.js';
import { sync, type SyncProgress } from '../sync.js';
import { checkArchiveDir } from '../safety.js';
import { chooseFolder, openFolder, type NativeOptions } from '../native.js';
import { photoAt, summarise } from '../gallery.js';
import { createReadStream } from 'node:fs';
import { auditArchive, checkChildren, findDuplicates, removeDuplicates, repairManifest } from '../maintenance.js';
import * as schedule from '../schedule.js';
import { addToPhotos, checkPhotosAccess, photosStatus, photosSupported, type PhotosResult } from '../photos.js';
import { PAGE } from './page.js';
import { acceptableUserAgent } from '../api/identity.js';
import { DEVELOPMENT_SCHEDULE_REFUSAL, environment } from '../environment.js';
import { UPDATING_DOC_URL, updateStatus, updateSteps } from '../updates.js';
import { productionSource, repositoryRoot, type InstallKind, type VersionInfo } from '../version.js';

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
 *  4. Every request carries a token generated once per launch and printed by the CLI —
 *     never passed to `open`/`xdg-open`/`start`, because a command line is readable by
 *     every account on the machine, and never set as a cookie. Other local accounts and
 *     other processes on a shared computer cannot reach the UI without it.
 *
 * Several of the routes below make a process start on the parent's machine, which is a
 * step up from reading and writing this tool's own files:
 *
 *  - /api/choose-folder and /api/open-folder: the folder chooser and the file manager
 *    (src/native.ts).
 *  - /api/open-logs: whatever the platform has for reading logs — Console, Task Scheduler
 *    or xdg-open.
 *  - POST /api/photos, when it turns adding to Photos on: osascript, to ask the Mac for
 *    permission.
 *  - POST /api/sync: ExifTool, when it is installed, and osascript when adding to Photos
 *    is on.
 *  - The three /api/schedule routes: launchctl, systemctl, schtasks or crontab, to ask
 *    about the daily run, register it or remove it.
 *
 * Every one of them is guarded by all four of the controls above. The two folder routes,
 * which name a place on disk, have two more of their own; the reasoning is written out at
 * the routes themselves.
 */

const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost']);

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

/**
 * The one byte range a Range header asks for, clamped to the file; null to send the whole
 * file; 'unsatisfiable' when it starts past the end. Only the single-range forms a <video>
 * sends — "bytes=0-", "bytes=500-999", "bytes=-500" — are understood: a multi-range request
 * or anything malformed is answered with the whole file, which RFC 9110 allows.
 */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | 'unsatisfiable' {
  const m = /^bytes=(\d*)-(\d*)$/.exec((header ?? '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') {
    // The last N bytes.
    const suffix = Number(m[2]);
    if (suffix === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size) return 'unsatisfiable';
  if (end < start) return null;
  return { start, end };
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
  /**
   * How the operating system's folder chooser and file manager are launched. The suite
   * passes a stand-in, because no test can click a real dialog and none should open windows
   * on the machine running it. Nothing in the product passes anything here.
   */
  native?: NativeOptions;
  /**
   * How the daily run is registered with the operating system's scheduler. The demo passes
   * a stand-in, because a demo that pressed "Stop the daily run" would otherwise remove the
   * real one from the machine it runs on. Nothing in the product passes anything here.
   */
  schedule?: schedule.ScheduleEnvironment;
  /** A line shown across the top of the page: the demo's label, and the warning a development copy shows when it is using real settings (cli.ts, setup). */
  banner?: string;
  /**
   * How GitHub is asked about new releases, and what this copy says it is. The demo passes a
   * pretend release and the suite passes stand-ins, so that neither ever asks GitHub. Nothing
   * in the product passes anything here.
   */
  updates?: {
    fetch?: (url: string, init: RequestInit) => Promise<Response>;
    version?: VersionInfo;
    install?: InstallKind;
    /** Where the copy lives. */
    root?: string;
  };
}

/**
 * A path under a home folder, written the way a person reads it: `~/Library/LaunchAgents/…`.
 * Shorter, the same on every Mac, and it keeps the account name out of screenshots and
 * support messages; Finder's Go to Folder and every shell accept it as written. Left alone
 * on Windows, whose Explorer does not, and for anything outside the home folder.
 */
function tildify(path: string | null, home: string, platform: NodeJS.Platform = process.platform): string | null {
  if (!path || platform === 'win32' || !home) return path;
  return path === home ? '~' : path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

/**
 * What the page says when Brightwheel refuses a session. The error's own message is written
 * for the command line ("Run `care-album-saver login`"), which means nothing in a browser, and
 * it says "expired" when the page cannot know that: a value from the wrong row, or copied with
 * part of it missing, is refused in exactly the same way.
 */
const PASTE_REFUSED =
  'Brightwheel did not accept that value. If you copied it a while ago it may have run out: sign in on ' +
  'Brightwheel\u2019s website again and copy it fresh. Otherwise check it came from the row named ' +
  '_brightwheel_v2, from its Value column, and that all of it was copied.';
const RUN_REFUSED = 'Brightwheel no longer accepts the saved session, so nothing more could be fetched.';

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

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

  /** The scheduler's answer, with its path as a parent reads it. See `tildify`. */
  const shown = <T extends { location: string | null }>(answer: T): T => ({
    ...answer,
    location: tildify(answer.location, options.schedule?.home ?? homedir(), options.schedule?.platform),
  });

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
    const known = await readChildren(new BrightwheelClient({ session: session.session, baseUrl: options.baseUrl, userAgent: session.userAgent }));
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
    // Whether photos go to Apple — and from when — is decided by /api/photos, which asks
    // the Mac for permission first. A settings patch cannot reach round that.
    delete patch.addToPhotos;
    delete patch.addToPhotosFrom;
    // Likewise whether GitHub is asked about updates: /api/update, which is the parent's answer.
    delete patch.checkForUpdates;
    if (typeof patch.archiveDir === 'string') {
      patch.archiveDir = cleanPastedPath(patch.archiveDir);
      // Full paths only, from the page. A relative one would be resolved against wherever the
      // tool was started — a source checkout, for a parent who cloned it — which nobody at
      // the page can see. The command line's --dir keeps its usual meaning, relative to the
      // terminal it was typed in, so this is here and not in checkArchiveDir.
      if (patch.archiveDir && !/^~(?:[/\\]|$)/.test(patch.archiveDir) && !isAbsolute(patch.archiveDir)) {
        return {
          ok: false,
          error: 'Please give the full path to the folder, starting from the top of your drive, or starting with ~/ for your home folder.',
          field: 'archiveDir',
        };
      }
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
      // media-src is for the photo viewer's <video>: the page's own /photo route, nothing else.
      "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'",
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
        const banner = options.banner ? `<div class="demo-ribbon" role="note">${escapeHtml(options.banner)}</div>` : '';
        res.end(PAGE.replace(/__TOKEN__/g, token).replace('<!--__BANNER__-->', banner));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/state') {
        const config = await loadConfig();
        const session = await loadSession();
        // What the archive holds, so the page can answer "is this still working?" with the
        // photographs themselves rather than with a green tick that outlives the truth.
        const archive = await summarise(config).catch(() => null);
        const photos = await photosStatus(config, { platform: options.native?.platform }).catch(() => null);
        json(200, {
          archive,
          photos,
          hasSession: Boolean(session),
          sessionFingerprint: session?.session.fingerprint() ?? null,
          sessionSavedAt: session?.savedAt.toISOString() ?? null,
          email: session?.email ?? null,
          config,
          // The folder as a parent reads it, from their home folder. See tildify.
          archiveDirShown: tildify(config.archiveDir, homedir()),
          progress,
          running,
          lastResult,
        });
        return;
      }

      /**
       * The tail of the daily log, and where it lives.
       *
       * Read-only, scrubbed on the way out like every other line this server shows, and
       * bounded by lines so an enormous one cannot make it read a disk into memory.
       */
      if (req.method === 'GET' && url.pathname === '/api/logs') {
        const log = await schedule.readLog(200);
        json(200, { ok: true, ...log, path: tildify(log.path, homedir()) });
        return;
      }

      /** Hand the log to whatever the platform has for reading logs. */
      if (req.method === 'POST' && url.pathname === '/api/open-logs') {
        json(200, { ok: true, ...(await schedule.openLogs()) });
        return;
      }

      /**
       * One photo out of the archive, for the gallery.
       *
       * The browser never names a file. It names an INDEX into the manifest, and an index
       * can only ever resolve to something this tool wrote inside the archive folder — so
       * there is no path to traverse with and no traversal to defend against. `photoAt`
       * re-checks that the resolved file is still under the archive root anyway, for the
       * case of a manifest edited by hand.
       *
       * It is a GET carrying the token in the query string, which the /api/* routes avoid.
       * That is deliberate and it is the one exception: an <img> tag cannot send a header,
       * and the alternative to this exception is a dashboard with no pictures on it. The
       * request is same-origin, the page's own address already carries the token, and the
       * fetch-metadata and Host checks above apply to it exactly as they do to everything.
       */
      if (req.method === 'GET' && url.pathname === '/photo') {
        const found = await photoAt(await loadConfig(), url.searchParams.get('i'));
        if (!found) {
          res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
          return;
        }
        const headers = {
          'content-type': found.type,
          // A child's photograph must not sit in a browser cache after the tool is closed.
          'cache-control': 'no-store, no-cache, must-revalidate, private',
          'accept-ranges': 'bytes',
        };
        // A part of the file, when the browser asks for one. The photo viewer plays videos
        // in the page, and a <video> asks for byte ranges to seek — Safari will not play one
        // at all from a server that cannot answer them. One range only; anything else gets
        // the whole file, which is always a correct answer to a Range request.
        const range = parseRange(req.headers.range, found.bytes);
        if (range === 'unsatisfiable') {
          res.writeHead(416, { ...headers, 'content-range': `bytes */${found.bytes}` }).end();
          return;
        }
        if (range) {
          res.writeHead(206, {
            ...headers,
            'content-length': String(range.end - range.start + 1),
            'content-range': `bytes ${range.start}-${range.end}/${found.bytes}`,
          });
          createReadStream(found.path, { start: range.start, end: range.end }).pipe(res);
          return;
        }
        res.writeHead(200, { ...headers, 'content-length': String(found.bytes) });
        createReadStream(found.path).pipe(res);
        return;
      }

      // Another page of the most recent run's photographs. The first page comes with
      // /api/state; this is the rest, asked for when somebody pages through the dashboard or
      // steps past the end of a page in the photo viewer.
      if (req.method === 'GET' && url.pathname === '/api/gallery') {
        const page = Number(url.searchParams.get('page') ?? 0);
        const summary = await summarise(await loadConfig(), { page });
        json(200, {
          recent: summary.recent,
          page: summary.page,
          pages: summary.pages,
          lastRunCount: summary.lastRunCount,
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
        // The browser this page is open in is, nearly always, the one the session was just
        // copied out of. Its identity is kept with the session and sent with every request
        // from now on, starting with this check — see api/identity.ts.
        const userAgent = acceptableUserAgent(req.headers['user-agent']);
        const client = new BrightwheelClient({ session: secret, baseUrl: options.baseUrl, userAgent });
        const check = await client.verifySession();
        if (!check.ok) {
          json(400, { ok: false, error: check.rejected ? PASTE_REFUSED : scrub(check.reason) });
          return;
        }
        await saveSession(secret, check.email, userAgent);
        // A different account has different children.
        children = null;
        // And a fresh session ends a run that failed for want of one. Left in place, the old
        // "no longer accepts the saved session" line kept the page in setup — and on every
        // reload — until a run happened to succeed.
        if (!running) {
          progress = { phase: 'starting', message: 'Ready', saved: 0, skipped: 0, failed: 0 };
          lastResult = null;
        }
        json(200, { ok: true });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/config') {
        const patch = JSON.parse(await readBody(req)) as Partial<Config>;
        const saved = await applyConfigPatch(patch);
        if (!saved.ok) {
          json(400, { ok: false, error: saved.error, field: saved.field });
          return;
        }
        json(200, { ok: true, config: saved.config, warning: saved.warning, archiveDirShown: tildify(saved.config.archiveDir, homedir()) });
        return;
      }

      /**
       * Open the operating system's folder chooser and store what comes back.
       *
       * This endpoint makes a process start, so: what stops a website the
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
        json(200, { ok: true, config: saved.config, warning: saved.warning, archiveDirShown: tildify(saved.config.archiveDir, homedir()) });
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
          json(400, { ok: false, error: verdict.error });
          return;
        }
        const opened = await openFolder(verdict.resolved, options.native);
        json(200, opened.ok ? { ok: true, path: verdict.resolved } : { ok: false, error: scrub(opened.error) });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/children') {
        const session = await loadSession();
        if (!session) {
          json(400, { ok: false, error: 'Not signed in yet.' });
          return;
        }
        const client = new BrightwheelClient({ session: session.session, baseUrl: options.baseUrl, userAgent: session.userAgent });
        const me = await client.me();
        // Always re-read here rather than serving the cache: this is the call the page
        // makes on load, and a child added to the account since should appear.
        children = await client.students(me.id);
        json(200, { ok: true, children, included: includedIds(await loadConfig(), children) });
        return;
      }

      // Whether a newer release exists (src/updates.ts). GET reports, and asks GitHub only when
      // the parent has said yes and a check is due. POST is the parent's answer to the
      // dashboard's question or the switch in Settings ({ enabled }), or "Check now" ({ check }).
      if (url.pathname === '/api/update' && (req.method === 'GET' || req.method === 'POST')) {
        let force = false;
        let config = await loadConfig();
        if (req.method === 'POST') {
          const body = JSON.parse(await readBody(req)) as { enabled?: unknown; check?: unknown };
          if (typeof body.enabled === 'boolean') {
            const enabled = body.enabled;
            config = await withConfigLock(async () => {
              const current = await loadConfig();
              current.checkForUpdates = enabled;
              await saveConfig(current);
              return current;
            });
            // Saying yes is also the first check, so the answer shows at once.
            force = enabled;
          } else if (body.check === true) {
            if (config.checkForUpdates !== true) {
              json(409, { ok: false, error: 'Checking for new versions is switched off. Switch it on first.' });
              return;
            }
            force = true;
          } else {
            json(400, { ok: false, error: 'Expected { enabled: true | false } or { check: true }.' });
            return;
          }
        }
        const u = options.updates ?? {};
        const status = await updateStatus(config, { fetch: u.fetch, version: u.version, install: u.install, force });
        json(200, {
          ok: true,
          ...status,
          // The steps for the way this copy was installed, with its folders written the way a
          // person reads them.
          how: updateSteps(status.install, {
            root: tildify(u.root ?? repositoryRoot().replace(/[\\/]$/, ''), homedir()),
            source: tildify(productionSource(), homedir()),
          }),
          updatingDocUrl: UPDATING_DOC_URL,
        });
        return;
      }

      /**
       * Adding to Apple Photos: on, off, and "the earlier ones too".
       *
       * Its own route rather than a field in /api/config, because turning it on is not a
       * setting being stored. It is the one choice that can send a child's photos off this
       * computer (to the parent's iCloud, when iCloud Photos is on), so it does two things
       * a tick box elsewhere does not: it asks the Mac for permission while the parent is
       * looking, and it decides from when — the server's clock, not the page's — so that
       * turning it on never pours the whole archive into Photos unasked.
       */
      if (req.method === 'POST' && url.pathname === '/api/photos') {
        const body = JSON.parse(await readBody(req)) as { enabled?: unknown; earlier?: unknown };
        const photoOptions = { platform: options.native?.platform, spawn: options.native?.spawn };
        if (!photosSupported(photoOptions.platform)) {
          json(400, { ok: false, error: 'Adding to Photos is only possible on a Mac.' });
          return;
        }
        if (body.enabled === true) {
          const access = await checkPhotosAccess(photoOptions);
          if (!access.ok) {
            json(400, { ok: false, error: scrub(access.error) });
            return;
          }
        }
        const config = await withConfigLock(async () => {
          const current = await loadConfig();
          if (body.enabled === true) {
            current.addToPhotos = true;
            current.addToPhotosFrom = new Date().toISOString();
          } else if (body.enabled === false) {
            current.addToPhotos = false;
          } else if (body.earlier === true && current.addToPhotos) {
            current.addToPhotosFrom = null;
          }
          await saveConfig(current);
          return current;
        });
        json(200, { ok: true, photos: await photosStatus(config, photoOptions) });
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
          let config: Config | null = null;
          let result: Awaited<ReturnType<typeof sync>> | null = null;
          // Another run held the archive folder, so this one did nothing at all.
          let refused = false;
          try {
            config = await loadConfig();
            const client = new BrightwheelClient({
              session: session.session,
              userAgent: session.userAgent,
              baseUrl: options.baseUrl,
              delayMs: config.delayMs,
            });
            // Scrubbed on the way through, exactly as the CLI scrubs the same lines
            // before printing them. These go to /api/state, which the page polls and
            // renders: a warning built from an error somebody else's code wrote is the
            // one place a credential could arrive in a line nobody expected to hold one.
            result = await sync(client, config, (p) => {
              progress = { ...p, message: scrub(p.message) };
            }, { signal: controller.signal });
          } catch (error: unknown) {
            if (error instanceof Error && error.name === 'RunInProgressError') {
              // Not an error: the daily run (or another page) is saving into this folder,
              // and it will finish the job. Said plainly, as the end of this run.
              refused = true;
              progress = { phase: 'stopped', message: error.message, saved: 0, skipped: 0, failed: 0 };
            } else {
              const sessionRefused = error instanceof Error && error.name === 'SessionExpiredError';
              progress = {
                phase: 'error',
                message: sessionRefused ? RUN_REFUSED : scrub(error instanceof Error ? error.message : String(error)),
                saved: progress.saved,
                skipped: progress.skipped,
                failed: progress.failed,
              };
              await schedule
                .recordRun({ at: new Date().toISOString(), ok: false, saved: 0, failed: 0, message: progress.message, trigger: 'manual' })
                .catch(() => {});
            }
          }
          // A run from the page counts as the day's: without this the daily run's missed-run
          // catch-up (RunAtLoad) saw no run at all and started a full one at once.
          if (result) await schedule.recordRun(schedule.finishedRun(result, 'manual')).catch(() => {});
          try {
            // Then Photos, when the parent has turned it on — even after a run that failed
            // part-way, because what it saved before failing is on disk and just as new.
            // Not after a Stop, which means stop. The run's own last line is put back
            // afterwards; a failed run's error is never replaced by a Photos message.
            let photos: PhotosResult | null = null;
            if (config?.addToPhotos && !controller.signal.aborted && !refused) {
              const finished = progress;
              photos = await addToPhotos(config, {
                platform: options.native?.platform,
                spawn: options.native?.spawn,
                signal: controller.signal,
                onProgress: (message) => {
                  if (result) progress = { ...finished, phase: 'photos', message };
                },
              }).catch((error: unknown) => ({
                // Nothing awaits this promise with a catch of its own, so a throw here would
                // be an unhandled rejection — which ends the whole process, page and all.
                ok: false,
                added: 0,
                remaining: 0,
                missing: 0,
                reason: 'failed' as const,
                error: error instanceof Error ? error.message : String(error),
              }));
              progress = finished;
              if (photos.error) photos.error = scrub(photos.error);
            }
            if (result) lastResult = { ...result, warnings: result.warnings.map(scrub), photos };
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
        const state = await schedule.status(options.schedule);
        json(200, {
          ok: true,
          schedule: shown(state),
          proposed: shown(await schedule.describe(state.time ?? config.schedule?.time ?? '19:00', options.schedule)),
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/schedule') {
        const { time } = JSON.parse(await readBody(req)) as { time?: string };
        if (!time || !schedule.parseTimeOfDay(time)) {
          json(400, { ok: false, error: 'Choose a time of day first, as hours and minutes.', field: 'scheduleTime' });
          return;
        }
        // The real scheduler only (a demo or a test passes its own), and never from a
        // development copy: see environment.ts.
        if (!options.schedule && environment() === 'development') {
          json(400, { ok: false, error: DEVELOPMENT_SCHEDULE_REFUSAL, field: 'scheduleTime' });
          return;
        }
        try {
          // Through the same queue as every other write to config.json. Installing a
          // schedule is a read-modify-write of that file like any settings change, and the
          // settings save themselves on each control change — so without this, ticking a box
          // while the schedule is being written loses one of the two.
          json(200, { ok: true, schedule: shown(await withConfigLock(() => schedule.install(time, options.schedule))) });
        } catch (error) {
          json(400, { ok: false, error: scrub(error instanceof Error ? error.message : String(error)) });
        }
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/schedule/off') {
        try {
          json(200, { ok: true, schedule: shown(await withConfigLock(() => schedule.remove(options.schedule))) });
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
              const client = new BrightwheelClient({ session: session.session, baseUrl: options.baseUrl, userAgent: session.userAgent });
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
