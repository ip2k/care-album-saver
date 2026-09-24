import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { isAbsolute, sep } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { BrightwheelClient } from '../api/client.js';
import type { Student } from '../api/schema.js';
import { loadConfig, loadSession, saveConfig, saveSession, SessionUnusableError, type Config } from '../config.js';
import { Secret, scrub } from '../secrets.js';
import { cleanPastedPath, inspectCookiePaste } from '../paste.js';
import { sync, type SyncProgress } from '../sync.js';
import { checkArchiveDir } from '../safety.js';
import { chooseFolder, openFolder, type NativeOptions } from '../native.js';
import { photoAt, summarise } from '../gallery.js';
import { open, type FileHandle } from 'node:fs/promises';
import { archiveBusy, auditArchive, checkChildren, findDuplicates, removeDuplicates, repairManifest } from '../maintenance.js';
import * as schedule from '../schedule.js';
import { addToPhotos, checkPhotosAccess, photosStatus, photosSupported, type PhotosResult } from '../photos.js';
import { PAGE } from './page.js';
import { escapeMarkup } from './cookie-help.js';
import { acceptableUserAgent } from '../api/identity.js';
import { DEVELOPMENT_SCHEDULE_REFUSAL, environment } from '../environment.js';
import { updateStatus, updateSteps } from '../updates.js';
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
 *  2. The Host header is checked against an allowlist, port included. Without this, a hostile
 *     website can point a domain it controls at 127.0.0.1 (DNS rebinding) and then read this
 *     UI's responses from the victim's browser, because to the browser it is same-origin.
 *
 *  3. Cross-site requests are rejected via Sec-Fetch-Site and Origin, whose port must be this
 *     server's too: a page the parent is merely visiting can otherwise POST to
 *     http://127.0.0.1:PORT in the background, and another program's page on another port of
 *     this computer is another site (security review web-10).
 *
 *  4. Every request carries a token generated once per launch and printed by the CLI —
 *     never passed to `open`/`xdg-open`/`start`, because a command line is readable by
 *     every account on the machine, and never set as a cookie. Other local accounts and
 *     other processes on a shared computer cannot reach the UI without it. It travels in
 *     the x-setup-token header, and in the address only where a header cannot be sent: see
 *     `providedToken`.
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

/**
 * Whether a Host header, or the host of an Origin, names this server: one of the two loopback
 * names AND this server's own port. The port used to be dropped before the comparison, so a
 * page served by any other program on this computer — a development server on localhost:3000,
 * say — passed as this one (security review web-10). No port means 80, as it does in a URL.
 */
export function hostAllowed(header: string | undefined, port: number): boolean {
  if (!header) return false;
  const m = /^([^:]+)(?::(\d+))?$/.exec(header);
  return Boolean(m && ALLOWED_HOSTS.has(m[1]!) && Number(m[2] ?? 80) === port);
}

function crossSite(req: IncomingMessage, port: number): boolean {
  const fetchSite = req.headers['sec-fetch-site'];
  if (typeof fetchSite === 'string' && fetchSite !== 'same-origin' && fetchSite !== 'none') return true;
  const origin = req.headers.origin;
  if (typeof origin === 'string') {
    try {
      const from = new URL(origin);
      // This server speaks http only, so an https origin on the same name and port is another one.
      if (from.protocol !== 'http:' || !hostAllowed(from.host, port)) return true;
    } catch {
      return true;
    }
  }
  return false;
}

/**
 * The setup token a request carries, from where it may carry it (docs/DECISIONS.md Q10;
 * security review web-7 and page-8).
 *
 * The x-setup-token header whenever there is one, which is every request the page makes with
 * fetch. The address only where a header cannot be sent: the page itself, opened from the link
 * the terminal printed, and /photo, which an <img> or a <video> asks for, and only for a GET
 * of exactly those two paths. Never anywhere else, /api/* included, where a token in the
 * address would be one more copy of it in history and logs for nothing: such a request is
 * refused as if it carried no token at all.
 */
function providedToken(req: IncomingMessage, url: URL): string {
  const header = req.headers['x-setup-token'];
  if (typeof header === 'string') return header;
  // An allowlist, not a blocklist of /api/: a route added later, outside /api/, must not start
  // taking the token from the address without anyone deciding it should.
  const addressAllowed = req.method === 'GET' && (url.pathname === '/' || url.pathname === '/photo');
  return addressAllowed ? (url.searchParams.get('token') ?? '') : '';
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
  // Nothing in an empty file can be asked for: a suffix range on it used to produce
  // {start: 0, end: -1}, which the read stream rejected after the headers were sent, and the
  // unhandled error took the whole process with it (security review, 2026-09-23).
  if (size === 0) return 'unsatisfiable';
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

/** A request the server will not act on. Its message is fixed text and never quotes the request. */
class BadRequest extends Error {}
const NOT_UNDERSTOOD = 'That request was not understood, so nothing was changed.';

/**
 * A request's JSON body as an object, or BadRequest. Too large, not JSON, or JSON that is
 * not an object (an array, a string, null) all get the same fixed answer, because
 * JSON.parse's own message quotes what it was given — and what /api/session is given is a
 * paste, which must never come back in an error. The outer catch turns BadRequest into a 400.
 */
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readBody(req));
  } catch {
    throw new BadRequest(NOT_UNDERSTOOD);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new BadRequest(NOT_UNDERSTOOD);
  return parsed as Record<string, unknown>;
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
/**
 * The same refusal met while reading who is on the account, which is the first thing the page
 * asks on every load. It used to be a 500 the page ignored, so a parent saw "Connected" beside
 * "Connect first to see your children" and nothing to do about either (security review page-2).
 */
const CHILDREN_REFUSED =
  'Brightwheel no longer accepts the saved session, so the children on the account cannot be shown. ' +
  'Sign in on Brightwheel\u2019s website again, copy the value fresh, and paste it in the box above.';

/**
 * The Content-Security-Policy, for the page when there is a nonce and for everything else
 * when there is not.
 *
 * The page's one script runs because it carries this response's nonce, and nothing else can:
 * no 'unsafe-inline' for scripts, so a string that ever did reach the page as markup could not
 * bring an inline script or an onclick with it, and 'strict-dynamic' because the script loads
 * nothing of its own that a host list would have to name (security review page-3). Every other
 * response has no script-src at all, which default-src 'none' makes "no scripts". Styles stay
 * inline — one stylesheet and a few style attributes — and cannot run anything; img-src keeps
 * a style from fetching anything away from this computer. base-uri 'none', so that an injected
 * <base> cannot move where the page's own addresses point.
 */
function contentSecurityPolicy(nonce?: string): string {
  return [
    "default-src 'none'",
    "img-src 'self' data:",
    // For the photo viewer's <video>: the page's own /photo route, nothing else.
    "media-src 'self'",
    "style-src 'unsafe-inline'",
    ...(nonce ? [`script-src 'nonce-${nonce}' 'strict-dynamic'`] : []),
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
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

/**
 * A run's progress as the page receives it. `reason: 'session'` marks the one failure only a
 * new session can cure, so the page goes back to step 1 on a field rather than by looking for
 * English words in a scrubbed message (security review, the page verifier's needsSetup note).
 */
type PageProgress = SyncProgress & { reason?: 'session' };

export async function startWebUi(options: WebUiOptions = {}): Promise<WebUiHandle> {
  const token = randomBytes(24).toString('base64url');
  let progress: PageProgress = { phase: 'starting', message: 'Ready', saved: 0, skipped: 0, failed: 0 };
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

  /**
   * What is set up now, sent with a refused change so the page repaints from the truth: a
   * change of time the scheduler refused can leave the old run, or none, and the page must
   * not go on showing what it showed before. Null when even that cannot be read.
   */
  const scheduleNow = () => schedule.status(options.schedule).then(shown, () => null);

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
    | { ok: false; error: string; field: string };

  /**
   * The settings the page may change, and the shape each must arrive in. Anything else in a
   * patch is dropped, not stored: whether photos go to Apple, and whether GitHub is asked
   * about updates, have routes of their own that ask first (/api/photos, /api/update); the
   * pause between requests, the schedule record and the walk state are the tool's own.
   * Until 2026-09-23 the patch was spread into config.json whole, so a request could set
   * delayMs to 0 or write a schedule record the scheduler had never seen.
   */
  const PATCHABLE = {
    archiveDir: 'string',
    organiseBy: 'organiseBy',
    tagChildName: 'boolean',
    tagNote: 'boolean',
    stripLocation: 'boolean',
    writeSidecar: 'boolean',
    incremental: 'boolean',
    includeStudents: 'array',
  } as const;
  const ORGANISE_BY: readonly string[] = ['week', 'week-per-child', 'child-then-week'];

  const applyConfigPatch = async (raw: Record<string, unknown>): Promise<PatchResult> => {
    let warning: string | undefined;
    const patch: Partial<Config> = {};
    for (const [key, kind] of Object.entries(PATCHABLE)) {
      if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
      const value = raw[key];
      const accepted =
        kind === 'string' ? typeof value === 'string'
        : kind === 'boolean' ? typeof value === 'boolean'
        : kind === 'array' ? Array.isArray(value)
        : typeof value === 'string' && ORGANISE_BY.includes(value);
      // The key named here is one of the tool's own, never something from the request.
      if (!accepted) return { ok: false, error: `The setting "${key}" did not arrive in a form this tool understands, so nothing was changed.`, field: key };
      (patch as Record<string, unknown>)[key] = value;
    }
    // Never persist a destination without checking it. This endpoint previously
    // accepted any path at all and the tool wrote a child's photos there.
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

  /**
   * How many looks at, or changes to, the archive the Maintenance panel has in progress. A
   * run is refused while there are any, as they are while a run is going (security review
   * web-5): the guard used to be one-way, so a run could start in the middle of a repair or
   * a removal and the two wrote archive.json over each other. Across processes the run lock
   * does the same job (see run-lock.ts); this answers the page's own clicks at once, in words.
   */
  let maintaining = 0;
  const MAINTENANCE_IN_PROGRESS =
    'The archive is being checked or tidied up on the Maintenance page right now. Nothing was started. ' +
    'Wait for that to finish, then try again.';

  // The port this server listens on, set once listen() has bound it, before any request can
  // arrive. Read from here rather than from server.address(), which is null once close() has
  // begun, while a request already on an open connection can still reach the handler.
  let port = 0;

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Nothing here may ever be cached: the pages list children's names and photos.
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    // No script may run in anything but the page, which sets its own below.
    res.setHeader('Content-Security-Policy', contentSecurityPolicy());

    // The gate, in its own try: this handler is async, so anything it throws outside a try is
    // an unhandled rejection, which ends the process.
    let url: URL;
    try {
      if (!hostAllowed(req.headers.host, port)) {
        res.writeHead(403, { 'content-type': 'text/plain' });
        res.end('Blocked: unexpected Host header. This page is only reachable from this computer.');
        return;
      }
      if (crossSite(req, port)) {
        res.writeHead(403, { 'content-type': 'text/plain' }).end('Blocked: cross-site request.');
        return;
      }

      url = new URL(req.url ?? '/', `http://127.0.0.1`);
      if (!tokenMatches(providedToken(req, url), token)) {
        res.writeHead(403, { 'content-type': 'text/html' });
        res.end('<h1>Wrong or missing setup link</h1><p>Use the exact link printed in your terminal.</p>');
        return;
      }
    } catch {
      if (!res.headersSent) res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('Bad request.');
      return;
    }

    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    try {
      if (req.method === 'GET' && url.pathname === '/') {
        // A fresh nonce for every response, in the header and on the page's script tag and
        // nowhere else: a nonce that repeated would be one an attacker could learn and reuse
        // (security review page-3).
        const nonce = randomBytes(18).toString('base64');
        res.setHeader('Content-Security-Policy', contentSecurityPolicy(nonce));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        const banner = options.banner ? `<div class="demo-ribbon" role="note">${escapeMarkup(options.banner)}</div>` : '';
        // Function replacers, so that nothing spliced in is read as a replacement pattern: a
        // "$&" or "$'" in the banner used to copy parts of the page into it.
        res.end(
          PAGE.replace(/__TOKEN__/g, () => token)
            .replace(/__NONCE__/g, () => nonce)
            .replace('<!--__BANNER__-->', () => banner),
        );
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/state') {
        const config = await loadConfig();
        // A damaged session file is shown on step 1 as what it is, not as "not connected"
        // and not as a page that will not load: connecting again is the remedy either way.
        let sessionProblem: string | null = null;
        const session = await loadSession().catch((error: unknown) => {
          if (!(error instanceof SessionUnusableError)) throw error;
          sessionProblem = scrub(error.message);
          return null;
        });
        // What the archive holds, so the page can answer "is this still working?" with the
        // photographs themselves rather than with a green tick that outlives the truth.
        const archive = await summarise(config).catch(() => null);
        const photos = await photosStatus(config, { platform: options.native?.platform }).catch(() => null);
        json(200, {
          archive,
          photos,
          hasSession: Boolean(session),
          sessionProblem,
          // A hand-edited file can hold a date that is not one; toISOString would throw on it.
          sessionSavedAt: session && Number.isFinite(session.savedAt.getTime()) ? session.savedAt.toISOString() : null,
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
        const log = await schedule.readLog(200, options.schedule);
        json(200, { ok: true, ...log, path: tildify(log.path, options.schedule?.home ?? homedir(), options.schedule?.platform) });
        return;
      }

      /** Hand the log to whatever the platform has for reading logs. */
      if (req.method === 'POST' && url.pathname === '/api/open-logs') {
        json(200, { ok: true, ...(await schedule.openLogs(options.schedule)) });
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
       * It is a GET that may carry the token in its address, which no /api/* route accepts
       * (see `providedToken`). That is deliberate: an <img> or a <video> cannot send a
       * header, and without this there would be no pictures on the dashboard and nothing in
       * the viewer. The page's own address carries the token already, the request is
       * same-origin, and the fetch-metadata and Host checks above apply to it exactly as they
       * do to everything else. A request that does send the header is judged by the header.
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
        // The stream's errors are handled and the stream is destroyed when the browser goes
        // away: an unhandled 'error' on a read stream (a file that stats but cannot be opened)
        // is fatal to the process, and a range request the viewer abandons would otherwise
        // keep its file handle open for the life of the server.
        // Opened before any header is written, so a file that cannot be opened is a 500 rather
        // than a 200 with nothing in it.
        let handle: FileHandle;
        try {
          handle = await open(found.path, 'r');
        } catch {
          res.writeHead(500, { 'content-type': 'text/plain' }).end('That photo could not be read.');
          return;
        }
        const stream = handle.createReadStream(range ? { start: range.start, end: range.end } : {});
        stream.on('error', () => {
          if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
          res.end();
        });
        res.on('close', () => stream.destroy());
        if (range) {
          res.writeHead(206, {
            ...headers,
            'content-length': String(range.end - range.start + 1),
            'content-range': `bytes ${range.start}-${range.end}/${found.bytes}`,
          });
        } else {
          res.writeHead(200, { ...headers, 'content-length': String(found.bytes) });
        }
        stream.pipe(res);
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
        const { cookie } = (await readJson(req)) as { cookie?: unknown };
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
        const saved = await applyConfigPatch(await readJson(req));
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
        try {
          const me = await client.me();
          // Always re-read here rather than serving the cache: this is the call the page
          // makes on load, and a child added to the account since should appear.
          children = await client.students(me.id);
        } catch (error) {
          // Brightwheel refusing the session is an answer about the session, not a fault in
          // this tool: a 401 with a flag the page acts on by going back to step 1, and words
          // for a browser rather than the command line's (security review page-2).
          if (error instanceof Error && error.name === 'SessionExpiredError') {
            children = null;
            json(401, { ok: false, sessionRejected: true, error: CHILDREN_REFUSED });
            return;
          }
          throw error;
        }
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
          const body = (await readJson(req)) as { enabled?: unknown; check?: unknown };
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
        const body = (await readJson(req)) as { enabled?: unknown; earlier?: unknown };
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
        if (maintaining > 0) {
          json(409, { ok: false, error: MAINTENANCE_IN_PROGRESS });
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
                ...(sessionRefused ? { reason: 'session' as const } : {}),
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
        const { time, replace } = (await readJson(req)) as { time?: string; replace?: unknown };
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
          // `replace` takes over another copy's daily run once the parent has agreed to it on
          // the page, and never a production copy's: see ScheduleOwnedElsewhereError.
          const install = () => schedule.install(time, options.schedule, { replace: replace === true });
          json(200, { ok: true, schedule: shown(await withConfigLock(install)) });
        } catch (error) {
          if (error instanceof schedule.ScheduleOwnedElsewhereError) {
            json(409, { ok: false, error: scrub(error.message), replaceable: !error.production });
            return;
          }
          json(400, { ok: false, error: scrub(error instanceof Error ? error.message : String(error)), schedule: await scheduleNow() });
        }
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/schedule/off') {
        try {
          json(200, { ok: true, schedule: shown(await withConfigLock(() => schedule.remove(options.schedule))) });
        } catch (error) {
          if (error instanceof schedule.ScheduleOwnedElsewhereError) {
            json(409, { ok: false, error: scrub(error.message), replaceable: false });
            return;
          }
          json(400, { ok: false, error: scrub(error instanceof Error ? error.message : String(error)), schedule: await scheduleNow() });
        }
        return;
      }

      // ---------------------------------------------------------- looking after the archive
      //
      // Each of these reads the archive and its manifest. A run is doing the same thing at
      // the same time, and the manifest is one file: letting the two overlap is how a
      // repair writes a list that the run then overwrites, or the other way about. So they
      // wait, and the page says why rather than failing silently.
      //
      // Both ways round, and across processes (security review web-5 and missed-fs): a run
      // from this page is refused while one of these is in progress (`maintaining`), the
      // repair and the removal hold the run lock a run in any process takes, and the two
      // looks refuse while any process holds it. Each refusal is a 409 with the reason.

      if (req.method === 'POST' && url.pathname.startsWith('/api/maintenance/')) {
        if (running) {
          json(409, { ok: false, error: 'Photos are being saved right now. Wait for that to finish, then try again.' });
          return;
        }
        const action = url.pathname.slice('/api/maintenance/'.length);
        // Asking Brightwheel who is on the account reads the list only for names, and a run
        // beside it changes nothing it reports, so it neither blocks a run nor waits for one.
        const touchesArchive = action !== 'children';
        // Claimed before the first await, as /api/sync claims `running`, so that a Start
        // pressed while the settings are being read is refused rather than let in.
        if (touchesArchive) maintaining += 1;
        try {
          const config = await loadConfig();
          try {
            // Read-only, but while a run in another process (the daily run, say) is writing
            // the list, what they report is half written. The repair and the removal take
            // the lock themselves, in maintenance.ts, so the command line's are covered too.
            const busy = action === 'archive' || action === 'duplicates' ? await archiveBusy(config, 'check') : null;
            if (busy) {
              json(409, { ok: false, error: scrub(busy) });
              return;
            }
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
                const { paths } = (await readJson(req)) as { paths?: unknown };
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
            // A run, or another repair or removal, holds the folder — in this process or
            // another. Not a failure: nothing was changed, and the message says why.
            if (error instanceof Error && error.name === 'RunInProgressError') {
              json(409, { ok: false, error: scrub(error.message) });
              return;
            }
            // The children check meeting a session Brightwheel refuses: in the page's words,
            // as /api/children says it, not the command line's "Run care-album-saver login".
            if (error instanceof Error && error.name === 'SessionExpiredError') {
              children = null;
              json(401, { ok: false, sessionRejected: true, error: CHILDREN_REFUSED });
              return;
            }
            json(400, { ok: false, error: scrub(error instanceof Error ? error.message : String(error)) });
            return;
          }
        } finally {
          if (touchesArchive) maintaining -= 1;
        }
      }

      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    } catch (error) {
      if (error instanceof BadRequest) {
        json(400, { ok: false, error: error.message });
        return;
      }
      json(500, { ok: false, error: scrub(error instanceof Error ? error.message : String(error)) });
    }
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;

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
