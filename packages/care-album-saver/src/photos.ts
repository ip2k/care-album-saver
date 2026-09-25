import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { copyFile, mkdir, mkdtemp, open, readdir, realpath, rm, utimes, type FileHandle } from 'node:fs/promises';
import { platform as osPlatform } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from './config.js';
import { hashFile, type ManifestRecord } from './ferry/index.js';
import { records } from './gallery.js';
import { OSASCRIPT, runProgram, type SpawnCommand } from './native.js';
import { containedFile } from './contain.js';
import { configDir, readJsonFile, UnreadableFileError, writeSecureFile } from './paths.js';
import { checkArchiveDir } from './safety.js';
import { savedFingerprints } from './fingerprints.js';
import { RunLockUnusableError, setAsideIfUnchanged, sightLock, touchedWithin, writeLockOrRemove } from './run-lock.js';

/**
 * Adding saved photos to Apple Photos.app, on a Mac, when the parent has asked for it: every
 * photo and video saved so far, for every child, and each run's new ones after that, once each.
 *
 * WHY THIS IS OFF UNLESS TURNED ON. Everywhere else this tool can promise that nothing
 * leaves the computer. A Photos library with iCloud Photos switched on uploads whatever is
 * added to it, so this is the one setting that breaks that promise — on the parent's say-so,
 * to the parent's own iCloud account, and never by default.
 *
 * HOW IT TALKS TO APPLE PHOTOS.APP. Through one AppleScript file, `applescript/add-to-photos.applescript`,
 * which holds everything this tool ever asks Photos to do, so that a parent — or anyone
 * reviewing the project — can read the whole of it in one place. It is run as
 *
 *     osascript add-to-photos.applescript Brightwheel Robin-Maple 2026-W38 -- FILE FILE ...
 *
 * with an argument array, never a shell, and nothing is ever pasted into the script's text:
 * osascript hands every argument after the file to the script as data (`--` and `-e`
 * included, which was checked rather than assumed). That is the same rule native.ts keeps
 * for the folder chooser, reached a different way — the chooser needs no input at all, and
 * this needs a list of files, so the files go in as arguments instead of as source. The
 * osascript is /usr/bin/osascript, never whatever PATH finds first, and the script itself
 * stops unless the Photos it would talk to is Apple's own, in /System/Applications.
 *
 * WHAT APPLE PHOTOS.APP IS GIVEN. Private copies, never the files in the photos folder, and
 * only copies whose SHA-256 is one this tool recorded when it saved the file, in a record kept
 * outside that folder. Anything else that can write the folder can make a photo be left out,
 * and nothing more. See `addToPhotos` and fingerprints.ts. The copies are deleted once it has
 * them, so it must keep a copy of its own: its "Copy items to the Photos library" setting has
 * to be on. With it off it keeps only a reference, to a file about to be deleted, and the
 * photo never opens and never reaches iCloud. Nothing here can read that setting (it is a
 * private preference inside Apple Photos.app's sandbox), so the setup page asks the parent to
 * confirm it every time the option is turned on; docs/DECISIONS.md C8.
 *
 * WHAT COMES BACK. One number per batch, how many items the import said it took
 * (`importedCount`), and on failure the last line of osascript's error. Nothing is read from
 * the library: no names, no paths, no ids.
 *
 * WHERE THEY GO. Into a folder named after the source, then folders and an album that repeat
 * the folders on disk: `child-then-week` gives Brightwheel › Robin-Maple › 2026-W38, and
 * `week` gives Brightwheel › 2026-W38. Whatever the parent chose for the archive, Photos
 * gets the same shape.
 *
 * WHY THIS KEEPS ITS OWN LIST. Photos' own duplicate check stops at every duplicate and
 * waits for somebody to click, which nobody is there to do at seven in the evening — so the
 * script turns it off, and this module guarantees instead that no file is handed over twice.
 * The list is keyed by each file's SHA-256 from the manifest, so a file moved by a change of
 * folder layout is still recognised. (Two posts of one picture are two files by then, each
 * tagged with its own date and note, so each goes in; and a batch Apple Photos.app took but
 * that was not written down — it stopped answering, or the process was killed — is handed
 * over again.)
 */

/** The top-level folder in Photos. Named after the source, so a second source gets its own. */
export const PHOTOS_FOLDER = 'Brightwheel';

/** The one script. Resolved from dist/photos.js to the package's applescript/ folder. */
export const PHOTOS_SCRIPT = fileURLToPath(new URL('../applescript/add-to-photos.applescript', import.meta.url));

/** The same file, for a parent to read before turning this on. */
export const PHOTOS_SCRIPT_URL =
  'https://github.com/ip2k/care-album-saver/blob/main/packages/care-album-saver/applescript/add-to-photos.applescript';

/** The explanation for parents, linked from the FAQ. */
export const PHOTOS_DOC_URL = 'https://github.com/ip2k/care-album-saver/blob/main/docs/PHOTOS.md';

/** Files per call. Small enough that one failure costs little, large enough to be quick. */
const BATCH = 50;

/**
 * How long the access check may wait. It is what makes macOS ask "allow this to control
 * Photos?", and the parent needs time to read that and answer it.
 */
const CHECK_TIMEOUT_MS = 3 * 60 * 1000;

/** A minute past the script's own `with timeout of 1800 seconds`, so the script speaks first. */
const IMPORT_TIMEOUT_MS = 31 * 60 * 1000;

/**
 * A lock not touched for this long belongs to a run that died. Every batch touches it, and
 * no batch can outlive IMPORT_TIMEOUT_MS, so a live run never looks this stale.
 */
const STALE_LOCK_MS = 45 * 60 * 1000;

export interface PhotosOptions {
  /** Judge by another operating system's rules. Test-only. */
  platform?: NodeJS.Platform;
  /** Stand in for the real `execFile`. Test-only; no test may drive the real Photos. */
  spawn?: SpawnCommand;
  /** Told how far along it is, in a sentence for a parent. */
  onProgress?: (message: string) => void;
  /** Stop between batches. The batch Photos is working on is finished, never cut off. */
  signal?: AbortSignal;
  /**
   * Asked before each batch: whether the option is still on. The run's step and the daily run
   * pass one that reads the settings again, so that unticking the box stops them between
   * batches as it stops an import started on its own (whose signal the page aborts).
   */
  stillOn?: () => Promise<boolean>;
}

/** How the last attempt went, kept so the page can say so days later. */
export interface PhotosAttempt {
  at: string;
  ok: boolean;
  /** How many Photos said it imported, in this attempt. See `importedCount`. */
  added: number;
  /** Handed over in this attempt beyond the count Photos gave back. Absent when none. */
  unconfirmed?: number;
  /** For a parent to read. Absent when it worked. */
  error?: string;
}

interface PhotosState {
  /** SHA-256 of each file handed to Photos, and when. */
  added: Record<string, string>;
  lastAttempt?: PhotosAttempt | null;
}

/** `changed`: Photos was fine, but some files were not the ones this tool saved. See `addToPhotos`. */
export type PhotosFailure = 'unsupported' | 'denied' | 'timeout' | 'busy' | 'failed' | 'changed';

export interface PhotosResult {
  ok: boolean;
  /** How many Photos said it imported: the sum of the counts the script printed. */
  added: number;
  /**
   * Handed to Photos, but more than the count it gave back for their batch: Photos took
   * fewer than it was given, or did not say. Photos does not say which ones, so they are
   * written down as handed over with the rest and not offered again (offering them again
   * would add a second copy of each one it did take). Absent when none.
   */
  unconfirmed?: number;
  /** Still waiting after this attempt: the ones a failure, a stop or turning it off left behind. */
  remaining: number;
  /** Stopped between batches because the option was turned off while it went. */
  turnedOff?: boolean;
  /** Listed in the manifest but no longer on disk, so not handed over. */
  missing: number;
  /**
   * On disk, but not a file this tool saved, or not as it saved it — its SHA-256 is not in
   * the record kept outside the photos folder (fingerprints.ts) — so not handed over, and
   * not written down as added either. Optional because
   * the callers that stand in a result of their own for a throw have none to count.
   */
  changed?: number;
  reason?: PhotosFailure;
  error?: string;
}

export interface PhotosStatus {
  /** Whether this computer can do it at all. */
  supported: boolean;
  enabled: boolean;
  folder: string;
  /**
   * Saved and not yet handed to Apple Photos.app, each file once: what the next run adds, or,
   * while it is off, what turning it on would add.
   */
  pending: number;
  /**
   * On an install that turned the option on before 2026-09-24: the moment it was turned on,
   * before which nothing is added (see `sortOut`), and how many saved earlier are waiting for
   * the parent to turn it off and on again. Null and 0 everywhere else.
   */
  limitedFrom: string | null;
  earlier: number;
  lastAttempt: PhotosAttempt | null;
  scriptUrl: string;
  /**
   * Why nothing can be added until someone looks: the record of what was added cannot be
   * read. The status still comes back, so the page can say so beside the switch that turns
   * it off, rather than hiding the whole card as if this were not a Mac.
   */
  problem: string | null;
  /**
   * Something the parent should know that does not stop anything: that the photos folder
   * looks cloud-synced, so whatever else can write to it has a say in what reaches Photos.
   * See `cloudWarning`.
   */
  warning: string | null;
}

/**
 * The real `execFile`, unless this process is a test or the screenshot script. Those set
 * CARE_ALBUM_NO_PHOTOS, and a mistake in one of them must not put the mock's pictures into
 * a developer's real Photos library — which, with iCloud Photos on, is a real account.
 */
const realSpawn: SpawnCommand = (file, args, timeoutMs) =>
  process.env.CARE_ALBUM_NO_PHOTOS
    ? Promise.resolve({ code: 1, stdout: '', stderr: 'Refused: CARE_ALBUM_NO_PHOTOS is set, so Photos is never driven from here.' })
    : runProgram(file, args, timeoutMs);

const statePath = (): string => join(configDir(), 'photos.json');

/**
 * Where each batch's private copies are made: in the config folder, which is this account's
 * alone, under a fresh name per batch (mkdtemp makes it owner-only). See `addToPhotos`.
 */
const HANDOVER_PREFIX = 'photos-handover-';
const lockPath = (): string => join(configDir(), 'photos.lock');

export function photosSupported(platform: NodeJS.Platform = osPlatform()): boolean {
  return platform === 'darwin';
}

/**
 * The Photos folders and album for a file, from where it sits in the archive.
 *
 * Every name but the last is a folder and the last is the album, because Photos keeps
 * pictures only in albums and albums only in folders. A file at the archive's top level —
 * which no layout this tool writes produces — goes in an album called "Other" rather than
 * being refused.
 */
export function albumPathFor(recordPath: string): string[] {
  const dirs = recordPath.split('/').slice(0, -1).filter((d) => d !== '' && d !== '.');
  return [PHOTOS_FOLDER, ...(dirs.length > 0 ? dirs : ['Other'])];
}

async function loadState(): Promise<PhotosState> {
  let stored: PhotosState | null;
  try {
    stored = await readJsonFile<PhotosState>(statePath());
  } catch (error) {
    // Read as empty, a damaged record would say nothing had ever been added, and the next
    // run would hand every photo in the archive to Apple Photos.app a second time — and to
    // iCloud with it. So it stops here instead (security review fs-5).
    if (error instanceof UnreadableFileError) {
      throw new Error(
        `The record of what has already been added to Apple Photos.app (${error.path}) cannot be read: ${error.reason}. ` +
          'Nothing was added, so nothing has been added twice. Moving that file somewhere safe starts the ' +
          'record again, which adds every photo in your folder to Apple Photos.app a second time, as duplicates.',
      );
    }
    throw error;
  }
  const added = stored && typeof stored.added === 'object' && stored.added !== null ? stored.added : {};
  return { added, lastAttempt: stored?.lastAttempt ?? null };
}

async function saveState(state: PhotosState): Promise<void> {
  await writeSecureFile(statePath(), JSON.stringify(state, null, 2));
}

interface Waiting {
  record: ManifestRecord;
  file: string;
  album: string[];
}

/**
 * Whether a folder name is one this tool could have written, and so may name an album.
 *
 * Every folder it makes is a child's name through `safeStem` or an ISO week, and neither
 * starts with a dot or holds a control character. A dot-named folder is one the archive's
 * own tools pass over (a killed run's `.saving-` staging folder, or somebody's hidden
 * folder), so what is in it is nobody's photographs. `--` separates names from files in the
 * script's arguments, and a name equal to it would move that boundary; no layout writes one,
 * so that is a lock on a door nobody uses.
 */
function nameThisToolWrites(name: string): boolean {
  return name !== '--' && !name.startsWith('.') && !/[\u0000-\u001f\u007f]/.test(name);
}

/**
 * Which files are due: every one in the archive, for every child and from every run, that
 * has not been handed over already, each file once — both decided by its SHA-256.
 *
 * Except on an install that turned the option on before 2026-09-24, when only what was saved
 * after that moment was due: its `addToPhotosFrom` still limits what goes in, so that an
 * update never sends Apple Photos.app (and iCloud) photos the parent did not agree to. Those
 * are counted as `earlier`, and the page says how to add them: turning the option off and on
 * again removes the date, and turning it on asks about everything.
 */
async function sortOut(config: Config, all: readonly ManifestRecord[], state: PhotosState): Promise<{ due: Waiting[]; earlier: number }> {
  const from = config.addToPhotos && typeof config.addToPhotosFrom === 'string' ? Date.parse(config.addToPhotosFrom) : Number.NEGATIVE_INFINITY;
  const root = resolve(config.archiveDir);
  // The archive where it really is, so that albums can be named from where each file really
  // is. Unresolvable, and containedFile would refuse every entry anyway.
  const realRoot = await realpath(root).catch(() => null);
  if (!realRoot) return { due: [], earlier: 0 };
  const due: Waiting[] = [];
  const seen = new Set<string>();
  let earlier = 0;
  for (const record of all) {
    // gallery.ts's records gives only entries `usableRecord` accepts (security review fs-8),
    // so both are strings here; an entry with no hash names nothing to key the record by.
    if (!record.sha256 || state.added[record.sha256] || seen.has(record.sha256)) continue;
    seen.add(record.sha256);
    // A list edited by anything else that can write the folder could name a file outside
    // the archive, or a link to one. Photos is not asked to import anything this tool did
    // not write, so those are ignored rather than trusted — resolved, not compared as text.
    const file = await containedFile(root, record.path);
    if (!file) continue;
    // The album is named after the folders the file is really in, not after the path the
    // list gives: containedFile lets a path through a link that lands inside the archive, and
    // the list's words for it were chosen by whoever wrote the list (security review
    // processes-5). For every entry this tool wrote, the two are the same.
    const album = albumPathFor(relative(realRoot, file).split(sep).join('/'));
    if (!album.slice(1).every(nameThisToolWrites)) continue;
    if (Date.parse(record.downloadedAt ?? '') < from) {
      earlier += 1;
      continue;
    }
    due.push({ record, file, album });
  }
  return { due, earlier };
}

/**
 * What to say when the photos folder looks cloud-synced (security review processes-5, the
 * question it left open: refuse, or warn).
 *
 * Neither, as a warning. A folder something else can write to is a folder whose contents that
 * something has a say in, and this step hands contents to Photos — and with iCloud Photos on,
 * to Apple. But what it hands over no longer depends on that folder: only bytes whose hash is
 * in the record this tool keeps outside it (fingerprints.ts), copied privately before they
 * are checked. A sync peer can make a photo be left out and reported, and no more. Refusing,
 * on the strength of a guess made from the path alone (`checkArchiveDir` flags Desktop and
 * Documents, where many people keep things), would switch off a setup that works.
 *
 * So it is said once, beside the switch, as what it is: a fact about the folder that the
 * parent may want to know when turning this on, with what this step does about it.
 */
function cloudWarning(config: Config): string | null {
  if (!checkArchiveDir(config.archiveDir).warning) return null;
  return (
    'Your photos folder looks like it may be synced to a cloud service. That does not decide what goes into ' +
    'Apple Photos.app: only photos this tool saved go in, checked against a record kept on this Mac rather than in that ' +
    'folder, and anything changed or added there is left out and reported.'
  );
}

/** What the page shows: whether it is on, and what is waiting. */
export async function photosStatus(config: Config, options: PhotosOptions = {}): Promise<PhotosStatus> {
  const supported = photosSupported(options.platform);
  let state: PhotosState = { added: {}, lastAttempt: null };
  let problem: string | null = null;
  // Only where it can matter: a record left behind on a computer that cannot use it, or
  // with the option off, is nobody's problem until the option is on.
  if (supported) {
    try {
      state = await loadState();
    } catch (error) {
      if (config.addToPhotos) problem = error instanceof Error ? error.message : String(error);
    }
  }
  const { due, earlier } = supported && !problem ? await sortOut(config, await records(config), state) : { due: [], earlier: 0 };
  const enabled = supported && config.addToPhotos;
  return {
    supported,
    enabled,
    folder: PHOTOS_FOLDER,
    pending: due.length,
    limitedFrom: enabled && typeof config.addToPhotosFrom === 'string' ? config.addToPhotosFrom : null,
    earlier,
    lastAttempt: state.lastAttempt ?? null,
    scriptUrl: PHOTOS_SCRIPT_URL,
    problem,
    // Shown whether or not it is on: the moment to know is before turning it on.
    warning: supported ? cloudWarning(config) : null,
  };
}

/** osascript's complaint, without the script's path in front of it. */
function complaint(stderr: string): string {
  const line = stderr.trim().split('\n').pop()?.trim() ?? '';
  return line.replace(/^.*?execution error:\s*/, '');
}

/** Turn what osascript said into a reason and a sentence a parent can act on. */
function explain(code: number, stderr: string): { reason: PhotosFailure; error: string } {
  const said = complaint(stderr);
  if (/\(-1743\)/.test(stderr)) {
    return {
      reason: 'denied',
      error:
        'Your Mac has not allowed Care Album Saver to add photos to Apple Photos.app. Open System Settings › ' +
        'Privacy & Security › Automation, find the program it runs in (Terminal, or node for the ' +
        'daily run) and turn on Photos (Apple Photos.app) under it. Your photos are safe in your folder and will be added next time.',
    };
  }
  if (code === 124 || /\(-1712\)/.test(stderr)) {
    return {
      reason: 'timeout',
      error:
        'Apple Photos.app did not answer in time. Open it yourself once, check it shows your library ' +
        'rather than a welcome screen, and try again. Nothing was lost; they will be added next time.',
    };
  }
  // The script's own refusal: see ONLY APPLE'S PHOTOS in add-to-photos.applescript.
  if (/This is not Apple's Photos app: /.test(stderr)) {
    const where = said.replace(/^.*?This is not Apple's Photos app: /, '').replace(/\s*\(3\)$/, '');
    return {
      reason: 'failed',
      error:
        `Nothing was added to Apple Photos.app: ${where} Care Album Saver hands photos only to Apple Photos.app itself, the one in ` +
        '/System/Applications, and this is not that one. Your photos are safe in your folder.',
    };
  }
  if (/\(-600\)|\(-10810\)|\(-10814\)/.test(stderr)) {
    return { reason: 'failed', error: 'Apple Photos.app could not be opened on this Mac, so nothing was added to it.' };
  }
  return { reason: 'failed', error: `Apple Photos.app did not take them${said ? `: ${said}` : '.'}` };
}

/**
 * How many items Photos says it imported from one batch, from the script's output.
 *
 * The script ends by printing the count of what Photos' `import` command returned, and that
 * number is all that comes back from Photos when it works: no name, no path, nothing from the
 * library (a failure brings back osascript's last line of complaint, see `explain`). It
 * is believed only as a plain count no larger than the batch. Anything else — no output, a
 * word, a larger number — is null, and the batch counts as unconfirmed rather than added.
 */
export function importedCount(stdout: string, handed: number): number | null {
  const text = stdout.trim();
  if (!/^\d{1,6}$/.test(text)) return null;
  const count = Number(text);
  return count <= handed ? count : null;
}

/**
 * What to tell a parent about `PhotosResult.unconfirmed`: Photos counted fewer than it was
 * given, or gave no count at all, and either way cannot say which.
 */
/**
 * What an install that turned the option on before 2026-09-24 is not adding (see `sortOut`),
 * and how to add it. The page says the same.
 */
export function earlierSentence(count: number, from: string): string {
  return (`Only photos saved since ${from.slice(0, 10)} are added, as when this was turned on. ${count} saved before then ` +
    `${count === 1 ? 'is' : 'are'} not: to add every photo, turn it off and on again on the setup page, which asks first.`);
}

export function unconfirmedSentence(count: number): string {
  return (
    `Apple Photos.app did not confirm ${count} of the photos it was given. ${count === 1 ? 'It is' : 'Every one is'} still in your ` +
    `photos folder; if one is missing from Apple Photos.app, add it from there by hand.`
  );
}

/**
 * The sentence for files left out because they are no longer what this tool saved: which
 * ones, so the parent can find them, and what to do about each kind of cause.
 */
function changedReport(paths: readonly string[], added: number): string {
  const one = paths.length === 1;
  const it = one ? 'it' : 'them';
  const which = paths.slice(0, 3).join(', ') + (paths.length > 3 ? `, and ${paths.length - 3} more` : '');
  return (
    `${one ? 'One photo was' : `${paths.length} photos were`} not added to Apple Photos.app, because ` +
    `${one ? 'it is' : 'they are'} not ${one ? 'a file' : 'files'} this tool saved on this Mac, or not as it saved ${it}: ${which}. ` +
    `Something has changed or put ${it} there since — an edit of your own, another program, or another computer that can ` +
    `write to your photos folder. If that was you, you can add ${it} to Apple Photos.app by hand; if not, look at ${it} before you do.` +
    (added > 0 ? ` The other ${added} ${added === 1 ? 'was' : 'were'} added.` : '')
  );
}

/**
 * Take the one lock, so two runs at once — the daily one and a press of the button — cannot
 * both hand the same files over. Returns the release, or null when another run holds it.
 *
 * Built as the folder's run lock is, from its parts in run-lock.ts (security review
 * processes-6): a lock left by a run that died is removed by one taker at a time, and only if
 * it is still the one judged stale, so of two runs that judge it at once only one goes on
 * (see setAsideIfUnchanged); a lock whose
 * write failed is taken away again rather than left empty, where it would read as another
 * run's for 45 minutes; and the release removes the lock only while it is still this run's,
 * told apart by a random token in it.
 */
async function takeLock(): Promise<(() => Promise<void>) | null> {
  const file = lockPath();
  await mkdir(configDir(), { recursive: true, mode: 0o700 });
  const mine = `${process.pid} ${new Date().toISOString()} ${randomBytes(8).toString('hex')}\n`;
  // Three tries at most: once; again after a lock whose run just finished vanished, or after
  // setting aside one left by a run that died; and a last time after both.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let handle: FileHandle | undefined;
    try {
      handle = await open(file, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        // A folder at the name is EEXIST here, but may be EISDIR or EPERM elsewhere (Windows).
        const found = await sightLock(file).catch(() => null);
        if (found?.notAFile !== undefined) throw new RunLockUnusableError(file, found.notAFile);
        throw error;
      }
    }
    if (handle) {
      await writeLockOrRemove(handle, file, mine);
      return async () => {
        const now = await sightLock(file).catch(() => null);
        if (now?.text === mine) await rm(file, { force: true });
      };
    }
    const seen = await sightLock(file);
    // Gone between the two calls means its owner just finished: try again at once.
    if (!seen) continue;
    if (seen.notAFile !== undefined) throw new RunLockUnusableError(file, seen.notAFile);
    // touchedWithin, not a subtraction: a lock dated in the future is not a fresh one (§4.6, F2).
    if (touchedWithin(seen.touched, STALE_LOCK_MS)) return null;
    await setAsideIfUnchanged(file, seen);
  }
  return null;
}

/**
 * Ask Photos a harmless question, so macOS asks its permission question now.
 *
 * Run when the parent turns the option on, from the setup page, while they are looking at
 * the screen — rather than for the first time at seven in the evening, when nobody is there
 * to answer and the run would simply stall.
 */
export async function checkPhotosAccess(options: PhotosOptions = {}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!photosSupported(options.platform)) return { ok: false, error: 'Adding to Apple Photos.app is only possible on a Mac.' };
  const spawn = options.spawn ?? realSpawn;
  const result = await spawn(OSASCRIPT, [PHOTOS_SCRIPT], CHECK_TIMEOUT_MS);
  if (result.missing) return { ok: false, error: 'This Mac has no osascript, so Apple Photos.app cannot be reached.' };
  if (result.code === 0) return { ok: true };
  return { ok: false, error: explain(result.code, result.stderr).error };
}

/**
 * Hand everything due to Photos.
 *
 * Grouped by album and taken in path order, so the first time a backlog goes in the albums
 * are made oldest first and Photos lists them in that order. Each batch is written down as
 * soon as Photos accepts it; a batch that fails stops the attempt and stays waiting, so the
 * next run tries it again and nothing is ever handed over twice.
 */
export async function addToPhotos(config: Config, options: PhotosOptions = {}): Promise<PhotosResult> {
  const say = options.onProgress ?? (() => {});
  if (!photosSupported(options.platform)) {
    return { ok: false, added: 0, remaining: 0, missing: 0, reason: 'unsupported', error: 'Adding to Apple Photos.app is only possible on a Mac.' };
  }
  if (!config.addToPhotos) return { ok: true, added: 0, remaining: 0, missing: 0 };

  const release = await takeLock();
  if (!release) {
    return {
      ok: false,
      added: 0,
      remaining: 0,
      missing: 0,
      reason: 'busy',
      error: 'Another run is adding photos to Apple Photos.app right now. Anything it does not reach will be added next time.',
    };
  }

  const spawn = options.spawn ?? realSpawn;
  let added = 0;
  let unconfirmed = 0;
  let missing = 0;
  /** The list's paths for files that are no longer what was saved, for the report. */
  const changed: string[] = [];
  try {
    const state = await loadState();
    // Copies a run that was killed part-way left behind. Under the lock, so none is in use.
    for (const name of await readdir(configDir()).catch(() => [] as string[])) {
      if (name.startsWith(HANDOVER_PREFIX)) await rm(join(configDir(), name), { recursive: true, force: true });
    }
    const listed = await records(config);
    const { due } = await sortOut(config, listed, state);
    if (due.length === 0) return { ok: true, added: 0, remaining: 0, missing: 0, changed: 0 };
    // What this tool saved, from outside the photos folder; see fingerprints.ts.
    const saved = await savedFingerprints(config, () => say('Noting which photos this tool saved, once; this can take a minute…'));

    const albums = new Map<string, Waiting[]>();
    for (const item of due) {
      const key = item.album.join('\u0000');
      const list = albums.get(key) ?? [];
      list.push(item);
      albums.set(key, list);
    }
    const keys = [...albums.keys()].sort();

    let remaining = due.length;
    say(`Adding ${due.length} to Apple Photos.app, in the ${PHOTOS_FOLDER} folder…`);
    for (const key of keys) {
      const items = albums.get(key) ?? [];
      for (let i = 0; i < items.length; i += BATCH) {
        // Stopped, or turned off: what Photos has taken is written down, the rest waits for
        // the next run (or, turned off, for the option to be turned on again). Asked before
        // the batch is read and hashed, which is the slow part of a batch.
        const off = !options.signal?.aborted && options.stillOn ? !(await options.stillOn().catch(() => true)) : false;
        if (options.signal?.aborted || off) {
          if (added > 0 || unconfirmed > 0) {
            state.lastAttempt = { at: new Date().toISOString(), ok: true, added, ...(unconfirmed > 0 && { unconfirmed }) };
            await saveState(state);
          }
          return { ok: true, added, remaining, missing, changed: changed.length, ...(unconfirmed > 0 && { unconfirmed }), ...(off && { turnedOff: true }) };
        }
        // Photos is never handed a file in the photos folder, only a private copy of it
        // (security review processes-5, and the time between check and use). Whatever else
        // can write that folder could swap a checked file for a link, or for other bytes, in
        // the minutes before Photos reads it. So each file is copied into a folder only this
        // account can open — a clone on APFS, which costs no space — the copy is hashed, and
        // Photos gets the copy only if its hash is one of the files this tool saved, from the
        // record kept outside the photos folder (fingerprints.ts). Nothing can change a copy
        // between that check and Photos reading it, and no link survives being copied.
        const stage = await mkdtemp(join(configDir(), HANDOVER_PREFIX));
        try {
          const batch: Array<Waiting & { copy: string }> = [];
          for (const [n, item] of items.slice(i, i + BATCH).entries()) {
            // A folder of its own for each copy, so its name is the file's own — Photos shows
            // it — and two names that differ only in case cannot meet on a Mac's disk.
            const copy = join(stage, String(n), basename(item.file));
            const copied = await mkdir(join(stage, String(n)))
              .then(() => copyFile(item.file, copy, fsConstants.COPYFILE_EXCL | fsConstants.COPYFILE_FICLONE))
              .then(() => true, () => false);
            // One file gone from disk would fail the whole call in AppleScript, and then
            // every call after it, for ever. It is left out instead, and counted — as is one
            // that is there but cannot be read, which Photos could not read either.
            const actual = copied ? await hashFile(copy).catch(() => null) : null;
            if (actual === null) {
              missing += 1;
              remaining -= 1;
              continue;
            }
            // Not one this tool saved, or no longer what it saved: changed since by the parent,
            // perhaps, or by anything else that can write the folder, such as another computer
            // it syncs with — and what reaches Photos, and iCloud, is not for that to choose.
            // It is left out, not written down as added (so it is looked at again next time,
            // and goes in if it is put back), and reported.
            if (!saved.has(actual)) {
              changed.push(item.record.path);
              remaining -= 1;
              await rm(copy, { force: true });
              continue;
            }
            batch.push({ ...item, copy });
          }
          if (batch.length === 0) continue;

          await utimes(lockPath(), new Date(), new Date()).catch(() => {});
          const album = batch[0]!.album;
          const result = await spawn(OSASCRIPT, [PHOTOS_SCRIPT, ...album, '--', ...batch.map((b) => b.copy)], IMPORT_TIMEOUT_MS);
          if (result.missing || result.code !== 0) {
            const why = result.missing
              ? { reason: 'failed' as const, error: 'This Mac has no osascript, so Apple Photos.app cannot be reached.' }
              : explain(result.code, result.stderr);
            state.lastAttempt = { at: new Date().toISOString(), ok: false, added, ...(unconfirmed > 0 && { unconfirmed }), error: why.error };
            await saveState(state);
            return { ok: false, added, remaining, missing, changed: changed.length, ...(unconfirmed > 0 && { unconfirmed }), ...why };
          }
          const now = new Date().toISOString();
          // Every file of the batch is written down, whatever Photos counted: see
          // `PhotosResult.unconfirmed`. The count said is Photos' own.
          for (const b of batch) state.added[b.record.sha256] = now;
          const took = importedCount(result.stdout, batch.length) ?? 0;
          added += took;
          unconfirmed += batch.length - took;
          remaining -= batch.length;
          await saveState(state);
          say(`Apple Photos.app has imported ${added} of ${due.length}…`);
        } finally {
          // Apple Photos.app has copied them into its library by the time the script returns,
          // provided "Copy items to the Photos library" is on. With it off, it now holds links
          // to files that no longer exist, and nothing here can tell: see WHAT APPLE PHOTOS.APP
          // IS GIVEN, above.
          await rm(stage, { recursive: true, force: true });
        }
      }
    }

    // A changed file makes the attempt a failure, although Apple Photos.app took everything it
    // was given: that way it is said everywhere a failure is — the page's Photos card, the
    // run's own line, the daily log and, once, a notification — rather than only counted.
    // Said again on every run that finds it, until the file is put back or moved out.
    if (changed.length > 0) {
      const error = changedReport(changed, added);
      state.lastAttempt = { at: new Date().toISOString(), ok: false, added, ...(unconfirmed > 0 && { unconfirmed }), error };
      await saveState(state);
      return { ok: false, added, remaining: 0, missing, changed: changed.length, ...(unconfirmed > 0 && { unconfirmed }), reason: 'changed', error };
    }

    state.lastAttempt = { at: new Date().toISOString(), ok: true, added, ...(unconfirmed > 0 && { unconfirmed }) };
    await saveState(state);
    return { ok: true, added, remaining: 0, missing, changed: 0, ...(unconfirmed > 0 && { unconfirmed }) };
  } finally {
    await release();
  }
}
