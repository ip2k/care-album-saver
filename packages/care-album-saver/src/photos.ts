import { mkdir, open, rm, stat, utimes } from 'node:fs/promises';
import { platform as osPlatform } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from './config.js';
import type { ManifestRecord } from './ferry/index.js';
import { records } from './gallery.js';
import { runProgram, type SpawnCommand } from './native.js';
import { configDir, readJsonFile, writeSecureFile } from './paths.js';

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

export type PhotosFailure = 'unsupported' | 'denied' | 'timeout' | 'busy' | 'failed';

export interface PhotosResult {
  ok: boolean;
  added: number;
  /** Still waiting after this attempt: the ones a failure left behind. */
  remaining: number;
  /** Listed in the manifest but no longer on disk, so not handed over. */
  missing: number;
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
  const stored = await readJsonFile<PhotosState>(statePath());
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

/** Which files are due, and how many earlier ones are waiting on the parent's say-so. */
function sortOut(config: Config, all: readonly ManifestRecord[], state: PhotosState): { due: Waiting[]; earlier: number } {
  const from = config.addToPhotosFrom ? Date.parse(config.addToPhotosFrom) : Number.NEGATIVE_INFINITY;
  const root = resolve(config.archiveDir);
  const due: Waiting[] = [];
  const seen = new Set<string>();
  let earlier = 0;
  for (const record of all) {
    if (!record.sha256 || state.added[record.sha256] || seen.has(record.sha256)) continue;
    seen.add(record.sha256);
    const file = resolve(root, ...record.path.split('/'));
    // A manifest edited by hand could name a file outside the archive. Photos is not asked
    // to import anything this tool did not write, so those are ignored rather than trusted.
    if (!file.startsWith(root + sep)) continue;
    const album = albumPathFor(record.path);
    // `--` separates names from files in the script's arguments; a name equal to it would
    // move that boundary. No layout writes one, so this is a lock on a door nobody uses.
    if (album.some((name) => name === '--')) continue;
    if (Date.parse(record.downloadedAt ?? '') < from) {
      earlier += 1;
      continue;
    }
    due.push({ record, file, album });
  }
  return { due, earlier };
}

/** What the page shows: whether it is on, and what is waiting. */
export async function photosStatus(config: Config, options: PhotosOptions = {}): Promise<PhotosStatus> {
  const supported = photosSupported(options.platform);
  const state = await loadState();
  const { due, earlier } = supported ? sortOut(config, await records(config), state) : { due: [], earlier: 0 };
  return {
    supported,
    enabled: supported && config.addToPhotos,
    from: config.addToPhotosFrom,
    folder: PHOTOS_FOLDER,
    pending: config.addToPhotos ? due.length : 0,
    earlier,
    lastAttempt: state.lastAttempt ?? null,
    scriptUrl: PHOTOS_SCRIPT_URL,
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
  try {
    const state = await loadState();
    const { due } = sortOut(config, await records(config), state);
    if (due.length === 0) return { ok: true, added: 0, remaining: 0, missing: 0 };

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
        const batch: Waiting[] = [];
        for (const item of items.slice(i, i + BATCH)) {
          // One file gone from disk would fail the whole call in AppleScript, and then
          // every call after it, for ever. It is left out instead, and counted.
          const there = await stat(item.file).then((s) => s.isFile(), () => false);
          if (there) batch.push(item);
          else {
            missing += 1;
            remaining -= 1;
          }
        }
        if (batch.length === 0) continue;
        // Stopped: what Photos has taken is written down, the rest waits for the next run.
        if (options.signal?.aborted) return { ok: true, added, remaining, missing };

        await utimes(lockPath(), new Date(), new Date()).catch(() => {});
        const album = batch[0]!.album;
        const result = await spawn('osascript', [PHOTOS_SCRIPT, ...album, '--', ...batch.map((b) => b.file)], IMPORT_TIMEOUT_MS);
        if (result.missing || result.code !== 0) {
          const why = result.missing
            ? { reason: 'failed' as const, error: 'This Mac has no osascript, so Photos cannot be reached.' }
            : explain(result.code, result.stderr);
          state.lastAttempt = { at: new Date().toISOString(), ok: false, added, error: why.error };
          await saveState(state);
          return { ok: false, added, remaining, missing, ...why };
        }
        const now = new Date().toISOString();
        for (const b of batch) state.added[b.record.sha256] = now;
        added += batch.length;
        remaining -= batch.length;
        await saveState(state);
        say(`Added ${added} of ${due.length} to Photos…`);
      }
    }

    state.lastAttempt = { at: new Date().toISOString(), ok: true, added };
    await saveState(state);
    return { ok: true, added, remaining: 0, missing };
  } finally {
    await release();
  }
}
