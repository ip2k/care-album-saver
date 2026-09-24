import { chmod, mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises';
import { platform } from 'node:os';
import { join, posix, sep } from 'node:path';
import {
  DownloadError,
  Manifest,
  download,
  hashFile,
  safeStem,
  signedUrlExpiry,
  uniqueName,
  weekFolder,
  weekLabel,
  writeAtomically,
} from './ferry/index.js';
import type { ActivityListOptions, ActivityPage, BrightwheelClient } from './api/client.js';
import type { MediaActivity, Student } from './api/schema.js';
import type { Config } from './config.js';
import { applyMetadata, closeMetadata } from './metadata.js';
import { realFolderUnder } from './contain.js';
import { ARCHIVE_DIR_MODE, checkArchiveDir } from './safety.js';
import { takeRunLock } from './run-lock.js';

export interface SyncProgress {
  /**
   * `stopped` is the end of a run that was asked to stop (see `sync`'s `signal`): it is a
   * normal ending, not a failure, and it is the last event such a run emits.
   *
   * `photos` is never emitted by `sync` itself. The setup server reports it while it hands
   * the run's new files to the Photos app afterwards (src/photos.ts), so the page can say
   * what the wait is for.
   */
  phase: 'starting' | 'listing' | 'downloading' | 'photos' | 'done' | 'error' | 'stopped';
  student?: string;
  message: string;
  saved: number;
  skipped: number;
  failed: number;
  /**
   * Posts of every kind on the current child's feed, as Brightwheel counts them.
   *
   * These two are the honest measures of progress, and there is deliberately no total of
   * items this run will handle, because that is not knowable: Brightwheel's `count` is posts
   * of every kind — check-ins, naps and meals as well as photos — and an incremental run
   * stops early. A number there would turn into an invented percentage in the UI.
   */
  posts?: number;
  /** How many of those this run has looked through so far. */
  examined?: number;
}

export interface SyncResult {
  saved: number;
  skipped: number;
  failed: number;
  students: string[];
  archiveDir: string;
  warnings: string[];
  /**
   * The run stopped early because it was asked to, rather than reaching the end of the
   * feed. Everything it had saved is on disk and in the manifest; the next run carries on.
   */
  stopped: boolean;
}

/** Where a given photo belongs on disk, per the chosen layout. */
function folderFor(config: Config, student: Student, when: Date): string {
  const week = weekFolder(when);
  const child = safeStem(student.fullName);
  switch (config.organiseBy) {
    case 'week':
      return week;
    case 'week-per-child':
      return join(week, child);
    case 'child-then-week':
    default:
      return join(child, week);
  }
}

/**
 * The manifest's form of "where this file is": forward slashes, on every platform.
 *
 * `join` uses the separator of the machine it runs on, so a Windows run would record
 * `Robin-Maple\2026-W38\...` in a file that travels with the archive to a Mac. The folders
 * on disk keep the platform's own separator; only the recorded path is normalised.
 */
function archivePath(rel: string, filename: string): string {
  return posix.join(...rel.split(sep), filename);
}

/**
 * The timezone this archive is filed under.
 *
 * Brightwheel hands us an instant and no timezone: `event_date` says *when* a photo was
 * posted, never *where*, and the students response carries the school's name but not its
 * clock. So the day and week a photo is filed under can only come from a clock we choose,
 * and the only honest choice is the one the person can see: the clock of the computer doing
 * the archiving. That is right for a parent archiving at home and wrong for a machine set
 * to UTC (a server, a container), which is why it is written into every week's README and
 * into the manifest rather than left implicit. Pin it with `TZ` if the machine's clock is
 * not the one the photos were taken by; nothing here invents a zone the data does not have.
 */
function archiveTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * Filename stem: date, time and a short id.
 *
 * The date and time are the local ones — the same clock the week folder uses, see
 * `archiveTimezone` — so a file's name, its folder and its embedded metadata never
 * disagree with each other.
 *
 * The id suffix is not decoration. Two photos taken in the same second by the same teacher
 * are common (burst shots), and without a stable discriminator they would collide and the
 * collision counter would renumber them differently on every run — so a re-run would look
 * like new files. Embedding Brightwheel's own id makes the name deterministic.
 */
function nameFor(activity: MediaActivity, ext: string): { stem: string; ext: string } {
  const d = activity.postedAt;
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const shortId = activity.id.replace(/[^a-zA-Z0-9]/g, '').slice(-8);
  return { stem: `${stamp}_${shortId}`, ext };
}

/**
 * The extensions a saved file may carry: photographs and videos, and nothing a computer runs
 * or a browser renders as a page.
 *
 * The extension used to be whatever two to five letters ended the media URL, and the URL is
 * chosen by the server. `.html`, `.svg`, `.exe` and `.lnk` were all accepted — into a folder
 * a parent opens by double-clicking what is in it, where the extension decides which
 * program opens the file (security review fs-4).
 *
 * One list for both kinds, not one per kind. The kind is the post's, not the file's: a
 * video post with no video carries its still (`thumb.jpg`), and naming that JPEG `.mp4`
 * sends it to a video player that cannot play it and makes ExifTool refuse to tag it. So an
 * extension on this list is kept whatever the post was, and only an extension that is not —
 * or none — falls back to the kind's usual one. Everything here is a format some photo or
 * video app opens and none executes; the ones ExifTool cannot write (bmp, webm, avi) are
 * still saved, with the `.json` beside them carrying what could not go in.
 */
const MEDIA_EXTENSIONS: ReadonlySet<string> = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'avif', 'tif', 'tiff', 'bmp',
  'mp4', 'mov', 'm4v', '3gp', 'webm', 'avi',
]);

/** The extension to save a media URL's file under: from MEDIA_EXTENSIONS, or the kind's own. */
export function extensionOf(url: string, kind: 'image' | 'video'): string {
  try {
    const ext = /\.([a-zA-Z0-9]{2,5})$/.exec(new URL(url).pathname)?.[1]?.toLowerCase();
    if (ext && MEDIA_EXTENSIONS.has(ext)) return ext;
  } catch {
    /* fall through */
  }
  return kind === 'video' ? 'mp4' : 'jpg';
}

/**
 * Save one item in a private folder inside its week folder, then move it into place.
 *
 * Everything that happens to a file before it is finished happens under a name somebody
 * else could work out: the download's `<name>.part`, ExifTool's own `<name>_exiftool_tmp`,
 * the `.xmp` sidecar ExifTool writes, the `.json` beside it. In a folder that other things
 * can write to, each of those was a place to plant a symbolic link — and ExifTool follows a
 * dangling one, so a planted link sent the tagged photo, or a sidecar naming the child and
 * the school, to a folder of the planter's choosing (security review fs-2, found by the
 * adversarial pass). So the work is done in a folder with an unpredictable name that only
 * this account can open (mkdtemp makes it 0700), and the finished files are renamed into the
 * week folder: a rename replaces a link at the name rather than following it. The folder's
 * name starts with a dot, so one left behind by a run that was killed is not taken for
 * photographs; see walkArchive.
 *
 * The notes go into place first and the photo last, so a photo under its real name always
 * has its notes beside it. The `.json` is part of saving a photo, as it always was; the
 * `.xmp` is an extra the parent asked for, and one that cannot be put in place is reported
 * (`xmpNotPlaced`) without failing the photo, as a sidecar ExifTool could not write is.
 */
async function saveStaged<T extends object>(
  dir: string,
  filename: string,
  work: (staged: string) => Promise<T>,
): Promise<T & { staging: string; xmpNotPlaced: string | null }> {
  const staging = await mkdtemp(join(dir, '.saving-'));
  const place = (name: string) =>
    rename(join(staging, name), join(dir, name)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  try {
    const done = await work(join(staging, filename));
    await place(`${filename}.json`);
    let xmpNotPlaced: string | null = null;
    await place(`${filename}.xmp`).catch((error: NodeJS.ErrnoException) => {
      xmpNotPlaced = `The .xmp sidecar for ${filename} could not be put in place (${error.code ?? error.message}); the photo itself is saved.`;
    });
    await rename(join(staging, filename), join(dir, filename));
    return { ...done, staging, xmpNotPlaced };
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

/** A child's or a week's folder in the archive is a link to somewhere else. See realFolderUnder. */
class FolderOutsideArchiveError extends Error {
  constructor(rel: string) {
    super(
      `The folder ${rel} in your archive is a link to a folder somewhere else, so nothing was saved into it. ` +
        'Replace it with an ordinary folder and run again.',
    );
    this.name = 'FolderOutsideArchiveError';
  }
}

/**
 * Write a small README into each week folder.
 *
 * Archives outlive the software that made them. In ten years someone will open
 * `2026-W38` on a hard drive and want to know what it is without the tool present.
 */
async function writeWeekReadme(dir: string, when: Date, childName: string): Promise<void> {
  const body = [
    `# ${weekFolder(when)} — ${weekLabel(when)}`,
    '',
    `Photos and videos of ${childName} from this week, saved from Brightwheel.`,
    '',
    'Each file has a matching `.json` file next to it with the date it was posted to',
    'Brightwheel, who posted it and any note the teacher wrote.',
    '',
    'That posted date is the best one there is: the photographs arrive from Brightwheel',
    'carrying no date of their own, so the moment the picture was actually taken is not',
    'recorded anywhere. For a nursery the two are usually minutes apart.',
    '',
    // Said out loud, in the folder, because the archive outlives the settings that made
    // it: Brightwheel records when it was posted but not the timezone, so which day a
    // photo lands under is decided by the clock of the machine that saved it. A reader
    // years later — or a parent who archived a fortnight of photos from a hotel — can see
    // which clock.
    `Dates and times here follow one clock: ${archiveTimezone()}, the timezone of the`,
    'computer that saved these files. Brightwheel records when a photo was posted but not',
    'the timezone it was taken in, so files saved from a computer set to another timezone',
    'can land in the next day — or the next week — along from these.',
    '',
    'Saved by care-album-saver. These files are yours; nothing here phones home.',
    '',
  ].join('\n');
  // A fixed name in a folder other things can write to: see writeAtomically.
  await writeAtomically(join(dir, 'README.md'), body);
}

/**
 * Make the archive folder owner-only even when this tool did not create it.
 *
 * `mkdir(..., { mode })` applies the mode only to directories it actually creates. A parent
 * who made "Brightwheel Photos" in Finder first, or who pointed the tool at a folder they
 * already had, keeps whatever the operating system gave it — 0755 on a Mac, which every
 * account on the computer can read. The README says the photo folders are owner-only, so
 * without this the promise held only for the folder the tool happened to make itself.
 *
 * Tightening, and then saying so. A folder that other accounts can read may be a deliberate
 * choice — the other parent has their own login on the same laptop — and silently undoing
 * that would leave them wondering why sharing broke. So the change is made, because the
 * default a parent never chose should not be the one that leaks, and it is reported, so the
 * one who did choose it can put it back.
 *
 * Only the root, deliberately: the week folders inside it sit behind this one, and a folder
 * nobody can enter is enough to keep its contents out of reach.
 *
 * Windows has no POSIX modes — files and folders there inherit the parent ACL — so there is
 * nothing to assert, the same skip as `writeSecureFile` in paths.ts.
 */
async function ensureOwnerOnly(dir: string, warnings: string[]): Promise<void> {
  if (platform() === 'win32') return;
  let mode: number;
  try {
    mode = (await stat(dir)).mode & 0o777;
  } catch {
    // Unreadable or gone between mkdir and here. The run is about to fail on its own terms
    // and with a better message than anything this could add.
    return;
  }
  // Only bits outside "owner" count as too open. A folder the parent has made *stricter*
  // than 0700 is left exactly as it is; widening it back would be the same mistake in the
  // other direction.
  if ((mode & ~ARCHIVE_DIR_MODE) === 0) return;
  try {
    await chmod(dir, ARCHIVE_DIR_MODE);
    warnings.push(
      `Other accounts on this computer could open the folder your photos are saved in, so ` +
        `it has been changed to allow only yours: ${dir}. If you had opened it up on ` +
        `purpose — to share the photos with someone else who uses this computer — you will ` +
        `need to do that again.`,
    );
  } catch (error) {
    // Not fatal: the photos still save. But a parent told the folder is private deserves to
    // hear that, on this machine, it is not.
    warnings.push(
      `The folder your photos are saved in can be opened by other accounts on this ` +
        `computer, and its permissions could not be changed: ${dir} ` +
        `(${error instanceof Error ? error.message : String(error)}).`,
    );
  }
}

/**
 * Where each child's last *complete* walk of the feed reached, kept in the manifest.
 *
 * "Stop once we reach posts older than what we already hold" is only safe when what we
 * hold is contiguous. A run that died on page three holds the newest posts and nothing
 * older; taking the newest of those as the cut-off would skip the rest of the feed on
 * every later run, silently and forever. So the cut-off advances only when a walk reaches
 * the end with nothing left behind, and an interrupted or partly failed run resumes from
 * the previous cut-off, skipping what it already saved. Manifests written before this
 * existed have no cut-off at all and get one full, download-free walk.
 */
function walkedThrough(manifest: Manifest): Record<string, string> {
  const state = manifest.state;
  if (typeof state.walkedThrough !== 'object' || state.walkedThrough === null || Array.isArray(state.walkedThrough)) {
    state.walkedThrough = {};
  }
  return state.walkedThrough as Record<string, string>;
}

/** One post Brightwheel no longer has, as recorded in the manifest. */
interface GoneItem {
  /** Why we believe it is gone, e.g. "HTTP 404". Never a URL: those are signed credentials. */
  reason: string;
  /** When this run gave up on it (ISO 8601). */
  at: string;
}

/**
 * Posts Brightwheel no longer has, by source id, kept in the manifest.
 *
 * A failed item normally holds the cut-off where it is, so that the next run walks the same
 * stretch of feed again and really does retry it. That is right for a refused download or a
 * dropped connection, and wrong for a post deleted on Brightwheel's side: nothing will ever
 * fetch it, so left in the way it pins the cut-off for ever and every future run re-lists
 * the entire feed only to fail on the same item again. Writing it down here retires it from
 * that job and leaves the archive saying which post is missing and why, rather than quietly
 * forgetting it.
 *
 * Recorded, not blacklisted: a later run that lists the post again still spends one request
 * on it. A post that reappears is worth a request, and a photo written off by mistake is
 * not recoverable. All the record changes is that it no longer pins the cut-off.
 */
function goneFromBrightwheel(manifest: Manifest): Record<string, GoneItem> {
  const state = manifest.state;
  if (typeof state.unavailable !== 'object' || state.unavailable === null || Array.isArray(state.unavailable)) {
    state.unavailable = {};
  }
  return state.unavailable as Record<string, GoneItem>;
}

/** What one child's walk of the feed needs in order to ask for a page a second time. */
interface Walk {
  client: BrightwheelClient;
  student: Student;
  /** The options the walk was started with; a re-request must page identically. */
  listing: ActivityListOptions;
  /**
   * Listing pages fetched a second time because a signature on them had expired, by page
   * index: activity id -> fresh URL. Every signature on a page ages together, so the first
   * expiry pays for one extra request and the other ninety-nine on that page reuse it.
   */
  refreshed: Map<number, Map<string, string>>;
  /**
   * Pages that have already spent their one re-fetch on an *expiry* the URL declared, as
   * opposed to one the CDN enforced. See `fetchMedia` for why that budget exists.
   */
  presumedExpired: Set<number>;
}

const isRefused = (e: unknown) => e instanceof DownloadError && (e.status === 401 || e.status === 403);
/**
 * A download failure no later run can cure: the file is not there.
 *
 * A signature that has merely gone stale is *refused* (401/403), and `fetchMedia` has
 * already answered that by asking the listing for a fresh URL. A 404 or a 410 after all of
 * that is the CDN saying the object itself is gone — a post deleted on Brightwheel's side.
 * Everything else, including every network error, stays retryable, because the cost of
 * retrying something curable is one request and the cost of writing off something curable
 * is a photo.
 */
const isGone = (e: unknown) => e instanceof DownloadError && (e.status === 404 || e.status === 410);
const hasExpired = (url: string) => {
  const expiry = signedUrlExpiry(url);
  return expiry !== null && expiry.getTime() <= Date.now();
};

/**
 * Download one item, surviving an expired signature.
 *
 * Media URLs are signed and short-lived (docs/DECISIONS.md, B3). A long run —
 * a first archive of years of photos, videos over a slow connection — outlives the ones on
 * its early pages, and the CDN then refuses a file that is perfectly available. The remedy
 * is to ask for the listing page again, which carries fresh signatures, and try that URL.
 *
 * Bounded on purpose: this item re-fetches its page at most once, and never requests the
 * same URL twice. A refusal that survives all of that is something other than expiry, and
 * the item is left for the next run rather than hammered. A refusal counts, a network error
 * does not — that is the caller's problem to report as it is.
 *
 * Bounded twice over, because a declared expiry is a claim, not a fact. Brightwheel's media
 * URLs are CloudFront's, whose `Expires` is Unix seconds, and that is read correctly
 * (docs/DECISIONS.md, B3). But another host that means "seconds of life" by `expires=`
 * would read as 1970 and so as permanently expired, and a CDN may disagree with the expiry
 * its own URL declares; either would buy a fresh listing page for every item on the page and
 * get the same parameter back each time. So a page may be re-fetched on the strength of a
 * declared expiry once per run — after that its URLs are treated as final and the CDN,
 * which is the only authority on the matter, gets to answer. A real refusal still buys the
 * one re-fetch per item.
 */
async function fetchMedia(walk: Walk, page: ActivityPage, activity: MediaActivity, target: string) {
  const headers = walk.client.mediaHeaders();
  const tried = new Set<string>();
  let refetched = false;

  /** A URL for this item we have not tried: the page's refreshed copy, or one re-fetch. */
  const alternative = async (): Promise<string | null> => {
    const cached = walk.refreshed.get(page.page)?.get(activity.id);
    if (cached && !tried.has(cached)) return cached;
    if (refetched) return null;
    refetched = true;
    const again = await walk.client.activitiesPage(walk.student.id, page.page, walk.listing);
    walk.refreshed.set(page.page, new Map(again.items.map((i) => [i.id, i.url])));
    const fresh = walk.refreshed.get(page.page)?.get(activity.id);
    // Gone from the page, or the same URL back (so the signature was not the problem).
    return fresh && !tried.has(fresh) ? fresh : null;
  };

  // Every signature on a page was issued together, so once one has expired the page's
  // refreshed copy is the better first choice for the rest — no wasted request each.
  let url = walk.refreshed.get(page.page)?.get(activity.id) ?? activity.url;
  // A URL that says it has already expired is not worth a request either — unless the
  // feed offers nothing else, in which case the CDN gets the final word after all, or the
  // page has already been refreshed on that claim once and it did not help.
  if (hasExpired(url) && !walk.presumedExpired.has(page.page)) {
    walk.presumedExpired.add(page.page);
    tried.add(url);
    url = (await alternative()) ?? url;
  }

  let refusal: unknown;
  for (;;) {
    tried.add(url);
    try {
      return { url, ...(await download({ url, destination: target, headers })) };
    } catch (error) {
      if (!isRefused(error)) throw error;
      refusal = error;
    }
    const next = await alternative();
    if (!next) throw refusal;
    url = next;
  }
}

/**
 * Save every new photo and video.
 *
 * `options.signal` is how a parent stops a run — Ctrl+C in the terminal, Stop in the setup
 * assistant. Stopping is not failing: the item being downloaded is allowed to finish, the
 * manifest is written, and the run *resolves* with `stopped` set. Nothing is abandoned
 * half-saved and nothing is lost, because the cut-off of the child that was interrupted is
 * left where it was — the next run walks that feed again and skips what it already holds.
 */
export async function sync(
  client: BrightwheelClient,
  config: Config,
  onProgress: (p: SyncProgress) => void = () => {},
  options: { allowTemporaryDir?: boolean; signal?: AbortSignal } = {},
): Promise<SyncResult> {
  // One run per archive folder at a time, across processes: see run-lock.ts. The folder is
  // checked and made first, because the lock lives in it — and a folder the OS would empty
  // is refused before anything is created, exactly as before. A run that finds the lock
  // held throws RunInProgressError having read and fetched nothing.
  const verdict = checkArchiveDir(config.archiveDir, { allowTemporary: options.allowTemporaryDir });
  if (!verdict.ok) throw new Error(verdict.error);
  // 0700, not the default 0755. These are identified photographs of a child: the folder is
  // named after them, the .json sidecar beside every file names them, and archive.json
  // names them once per photo — all of which is true whatever the "label photos with names"
  // switch says, because that switch governs only what goes *inside* the files. So other
  // accounts on a shared family computer must not be able to read any of it.
  await mkdir(config.archiveDir, { recursive: true, mode: ARCHIVE_DIR_MODE });
  // The lock keeps itself fresh on a timer for as long as it is held, so a download that
  // takes an hour reports nothing and still holds the folder (security review fs-6). Taking
  // it waits, and says so, only when an earlier holder's lock looks abandoned but may not be.
  const lock = await takeRunLock(config.archiveDir, {
    onWait: (message) => onProgress({ phase: 'starting', message, saved: 0, skipped: 0, failed: 0 }),
  });
  try {
    return await syncHoldingTheLock(client, config, onProgress, options, verdict.warning);
  } finally {
    await lock.release();
  }
}

async function syncHoldingTheLock(
  client: BrightwheelClient,
  config: Config,
  onProgress: (p: SyncProgress) => void,
  options: { signal?: AbortSignal },
  archiveWarning?: string,
): Promise<SyncResult> {
  const result: SyncResult = {
    saved: 0,
    skipped: 0,
    failed: 0,
    students: [],
    archiveDir: config.archiveDir,
    warnings: [],
    stopped: false,
  };

  onProgress({ phase: 'starting', message: 'Checking your Brightwheel session', ...counts(result) });

  const me = await client.me();
  let students = await client.students(me.id);
  if (config.includeStudents.length > 0) {
    students = students.filter((s) => config.includeStudents.includes(s.id));
  }
  if (students.length === 0) {
    throw new Error('No children found on this Brightwheel account.');
  }
  result.students = students.map((s) => s.fullName);

  // What `sync` found worth saying about the folder it checked before taking the lock, such
  // as one that a cloud service syncs.
  if (archiveWarning) result.warnings.push(archiveWarning);

  // A folder that already existed keeps its own mode, which `mkdir` leaves alone; make it
  // owner-only too.
  await ensureOwnerOnly(config.archiveDir, result.warnings);

  // The manifest is owner-only too, by the module's own default rather than anything asked
  // for here: it names every child, quotes every note and names whoever posted each photo, so
  // it is as identifying as the photos it lists and belongs behind the same wall.
  const manifest = await Manifest.open(config.archiveDir, 'brightwheel');
  const walked = walkedThrough(manifest);
  const gone = goneFromBrightwheel(manifest);
  const timezone = archiveTimezone();

  // Names already used in each folder, so collisions get a suffix rather than overwrite.
  const takenByFolder = new Map<string, Set<string>>();
  const seenFolders = new Set<string>();

  /** Set when the progress stream has already carried this run's failure. */
  let failureReported = false;

  try {
    for (const student of students) {
      if (options.signal?.aborted) {
        result.stopped = true;
        break;
      }
      onProgress({
        phase: 'listing',
        student: student.fullName,
        message: `Looking for ${student.fullName}'s photos`,
        ...counts(result),
      });

      // Incremental: stop paging once we reach posts older than the last complete walk.
      const through = walked[student.id];
      const cutOff = config.incremental && through ? new Date(through) : undefined;
      const walk: Walk = {
        client,
        student,
        listing: { stopBefore: cutOff },
        refreshed: new Map(),
        presumedExpired: new Set(),
      };
      let newest = cutOff;
      /**
       * When this child's walk began, and the ceiling on the cut-off it may leave behind.
       *
       * The cut-off is a maximum over dates the feed supplies, and nothing in the API says
       * they are sane. One post dated in the future — a teacher's phone with the year set
       * wrong, a typo in a date field — becomes a floor that no real post can ever beat,
       * and from then on every incremental run reads three pages, decides the whole feed
       * is older than the cut-off, and stops. Silently: the run says it finished, and the
       * photographs it never looked at are simply never saved. Clamping to the moment the
       * walk started costs nothing in the ordinary case, where every post is older than
       * now anyway.
       */
      const walkStarted = new Date();
      /** Posts dated later than this run, which is not a thing that should happen. */
      let futureDated = 0;
      /** Failures this run could cure by trying again. Only these hold the cut-off back. */
      let worthRetrying = 0;
      /** The walk hit its page limit: it has not seen the end of this child's feed. */
      let truncated = false;
      /** How many pages it did read, for a message that says where it stopped. */
      let pagesRead = 0;

      for await (const page of client.activityPages(student.id, walk.listing)) {
        pagesRead = page.page + 1;
        // A walk cut short by the page limit looks exactly like a finished one from here,
        // which is why the page says so: without this the cut-off would move over posts
        // this run never listed, and no later run would ever go back for them.
        if (page.truncated) truncated = true;
        // Also checked here, not only in the item loop below: a page carrying no media
        // (a day of nothing but check-ins) never enters that loop, so without this a stop
        // would go unnoticed while the walk kept listing pages.
        if (options.signal?.aborted) {
          result.stopped = true;
          break;
        }

        const seen = { posts: page.posts ?? undefined, examined: page.examined };
        onProgress({
          phase: 'listing',
          student: student.fullName,
          message:
            `Looked through ${page.examined}${page.posts === null ? '' : ` of ${page.posts}`} ` +
            `updates for ${student.fullName}`,
          ...counts(result),
          ...seen,
        });

        for (const activity of page.items) {
          // Asked to stop: the download in flight has finished, and the next one never
          // starts. Checked here rather than mid-download so that no file is left partly
          // written and every byte already fetched is recorded below.
          if (options.signal?.aborted) {
            result.stopped = true;
            break;
          }

          if (!newest || activity.postedAt > newest) newest = activity.postedAt;
          // A day's grace: a clock a few minutes ahead, or a timezone read the other way,
          // is not worth remarking on. A post dated next year is.
          if (activity.postedAt.getTime() > walkStarted.getTime() + 24 * 3600 * 1000) futureDated += 1;

          if (manifest.has({ sourceId: `brightwheel:${activity.id}`, url: activity.url })) {
            result.skipped += 1;
            continue;
          }

          const rel = folderFor(config, student, activity.postedAt);
          const dir = join(config.archiveDir, rel);
          const { stem, ext } = nameFor(activity, extensionOf(activity.url, activity.kind));
          // What the file will most likely be called, for a message about a folder that is
          // refused before there is a list of the names already in it.
          let filename = uniqueName(stem, ext, new Set());

          try {
            if (!seenFolders.has(dir)) {
              // Checked before mkdir, which would otherwise create folders inside a link's
              // target, and again after it, for a link made in between. See realFolderUnder.
              const refused = new FolderOutsideArchiveError(rel);
              if (!(await realFolderUnder(config.archiveDir, rel, { notYet: true }))) throw refused;
              await mkdir(dir, { recursive: true, mode: ARCHIVE_DIR_MODE });
              if (!(await realFolderUnder(config.archiveDir, rel))) throw refused;
              await writeWeekReadme(dir, activity.postedAt, student.fullName);
              seenFolders.add(dir);
              const existing = await readdir(dir).catch(() => [] as string[]);
              takenByFolder.set(dir, new Set(existing.map((f) => f.toLowerCase())));
            }
            const taken = takenByFolder.get(dir)!;
            filename = uniqueName(stem, ext, taken);
            const target = join(dir, filename);

            onProgress({
              phase: 'downloading',
              student: student.fullName,
              message: `Saving ${filename}`,
              ...counts(result),
              ...seen,
            });

            const saved = await saveStaged(dir, filename, async (staged) => {
              const dl = await fetchMedia(walk, page, activity, staged);
              const metadata = await applyMetadata({
                filePath: staged,
                activity,
                student,
                tagChildName: config.tagChildName,
                tagNote: config.tagNote,
                stripLocation: config.stripLocation,
                writeSidecar: config.writeSidecar,
              });
              // Hashed after the tags go in, not before: embedding rewrites the file, so a
              // hash taken on the way past describes a file that no longer exists and can
              // never be used to check the archive. This one is the file as it is placed.
              return { dl, metadata, sha256: await hashFile(staged) };
            });
            const { dl, metadata, sha256 } = saved;
            taken.add(filename.toLowerCase());

            // Either failure is worth telling the person about: the tags not going into
            // the file, or the .xmp sidecar they asked for not being written. Reporting
            // only the first would make a failed sidecar silent.
            if ((!metadata.embedded || metadata.xmpSidecar === false) && metadata.reason && result.warnings.length < 3) {
              result.warnings.push(metadata.reason.split(saved.staging).join(dir));
            }
            if (saved.xmpNotPlaced && result.warnings.length < 3) result.warnings.push(saved.xmpNotPlaced);

            manifest.add({
              path: archivePath(rel, filename),
              sourceId: `brightwheel:${activity.id}`,
              transferId: dl.url,
              bytes: dl.bytes,
              sha256,
              etag: dl.validators.etag ?? null,
              lastModified: dl.validators.lastModified ?? null,
              provenance: {
                postedAt: activity.postedAt.toISOString(),
                // Which clock decided the folder and the filename. postedAt is an
                // instant; the day it belongs to is not, and this is the answer this run
                // used. See `archiveTimezone`.
                filedInTimezone: timezone,
                studentId: student.id,
                studentName: student.fullName,
                note: activity.note,
                author: activity.author,
                kind: activity.kind,
              },
            });
            result.saved += 1;

            // Persist as we go: a run interrupted after 400 photos should not redo them.
            if (result.saved % 25 === 0) await manifest.save();
          } catch (error) {
            // A dead session or a broken API is the run's problem, not this item's: no later
            // item can do better, and each further attempt is a request Brightwheel may
            // count against the account. A refused download or a full disk is this item's.
            if (error instanceof Error && (error.name === 'SessionExpiredError' || error.name === 'ApiShapeError')) {
              throw error;
            }
            result.failed += 1;
            const message = error instanceof Error ? error.message : String(error);
            if (isGone(error)) {
              // Written down rather than retried for ever. The reason is the status alone:
              // the fuller message carries the media URL, and a signed URL is a credential.
              gone[`brightwheel:${activity.id}`] = {
                reason: `HTTP ${(error as DownloadError).status}`,
                at: new Date().toISOString(),
              };
              if (result.warnings.length < 8) {
                result.warnings.push(
                  `${filename}: Brightwheel no longer has this one, so it cannot be saved. ` +
                    `It is noted in archive.json and will not hold up later runs.`,
                );
              }
            } else {
              worthRetrying += 1;
              if (result.warnings.length < 8) result.warnings.push(`${filename}: ${message}`);
            }
          }
        }
        if (result.stopped) break;
      }

      // A walk that ran out of pages has seen the newest posts and nothing older, exactly
      // like one that was interrupted, so it says so rather than passing for a full pass.
      if (truncated) {
        result.warnings.push(
          `${student.fullName}'s feed is longer than this tool reads in one go: it stopped after ` +
            `${pagesRead} pages, before the oldest posts. Everything it reached is saved, and it has ` +
            `not written that feed down as finished, so nothing has been quietly skipped — but running ` +
            `again will stop in the same place. Please report this; reaching the rest needs a change to the tool.`,
        );
      }

      // Only a walk that reached the end with nothing left behind may move the cut-off; an
      // item that failed in a way a retry could cure stays inside the window so that the
      // next run really does retry it, and a walk stopped part-way — or cut short by the
      // page limit — is the same case: it holds the newest posts and nothing older, so its
      // newest post is not a floor the next run may stand on. An item Brightwheel no longer
      // has is the exception, because no run can cure it; it is written down instead.
      if (!result.stopped && !truncated && newest && worthRetrying === 0) {
        // Never later than the moment this walk began: see `walkStarted`.
        walked[student.id] = (newest > walkStarted ? walkStarted : newest).toISOString();
      }
      if (futureDated > 0 && result.warnings.length < 8) {
        result.warnings.push(
          `${student.fullName}: ${futureDated} post${futureDated === 1 ? ' is' : 's are'} dated in the future, ` +
            `which usually means a camera or a computer with its clock set wrong. ${futureDated === 1 ? 'It has' : 'They have'} been saved, ` +
            `filed under the date given, and ${futureDated === 1 ? 'it has' : 'they have'} not been allowed to make later runs skip anything.`,
        );
      }
      if (result.stopped) break;
    }
  } catch (error) {
    // Say so on the progress stream as well, with the counts intact: a polling UI must see
    // the real state rather than a bar that has merely stopped moving.
    const reason = error instanceof Error ? error.message : String(error);
    const kept =
      result.saved > 0
        ? ` The ${result.saved} item${result.saved === 1 ? ' saved before this is' : 's saved before this are'} kept; the next run carries on from there.`
        : '';
    failureReported = true;
    onProgress({ phase: 'error', message: `${reason}${kept}`, ...counts(result) });
    throw error;
  } finally {
    // Whatever happened above — a session that expired on page three, a disk that filled
    // up — what was downloaded is recorded before anything else. Without this, a run that
    // died halfway discarded up to 25 downloaded items and every later run fetched them again.
    try {
      await manifest.save();
    } catch (error) {
      // The manifest is the memory of what has been saved, so failing to write it is the
      // run failing, not a footnote: the next run would fetch all of it again. It reaches
      // the progress stream like any other failure, or a polling UI sits on the last
      // "Saving…" line for ever. It does not replace an earlier failure as the thrown
      // error, though — that one is what explains this one.
      const reason = error instanceof Error ? error.message : String(error);
      onProgress({
        phase: 'error',
        message: `The list of what has been saved could not be written: ${reason}`,
        ...counts(result),
      });
      if (!failureReported) throw error;
    } finally {
      await closeMetadata();
    }
  }

  if (result.stopped) {
    onProgress({
      phase: 'stopped',
      message: `Stopped. ${result.saved} item(s) saved so far are kept; run again to carry on where it left off.`,
      ...counts(result),
    });
    return result;
  }

  onProgress({
    phase: 'done',
    message: `Saved ${result.saved} new item${result.saved === 1 ? '' : 's'}`,
    ...counts(result),
  });
  return result;
}

function counts(r: SyncResult) {
  return { saved: r.saved, skipped: r.skipped, failed: r.failed };
}
