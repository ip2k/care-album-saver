import { mkdir, readdir, writeFile } from 'node:fs/promises';
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
} from 'media-ferry';
import type { ActivityListOptions, ActivityPage, BrightwheelClient } from './api/client.js';
import type { MediaActivity, Student } from './api/schema.js';
import type { Config } from './config.js';
import { applyMetadata, closeMetadata } from './metadata.js';
import { ARCHIVE_DIR_MODE, checkArchiveDir } from './safety.js';

export interface SyncProgress {
  /**
   * `stopped` is the end of a run that was asked to stop (see `sync`'s `signal`): it is a
   * normal ending, not a failure, and it is the last event such a run emits.
   */
  phase: 'starting' | 'listing' | 'downloading' | 'done' | 'error' | 'stopped';
  student?: string;
  message: string;
  saved: number;
  skipped: number;
  failed: number;
  /**
   * How many items this run will handle, when that is knowable. It is not: Brightwheel's
   * `count` is posts of every kind — check-ins, naps and meals as well as photos — and an
   * incremental run stops early. A number here would turn into an invented percentage in
   * the UI, so it stays undefined and the honest measures are `posts` and `examined`.
   */
  total?: number;
  /** Posts of every kind on the current child's feed, as Brightwheel counts them. */
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
 * Filename stem: date, time and a short id.
 *
 * The id suffix is not decoration. Two photos taken in the same second by the same teacher
 * are common (burst shots), and without a stable discriminator they would collide and the
 * collision counter would renumber them differently on every run — so a re-run would look
 * like new files. Embedding Brightwheel's own id makes the name deterministic.
 */
function nameFor(activity: MediaActivity, ext: string): { stem: string; ext: string } {
  const d = activity.capturedAt;
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const shortId = activity.id.replace(/[^a-zA-Z0-9]/g, '').slice(-8);
  return { stem: `${stamp}_${shortId}`, ext };
}

function extensionOf(url: string, kind: 'image' | 'video'): string {
  try {
    const path = new URL(url).pathname;
    const m = path.match(/\.([a-zA-Z0-9]{2,5})$/);
    if (m?.[1]) return m[1];
  } catch {
    /* fall through */
  }
  return kind === 'video' ? 'mp4' : 'jpg';
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
    'Each file has a matching `.json` file next to it with the date it was taken,',
    'who posted it and any note the teacher wrote.',
    '',
    'Saved by brightwheel-archive. These files are yours; nothing here phones home.',
    '',
  ].join('\n');
  await writeFile(join(dir, 'README.md'), body, 'utf8');
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
const hasExpired = (url: string) => {
  const expiry = signedUrlExpiry(url);
  return expiry !== null && expiry.getTime() <= Date.now();
};

/**
 * Download one item, surviving an expired signature.
 *
 * Media URLs are signed and short-lived (docs/QUESTIONS-FOR-FABLE.md, B3). A long run —
 * a first archive of years of photos, videos over a slow connection — outlives the ones on
 * its early pages, and the CDN then refuses a file that is perfectly available. The remedy
 * is to ask for the listing page again, which carries fresh signatures, and try that URL.
 *
 * Bounded on purpose: this item re-fetches its page at most once, and never requests the
 * same URL twice. A refusal that survives all of that is something other than expiry, and
 * the item is left for the next run rather than hammered. A refusal counts, a network error
 * does not — that is the caller's problem to report as it is.
 *
 * Bounded twice over, because `expires=` is a guess. Not every CDN means "Unix time" by it;
 * one that means "seconds of life" reads as 1970 and so as permanently expired, which would
 * buy a fresh listing page for every item on the page and get the same unreadable parameter
 * back each time. So a page may be re-fetched on the strength of a declared expiry once per
 * run — after that its URLs are treated as final and the CDN, which is the only authority
 * on the matter, gets to answer. A real refusal still buys the one re-fetch per item.
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

  // Refuse outright rather than quietly archiving to a folder the OS will empty.
  const verdict = checkArchiveDir(config.archiveDir, { allowTemporary: options.allowTemporaryDir });
  if (!verdict.ok) throw new Error(verdict.error);
  if (verdict.warning) result.warnings.push(verdict.warning);

  // 0700, not the default 0755. These are identified photographs of a child — every file
  // carries the child's name in its metadata — so other accounts on a shared family
  // computer must not be able to read them.
  await mkdir(config.archiveDir, { recursive: true, mode: ARCHIVE_DIR_MODE });
  const manifest = await Manifest.open(config.archiveDir, 'brightwheel');
  const walked = walkedThrough(manifest);

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
      const failedBefore = result.failed;

      for await (const page of client.activityPages(student.id, walk.listing)) {
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

          if (!newest || activity.capturedAt > newest) newest = activity.capturedAt;

          if (manifest.has({ sourceId: `brightwheel:${activity.id}`, url: activity.url })) {
            result.skipped += 1;
            continue;
          }

          const rel = folderFor(config, student, activity.capturedAt);
          const dir = join(config.archiveDir, rel);
          if (!seenFolders.has(dir)) {
            await mkdir(dir, { recursive: true, mode: ARCHIVE_DIR_MODE });
            await writeWeekReadme(dir, activity.capturedAt, student.fullName);
            seenFolders.add(dir);
            const existing = await readdir(dir).catch(() => [] as string[]);
            takenByFolder.set(dir, new Set(existing.map((f) => f.toLowerCase())));
          }
          const taken = takenByFolder.get(dir)!;

          const { stem, ext } = nameFor(activity, extensionOf(activity.url, activity.kind));
          const filename = uniqueName(stem, ext, taken);
          const target = join(dir, filename);

          onProgress({
            phase: 'downloading',
            student: student.fullName,
            message: `Saving ${filename}`,
            ...counts(result),
            ...seen,
          });

          try {
            const dl = await fetchMedia(walk, page, activity, target);
            taken.add(filename.toLowerCase());

            const sha256 = await hashFile(target);

            const metadata = await applyMetadata({
              filePath: target,
              activity,
              student,
              tagChildName: config.tagChildName,
              tagNote: config.tagNote,
              stripLocation: config.stripLocation,
              writeSidecar: config.writeSidecar,
            });
            if (!metadata.embedded && metadata.reason && result.warnings.length < 3) {
              result.warnings.push(metadata.reason);
            }

            manifest.add({
              path: archivePath(rel, filename),
              sourceId: `brightwheel:${activity.id}`,
              transferId: dl.url,
              bytes: dl.bytes,
              sha256,
              etag: dl.validators.etag ?? null,
              lastModified: dl.validators.lastModified ?? null,
              provenance: {
                capturedAt: activity.capturedAt.toISOString(),
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
            if (result.warnings.length < 8) result.warnings.push(`${filename}: ${message}`);
          }
        }
        if (result.stopped) break;
      }

      // Only a walk that reached the end with nothing left behind may move the cut-off; a
      // failed item stays inside the window so that the next run really does retry it, and
      // a walk stopped part-way is the same case — it holds the newest posts and nothing
      // older, so its newest post is not a floor the next run may stand on.
      if (!result.stopped && newest && result.failed === failedBefore) {
        walked[student.id] = newest.toISOString();
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
