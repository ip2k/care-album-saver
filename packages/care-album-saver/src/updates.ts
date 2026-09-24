import { join } from 'node:path';
import type { Config } from './config.js';
import { BodyTooLargeError, readBodyText } from './http-body.js';
import { configDir, readJsonFile, UnreadableFileError, writeSecureFile } from './paths.js';
import { currentVersion, installKind, type InstallKind, type VersionInfo } from './version.js';

/**
 * Whether a newer release exists, asked of GitHub by the setup page's own server.
 *
 * This is the one request the tool makes to anyone but Brightwheel (and Apple, when the
 * Photos option is on), so its limits are the design:
 *
 *  - Only when the parent has said yes. The dashboard asks once; the answer is
 *    `checkForUpdates` and a switch in Settings afterwards. Until then nothing is sent.
 *  - Only from the setup page, never from the unattended daily run.
 *  - At most once a day, and at most once an hour when GitHub cannot be reached.
 *  - What is sent is a plain GET for this repository's latest release, with no cookie and
 *    no token: GitHub learns the computer's address and that it runs this tool, and nothing
 *    about the account, the children or the archive.
 *  - The server asks, not the browser: the page's CSP stays connect-src 'self'.
 *
 * GitHub Releases rather than npm because it serves every way of installing, including the
 * clone the README describes, and because each release carries its changelog.
 */

const REPOSITORY = 'ip2k/care-album-saver';
export const RELEASES_URL = `https://github.com/${REPOSITORY}/releases`;
export const UPDATING_DOC_URL = `https://github.com/${REPOSITORY}/blob/main/docs/UPDATING.md`;
const LATEST_API = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
/** "Check now" pressed twice in a row asks once. */
const MANUAL_GAP = 60 * 1000;
const MAX_BODY = 1_000_000;
const MAX_NOTES = 20_000;

export interface Release {
  /** Without the tag's "v": "0.2.0". */
  version: string;
  tag: string;
  /** The release's page on GitHub — checked to be exactly that before it is kept. */
  url: string;
  publishedAt: string | null;
  /** The release notes as written, Markdown, shown to the parent as plain text. */
  notes: string;
}

/** What is remembered between checks, in the config folder. */
export interface UpdateState {
  /** The last time GitHub answered. */
  checkedAt: string | null;
  /** The last time a check was tried, answered or not. */
  attemptedAt: string | null;
  /** Null when there is no release yet, or none has been read. */
  latest: Release | null;
  /** Why the last attempt did not get an answer, for Settings to say. */
  error: string | null;
}

export interface UpdateStatus {
  /** Whether the parent has answered the question at all. */
  asked: boolean;
  enabled: boolean;
  current: VersionInfo;
  latest: Release | null;
  /** The latest release is newer than this copy. */
  available: boolean;
  checkedAt: string | null;
  error: string | null;
  install: InstallKind;
}

const EMPTY: UpdateState = { checkedAt: null, attemptedAt: null, latest: null, error: null };
const statePath = (): string => join(configDir(), 'update-check.json');

async function loadUpdateState(): Promise<UpdateState> {
  // A damaged record only means asking GitHub again, so it is read as no record at all.
  const stored = await readJsonFile<Partial<UpdateState>>(statePath()).catch((error: unknown) => {
    if (error instanceof UnreadableFileError) return null;
    throw error;
  });
  return { ...EMPTY, ...(stored ?? {}), latest: parseStoredRelease(stored?.latest) };
}

/**
 * Compare two versions: negative when `a` is older, positive when newer, 0 when the same.
 * major.minor.patch numerically; a pre-release ("0.2.0-beta.1") is older than its release.
 */
export function compareVersions(a: string, b: string): number {
  const split = (v: string): [number[], string] => {
    const [core = '', pre = ''] = v.replace(/^v/, '').split(/-(.*)/s);
    return [core.split('.').map((n) => Number.parseInt(n, 10) || 0), pre];
  };
  const [ca, pa] = split(a);
  const [cb, pb] = split(b);
  for (let i = 0; i < 3; i++) {
    const d = (ca[i] ?? 0) - (cb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  if (pa === pb) return 0;
  if (!pa) return 1;
  if (!pb) return -1;
  return pa < pb ? -1 : 1;
}

const TAG = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

/** GitHub's answer, kept only if every field is what it should be. */
export function parseRelease(body: unknown): Release | null {
  if (!body || typeof body !== 'object') return null;
  const r = body as Record<string, unknown>;
  const tag = typeof r.tag_name === 'string' ? r.tag_name : '';
  const version = TAG.exec(tag)?.[1];
  // The link the page shows is this repository's release page and nothing else — checked
  // on the parsed, normalised address, so `..` segments and credentials cannot slip past.
  let link: URL | null = null;
  try {
    link = new URL(typeof r.html_url === 'string' ? r.html_url : '');
  } catch {
    return null;
  }
  const url = link.href;
  if (!version || !url.startsWith(`${RELEASES_URL}/`) || link.username || link.password || link.search || link.hash) return null;
  if (r.draft === true || r.prerelease === true) return null;
  const notes = typeof r.body === 'string' ? r.body.replace(/\r\n?/g, '\n') : '';
  return {
    version,
    tag,
    url,
    publishedAt: typeof r.published_at === 'string' ? r.published_at : null,
    notes: notes.length > MAX_NOTES ? `${notes.slice(0, MAX_NOTES)}\n…` : notes,
  };
}

/** The same checks on what was stored, since the file can be edited by hand. */
function parseStoredRelease(stored: unknown): Release | null {
  if (!stored || typeof stored !== 'object') return null;
  const r = stored as Partial<Release>;
  return parseRelease({ tag_name: r.tag, html_url: r.url, published_at: r.publishedAt, body: r.notes });
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** The real network, unless the test environment has switched it off. */
const realFetch: Fetch = (url, init) =>
  process.env.CARE_ALBUM_NO_UPDATE_CHECK
    ? Promise.reject(new Error('Refused: CARE_ALBUM_NO_UPDATE_CHECK is set, so GitHub is never asked from here.'))
    : fetch(url, init);

/**
 * Ask GitHub, unless it was asked recently enough. Never throws: a check that fails is
 * remembered as the reason, and the page carries on.
 */
export async function checkForUpdate(
  options: { fetch?: Fetch; now?: Date; force?: boolean } = {},
): Promise<UpdateState> {
  const now = options.now ?? new Date();
  const state = await loadUpdateState();
  const since = (iso: string | null): number => (iso ? now.getTime() - Date.parse(iso) : Infinity);
  if (options.force) {
    if (since(state.attemptedAt) < MANUAL_GAP) return state;
  } else if (since(state.checkedAt) < DAY || since(state.attemptedAt) < HOUR) {
    return state;
  }

  const next: UpdateState = { ...state, attemptedAt: now.toISOString() };
  try {
    const response = await (options.fetch ?? realFetch)(LATEST_API, {
      // No User-Agent of the tool's own: Node's fetch sends "node", which every Node program
      // sends and GitHub accepts, so the request says no more than it has to.
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 404) {
      // The repository has no release yet: an answer, and "up to date" is the truth of it.
      Object.assign(next, { checkedAt: now.toISOString(), latest: null, error: null });
    } else if (!response.ok) {
      next.error = response.status === 403 || response.status === 429
        ? 'GitHub is limiting how often it is asked. It will be asked again later.'
        : `GitHub answered ${response.status}.`;
    } else {
      // Read up to MAX_BODY and no further: the limit used to be checked on the text after
      // all of it had been read, which bounded nothing (security review outbound-7). An
      // answer too long, or not JSON at all, is not a release — said as that, rather than as
      // GitHub being unreachable when it plainly answered.
      const release = await readBodyText(response, MAX_BODY).then(
        (text) => {
          try {
            return parseRelease(JSON.parse(text));
          } catch {
            return null;
          }
        },
        (error: unknown) => {
          if (error instanceof BodyTooLargeError) return null;
          throw error;
        },
      );
      if (!release) {
        next.error = 'GitHub\'s answer was not a release this tool recognises.';
      } else {
        Object.assign(next, { checkedAt: now.toISOString(), latest: release, error: null });
      }
    }
  } catch (error) {
    next.error = error instanceof Error && error.name === 'TimeoutError'
      ? 'GitHub did not answer within ten seconds.'
      : `GitHub could not be reached${error instanceof Error ? `: ${error.message}` : '.'}`;
  }
  await writeSecureFile(statePath(), JSON.stringify(next, null, 2)).catch(() => {});
  return next;
}

/**
 * What the page shows. Asks GitHub only when the parent has said yes and a check is due;
 * otherwise reports what is remembered.
 */
export async function updateStatus(
  config: Config,
  options: { fetch?: Fetch; now?: Date; force?: boolean; version?: VersionInfo; install?: InstallKind } = {},
): Promise<UpdateStatus> {
  const enabled = config.checkForUpdates === true;
  const state = enabled ? await checkForUpdate(options) : await loadUpdateState();
  const current = options.version ?? currentVersion();
  const latest = enabled ? state.latest : null;
  return {
    asked: config.checkForUpdates !== null,
    enabled,
    current,
    latest,
    available: latest !== null && compareVersions(latest.version, current.version) > 0,
    checkedAt: state.checkedAt,
    error: enabled ? state.error : null,
    install: options.install ?? installKind(),
  };
}

/** How to update this copy, for the page to show as it is: words, then commands to type. */
export interface UpdateSteps {
  /** How this copy was installed, in words: "a clone of the repository". */
  installedAs: string;
  /** What to do, before the commands. */
  before: string;
  /** One command per line, in order. Empty when the steps are a link. */
  commands: string[];
  /** What happens next, after the commands. */
  after: string;
}

const RESTART = 'Then stop this page (Ctrl+C in the terminal it was started from) and start it again.';
const DAILY_CARRIES_ON = 'The daily run, if it is set up, uses the new version from its next run: nothing else to change.';

/**
 * A folder written so that the shell the steps are typed into reads it as one word.
 *
 * `cd ~/My Photos Tool` is `cd` with three arguments, so a folder with a space in it — or a
 * quote, a bracket, an ampersand — broke the first command of the update (security review
 * page-4). A folder that needs nothing is left as it is, so the usual case reads as before.
 *
 * On a Mac or Linux it is single-quoted, which the shell takes literally, with a quote inside
 * written as '\''. A leading ~/ stays outside the quotes, where it still means the home
 * folder. On Windows it is double-quoted, the one quoting that cmd and PowerShell both
 * understand; neither allows a double quote in a folder name. A `$` or backtick (PowerShell),
 * a `[` or `]` (PowerShell's cd reads them as a wildcard, and only its -LiteralPath, which
 * cmd does not have, would not) or a `%` (cmd) inside a Windows folder name is not handled:
 * no single spelling serves both shells, and a folder named like that is rare enough to
 * leave to the update guide.
 */
function shellFolder(path: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') return /^[A-Za-z0-9_\-.\\/:~]+$/.test(path) ? path : `"${path}"`;
  const home = /^~(?:\/|$)/.exec(path)?.[0] ?? '';
  const rest = path.slice(home.length);
  if (/^[A-Za-z0-9_\-./+,:@%]*$/.test(rest)) return path;
  return `${home}'${rest.replace(/'/g, `'\\''`)}'`;
}

/**
 * The steps for each way of installing. `root` is where a clone or download lives and
 * `source` the checkout a production copy is deployed from, both written the way a person
 * reads them (~/…). `platform` says which shell the commands are for, and so how a folder
 * in them is quoted: this computer's, unless a test says otherwise.
 */
export function updateSteps(
  kind: InstallKind,
  where: { root?: string | null; source?: string | null; platform?: NodeJS.Platform } = {},
): UpdateSteps {
  const platform = where.platform ?? process.platform;
  // The words used when the folder is not known are a placeholder for the person to replace,
  // not a folder, so they are never quoted.
  const root = where.root ?? 'the folder it is in';
  const cdRoot = `cd ${where.root ? shellFolder(where.root, platform) : root}`;
  const global = (installedAs: string, command: string): UpdateSteps => ({
    installedAs,
    before: 'In a terminal:',
    commands: [command],
    after: `${RESTART} ${DAILY_CARRIES_ON}`,
  });
  const cached = (installedAs: string, command: string): UpdateSteps => ({
    installedAs,
    before: `${installedAs[0]!.toUpperCase()}${installedAs.slice(1)} keeps using the version it downloaded first until it is asked for the newest one. Stop this page and start it again with:`,
    commands: [command],
    after: 'That downloads the new version and opens its setup page.',
  });
  switch (kind) {
    case 'production':
      return {
        installedAs: 'the production copy that scripts/deploy.js keeps',
        before: 'Bring the checkout it is deployed from up to date, then deploy again:',
        commands: [
          `cd ${where.source ? shellFolder(where.source, platform) : 'your development checkout'}`,
          'git switch main',
          'git pull',
          'node scripts/deploy.js',
        ],
        after:
          'deploy.js builds and tests the new version, moves the daily run onto it, and puts ' +
          `production back as it was if anything fails. ${RESTART}`,
      };
    case 'git':
      return {
        installedAs: 'a clone of the repository',
        before: 'In a terminal:',
        commands: [cdRoot, 'git pull', 'pnpm install', 'pnpm build'],
        after: `${RESTART} ${DAILY_CARRIES_ON} If git says you have changes of your own, git stash puts them aside first.`,
      };
    case 'download':
      return {
        installedAs: 'a downloaded copy, without git',
        before:
          'Download the new version’s source code (the .zip on its release page), and put its contents ' +
          `in place of this folder’s, ${root}. Your photos, settings and session are kept elsewhere and ` +
          'are not touched. Then, in that folder:',
        commands: [cdRoot, 'pnpm install', 'pnpm build'],
        after: `${RESTART} Keep the folder where it is, and the daily run carries on with the new version.`,
      };
    case 'docker':
      return {
        installedAs: 'a Docker container',
        before: 'In the clone you built the image from:',
        commands: ['git pull', 'docker build -t care-album-saver .'],
        after:
          'The next docker run uses the new image. Your session and photos are in the folders you ' +
          'mount, so nothing else changes.',
      };
    case 'npm-global':
      return global('npm, installed globally', 'npm install -g care-album-saver@latest');
    case 'pnpm-global':
      return global('pnpm, installed globally', 'pnpm add -g care-album-saver@latest');
    case 'yarn-global':
      return global('Yarn, installed globally', 'yarn global add care-album-saver@latest');
    case 'bun-global':
      return global('Bun, installed globally', 'bun add -g care-album-saver@latest');
    case 'npm-local':
      return {
        installedAs: 'a package inside another project',
        before: 'In the project it is installed in:',
        commands: ['npm install care-album-saver@latest'],
        after: RESTART,
      };
    case 'npx':
      return cached('npx', 'npx care-album-saver@latest setup');
    case 'pnpm-dlx':
      return cached('pnpm dlx', 'pnpm dlx care-album-saver@latest setup');
    case 'yarn-dlx':
      return cached('yarn dlx', 'yarn dlx care-album-saver@latest setup');
    case 'bunx':
      return cached('bunx', 'bunx care-album-saver@latest setup');
    default:
      return {
        installedAs: 'a way this copy could not recognise',
        before: 'The update guide has the steps for every way of installing it.',
        commands: [],
        after: '',
      };
  }
}
