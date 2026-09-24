import { mkdir, open, realpath, rm, stat, utimes } from 'node:fs/promises';
import { platform as osPlatform } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from './config.js';
import { hashFile, type ManifestRecord } from './ferry/index.js';
import { records } from './gallery.js';
import { runProgram, type SpawnCommand } from './native.js';
import { containedFile } from './contain.js';
import { configDir, readJsonFile, UnreadableFileError, writeSecureFile } from './paths.js';
import { checkArchiveDir } from './safety.js';

/**
 * Adding saved photos to the Photos app, on a Mac, when the parent has asked for it.
 *
 * WHY THIS IS OFF UNLESS TURNED ON. Everywhere else this tool can promise that nothing
 * leaves the computer. A Photos library with iCloud Photos switched on uploads whatever is
 * added to it, so this is the one setting that breaks that promise — on the parent's say-so,
 * to the parent's own iCloud account, and never by default.
 *
 * HOW IT TALKS TO PHOTOS. Through one AppleScript file, `applescript/add-to-photos.applescript`,
 * which holds everything this tool ever asks Photos to do, so that a parent — or anyone
 * reviewing the project — can read the whole of it in one place. It is run as
 *
 *     osascript add-to-photos.applescript Brightwheel Robin-Maple 2026-W38 -- FILE FILE ...
 *
 * with an argument array, never a shell, and nothing is ever pasted into the script's text:
 * osascript hands every argument after the file to the script as data (`--` and `-e`
 * included, which was checked rather than assumed). That is the same rule native.ts keeps
 * for the folder chooser, reached a different way — the chooser needs no input at all, and
 * this needs a list of files, so the files go in as arguments instead of as source.
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
 * folder layout is still recognised, and the same photo posted twice is added once.
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
}

/** How the last attempt went, kept so the page can say so days later. */
export interface PhotosAttempt {
  at: string;
  ok: boolean;
  /** How many files this attempt handed over. */
  added: number;
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
  added: number;
  /** Still waiting after this attempt: the ones a failure left behind. */
  remaining: number;
  /** Listed in the manifest but no longer on disk, so not handed over. */
  missing: number;
  /**
   * On disk, but no longer the file this tool saved — its SHA-256 differs from the one
   * recorded — so not handed over, and not written down as added either. Optional because
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
  from: string | null;
  folder: string;
  /** Saved since it was turned on and not yet in Photos. */
  pending: number;
  /** Saved before it was turned on and not in Photos: the "add those too" count. */
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
    // run would hand every photo since the option was turned on to Photos a second time —
    // and to iCloud with it. So it stops here instead (security review fs-5).
    if (error instanceof UnreadableFileError) {
      throw new Error(
        `The record of what has already been added to Photos (${error.path}) cannot be read: ${error.reason}. ` +
          'Nothing was added, so nothing has been added twice. Moving that file somewhere safe starts the ' +
          'record again, which adds every photo since you turned this on a second time.',
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

/** Which files are due, and how many earlier ones are waiting on the parent's say-so. */
async function sortOut(config: Config, all: readonly ManifestRecord[], state: PhotosState): Promise<{ due: Waiting[]; earlier: number }> {
  const from = config.addToPhotosFrom ? Date.parse(config.addToPhotosFrom) : Number.NEGATIVE_INFINITY;
  const root = resolve(config.archiveDir);
  // The archive where it really is, so that albums can be named from where each file really
  // is. Unresolvable, and containedFile would refuse every entry anyway.
  const realRoot = await realpath(root).catch(() => null);
  if (!realRoot) return { due: [], earlier: 0 };
  const due: Waiting[] = [];
  const seen = new Set<string>();
  let earlier = 0;
  for (const record of all) {
    // The list is read as it is found, unchecked (gallery.ts's records), and the hash is
    // now compared as text; an entry without a string for either is not one this tool wrote.
    if (typeof record?.sha256 !== 'string' || typeof record.path !== 'string') continue;
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
 * What to say when the photos folder looks cloud-synced — and why this warns rather than
 * refuses (security review processes-5, the question it left open).
 *
 * A folder that something else can write to is a folder whose contents that something has a
 * say in, and this step hands those contents to Photos, and with iCloud Photos on, to Apple.
 * Refusing the step there would be the stricter answer, and it is not taken, because:
 *
 *  - It would switch off a setup that works, on the strength of a guess. `checkArchiveDir`
 *    judges by the path alone, and it flags Desktop and Documents because macOS and Windows
 *    often sync them — often, not always, and they are where many people keep things. A
 *    parent whose photos stopped reaching Photos one evening, with nothing changed on their
 *    side, would be told nothing they could act on.
 *  - The parent has already chosen twice: the folder, after being told it looks synced (and
 *    every run repeats that in its warnings), and Photos, after macOS asked their permission.
 *  - What a sync peer could do through this step is now narrow. A photo it changed is left
 *    out and reported (`addToPhotos` compares every file with the SHA-256 recorded when it
 *    was saved). What remains is a new photo placed together with an entry in archive.json,
 *    and a peer that can do that can already put whatever it likes in the folder the parent
 *    browses.
 *
 * So it is said where the switch is, in `photosStatus`, and the choice stays the parent's.
 */
function cloudWarning(config: Config): string | null {
  if (!checkArchiveDir(config.archiveDir).warning) return null;
  return (
    'Your photos folder looks like it may be synced to a cloud service. If it is, anything else that can ' +
    'change that folder — another computer signed in to the same account, say — has a say in what is added ' +
    'to Photos. This tool leaves out any photo that is no longer the one it saved, but a new photo put there ' +
    'together with an entry in the folder’s archive.json would be added like any other. If that matters to ' +
    'you, keep your photos folder somewhere only this Mac can change.'
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
  return {
    supported,
    enabled: supported && config.addToPhotos,
    from: config.addToPhotosFrom,
    folder: PHOTOS_FOLDER,
    pending: config.addToPhotos ? due.length : 0,
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
        'Your Mac has not allowed Care Album Saver to add photos to Photos. Open System Settings › ' +
        'Privacy & Security › Automation, find the program it runs in (Terminal, or node for the ' +
        'daily run) and turn on Photos under it. Your photos are safe in your folder and will be added next time.',
    };
  }
  if (code === 124 || /\(-1712\)/.test(stderr)) {
    return {
      reason: 'timeout',
      error:
        'Photos did not answer in time. Open Photos yourself once, check it shows your library ' +
        'rather than a welcome screen, and try again. Nothing was lost; they will be added next time.',
    };
  }
  if (/\(-600\)|\(-10810\)|\(-10814\)/.test(stderr)) {
    return { reason: 'failed', error: 'Photos could not be opened on this Mac, so nothing was added to it.' };
  }
  return { reason: 'failed', error: `Photos did not take them${said ? `: ${said}` : '.'}` };
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
    `${one ? 'One photo was' : `${paths.length} photos were`} not added to Photos, because ` +
    `${one ? 'it is' : 'they are'} no longer the file this tool saved: ${which}. Something has changed ${it} since — ` +
    `an edit of your own, or another program or computer that can write to your photos folder. If you changed ${it} ` +
    `yourself, you can add ${it} to Photos by hand; if you did not, look at ${it} before you do.` +
    (added > 0 ? ` The other ${added} ${added === 1 ? 'was' : 'were'} added.` : '')
  );
}

/**
 * Take the one lock, so two runs at once — the daily one and a press of the button — cannot
 * both hand the same files over. Returns the release, or null when another run holds it.
 */
async function takeLock(): Promise<(() => Promise<void>) | null> {
  const file = lockPath();
  await mkdir(configDir(), { recursive: true, mode: 0o700 });
  // Twice at most: once, and once more after clearing a lock left by a run that died.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(file, 'wx', 0o600);
      await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`);
      await handle.close();
      return () => rm(file, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // Gone between the two calls means its owner just finished: try again at once.
      const touched = await stat(file).then((s) => s.mtimeMs, () => 0);
      if (Date.now() - touched < STALE_LOCK_MS) return null;
      await rm(file, { force: true });
    }
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
  if (!photosSupported(options.platform)) return { ok: false, error: 'Adding to Photos is only possible on a Mac.' };
  const spawn = options.spawn ?? realSpawn;
  const result = await spawn('osascript', [PHOTOS_SCRIPT], CHECK_TIMEOUT_MS);
  if (result.missing) return { ok: false, error: 'This Mac has no osascript, so Photos cannot be reached.' };
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
    return { ok: false, added: 0, remaining: 0, missing: 0, reason: 'unsupported', error: 'Adding to Photos is only possible on a Mac.' };
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
      error: 'Another run is adding photos to Photos right now. Anything it does not reach will be added next time.',
    };
  }

  const spawn = options.spawn ?? realSpawn;
  let added = 0;
  let missing = 0;
  /** The list's paths for files that are no longer what was saved, for the report. */
  const changed: string[] = [];
  try {
    const state = await loadState();
    const { due } = await sortOut(config, await records(config), state);
    if (due.length === 0) return { ok: true, added: 0, remaining: 0, missing: 0, changed: 0 };

    const albums = new Map<string, Waiting[]>();
    for (const item of due) {
      const key = item.album.join('\u0000');
      const list = albums.get(key) ?? [];
      list.push(item);
      albums.set(key, list);
    }
    const keys = [...albums.keys()].sort();

    let remaining = due.length;
    say(`Adding ${due.length} to Photos, in the ${PHOTOS_FOLDER} folder…`);
    for (const key of keys) {
      const items = albums.get(key) ?? [];
      for (let i = 0; i < items.length; i += BATCH) {
        // Stopped: what Photos has taken is written down, the rest waits for the next run.
        // Asked before the batch is read and hashed, which is the slow part of a batch.
        if (options.signal?.aborted) return { ok: true, added, remaining, missing, changed: changed.length };
        const batch: Waiting[] = [];
        for (const item of items.slice(i, i + BATCH)) {
          // One file gone from disk would fail the whole call in AppleScript, and then
          // every call after it, for ever. It is left out instead, and counted — as is one
          // that is there but cannot be read, which Photos could not read either.
          const there = await stat(item.file).then((s) => s.isFile(), () => false);
          const actual = there ? await hashFile(item.file).catch(() => null) : null;
          if (actual === null) {
            missing += 1;
            remaining -= 1;
            continue;
          }
          // Only the file this tool saved goes to Photos (security review processes-5). The
          // SHA-256 in the list was taken of the finished file as it was put in place, so a
          // file that no longer matches has been changed since — by the parent, perhaps, or
          // by anything else that can write the folder, such as another computer it syncs
          // with — and what reaches Photos, and iCloud, is not for that to choose. It is left
          // out, not written down as added (so it is looked at again next time, and goes in
          // if it is put back), and reported. The check is made just before the batch is
          // handed over; a swap in the moment between is beyond what any check here can see.
          if (actual !== item.record.sha256.toLowerCase()) {
            changed.push(item.record.path);
            remaining -= 1;
            continue;
          }
          batch.push(item);
        }
        if (batch.length === 0) continue;

        await utimes(lockPath(), new Date(), new Date()).catch(() => {});
        const album = batch[0]!.album;
        const result = await spawn('osascript', [PHOTOS_SCRIPT, ...album, '--', ...batch.map((b) => b.file)], IMPORT_TIMEOUT_MS);
        if (result.missing || result.code !== 0) {
          const why = result.missing
            ? { reason: 'failed' as const, error: 'This Mac has no osascript, so Photos cannot be reached.' }
            : explain(result.code, result.stderr);
          state.lastAttempt = { at: new Date().toISOString(), ok: false, added, error: why.error };
          await saveState(state);
          return { ok: false, added, remaining, missing, changed: changed.length, ...why };
        }
        const now = new Date().toISOString();
        for (const b of batch) state.added[b.record.sha256] = now;
        added += batch.length;
        remaining -= batch.length;
        await saveState(state);
        say(`Added ${added} of ${due.length} to Photos…`);
      }
    }

    // A changed file makes the attempt a failure, although Photos took everything it was
    // given: that way it is said everywhere a failure is — the page's Photos card, the
    // run's own line, the daily log and, once, a notification — rather than only counted.
    // Said again on every run that finds it, until the file is put back or moved out.
    if (changed.length > 0) {
      const error = changedReport(changed, added);
      state.lastAttempt = { at: new Date().toISOString(), ok: false, added, error };
      await saveState(state);
      return { ok: false, added, remaining: 0, missing, changed: changed.length, reason: 'changed', error };
    }

    state.lastAttempt = { at: new Date().toISOString(), ok: true, added };
    await saveState(state);
    return { ok: true, added, remaining: 0, missing, changed: 0 };
  } finally {
    await release();
  }
}
