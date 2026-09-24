import { readFile, stat } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { MANIFEST_FILENAME, type ManifestRecord } from './ferry/index.js';
import type { Config } from './config.js';
import { walkArchive } from './maintenance.js';
import { formatBytes } from './units.js';

/**
 * What the setup page shows once there is nothing left to set up.
 *
 * The page's job changes after the first successful run. Until then it is a form: connect,
 * choose, save, schedule. Afterwards it is an answer to one question a parent will ask
 * every few weeks — "is this still working?" — and the honest answer is a picture of what
 * arrived, not a green tick. A tick can be true while the archive has been empty since
 * March; twelve thumbnails cannot.
 *
 * Everything here reads `archive.json` and the files beside it. Nothing here touches the
 * network, and nothing here is reachable without the setup token.
 */

/** One photo, as the dashboard needs it. Never a path the browser could ask for directly. */
export interface GalleryItem {
  /** Index into the manifest's records. The only handle the page is given — see `photoAt`. */
  id: number;
  /** The file's name, for the thumbnail's tooltip. Not a path. */
  label: string;
  /** ISO 8601, the posted time. */
  postedAt: string | null;
  child: string | null;
  kind: 'image' | 'video';
}

export interface ArchiveSummary {
  /** Every file the manifest lists, across every run this archive has ever had. */
  totalFiles: number;
  /**
   * The whole folder on disk — photos, the small files beside them, the tool's own list —
   * which is what the folder check reports and what Finder, Files or Explorer shows for it.
   */
  totalBytes: number;
  /** totalBytes, written the way this computer's file manager writes it. */
  totalSize: string;
  /** The most recent posted time in the archive, which is how fresh it really is. */
  newestPostedAt: string | null;
  /** One page of the files the most recent run added, newest first. */
  recent: GalleryItem[];
  /** How many the most recent run added — every page of them, not only this one. */
  lastRunCount: number;
  /** Which page `recent` is, from 0, and how many there are. At least one, even when empty. */
  page: number;
  pages: number;
  pageSize: number;
  /** When the archive was last added to. Null for an archive that has never had a run. */
  lastSavedAt: string | null;
}

const VIDEO = /\.(mp4|mov|m4v)$/i;

/** Thumbnails to a page: three rows of eight on a wide screen, which fits the one-screen budget. */
export const GALLERY_PAGE_SIZE = 24;

/**
 * The longest pause between two saves that still counts as one run.
 *
 * A run saves files back to back, seconds apart; the slowest thing inside one is a retry,
 * which waits at most thirty seconds, or a Retry-After, which in practice is a minute or
 * two. The next run is a day later — or, when somebody presses "Save new photos" twice,
 * minutes later, and then the two are shown together, which is what they look like to the
 * person who pressed it.
 */
const RUN_GAP = 30 * 60 * 1000;

/** Every record in the archive's manifest, or none when there is no manifest it can read. */
export async function records(config: Config): Promise<ManifestRecord[]> {
  try {
    const raw = await readFile(join(config.archiveDir, MANIFEST_FILENAME), 'utf8');
    // The array is `files` on disk. The type is called ManifestRecord, which is not the
    // same thing — reading the interface rather than an actual archive.json is how the
    // first version of this returned an empty gallery from a manifest with ten files in it.
    const data = JSON.parse(raw) as { files?: ManifestRecord[] };
    return Array.isArray(data.files) ? data.files : [];
  } catch {
    // No archive yet, or a manifest this build cannot read. Either way the dashboard shows
    // the empty state rather than an error: "nothing saved yet" is a true answer.
    return [];
  }
}

/**
 * The folder's size, remembered until the tool's list changes.
 *
 * Asked on every poll of the page — every 700ms during a run — and walking a folder of
 * thousands of files each time would be slow on a large archive and slower on a network or
 * iCloud one. The list is rewritten whenever anything is added, so its time and size are a
 * cheap, reliable sign that the folder may have changed.
 */
let folderSize: { root: string; stamp: string; bytes: number } | null = null;

async function sizeOnDisk(root: string): Promise<number> {
  const info = await stat(join(root, MANIFEST_FILENAME)).catch(() => null);
  const stamp = info ? `${info.mtimeMs}:${info.size}` : 'none';
  if (folderSize && folderSize.root === root && folderSize.stamp === stamp) return folderSize.bytes;
  const bytes = (await walkArchive(root)).reduce((sum, f) => sum + f.bytes, 0);
  folderSize = { root, stamp, bytes };
  return bytes;
}

/**
 * The most recent run's files, a page at a time, and what the archive holds in total.
 *
 * "The most recent run" is taken from `downloadedAt` rather than from a run id, because the
 * manifest has never recorded one and inventing one now would make every archive written
 * before today look like it had no runs at all. A run is a burst: starting from the newest
 * file, every file saved within RUN_GAP of the one after it belongs to the same run. (This
 * used to be a fixed ninety minutes from the newest file, which cut the start off any first
 * run that took longer than that — and the dashboard now shows all of a run, so it would
 * have shown.)
 */
export async function summarise(
  config: Config,
  options: { page?: number } = {},
): Promise<ArchiveSummary> {
  const all = await records(config);
  const totalBytes = all.length === 0 ? 0 : await sizeOnDisk(config.archiveDir);
  const withTime = all
    .map((r, index) => ({ r, index, at: Date.parse(r.downloadedAt ?? '') }))
    .filter((x) => Number.isFinite(x.at))
    .sort((a, b) => b.at - a.at);

  const lastSavedAt = withTime[0]?.at ?? null;
  let runLength = withTime.length === 0 ? 0 : 1;
  while (runLength < withTime.length && withTime[runLength - 1]!.at - withTime[runLength]!.at <= RUN_GAP) runLength++;
  const sameRun = withTime.slice(0, runLength);

  const pageSize = GALLERY_PAGE_SIZE;
  const pages = Math.max(1, Math.ceil(sameRun.length / pageSize));
  const asked = Math.floor(Number(options.page ?? 0));
  const page = Number.isFinite(asked) ? Math.min(Math.max(asked, 0), pages - 1) : 0;

  const postedTimes = all
    .map((r) => (r.provenance as { postedAt?: string } | undefined)?.postedAt)
    .filter((s): s is string => typeof s === 'string')
    .sort();

  return {
    totalFiles: all.length,
    totalBytes,
    totalSize: formatBytes(totalBytes),
    newestPostedAt: postedTimes.at(-1) ?? null,
    lastRunCount: sameRun.length,
    lastSavedAt: lastSavedAt === null ? null : new Date(lastSavedAt).toISOString(),
    page,
    pages,
    pageSize,
    recent: sameRun.slice(page * pageSize, (page + 1) * pageSize).map((x) => {
      const p = (x.r.provenance ?? {}) as { postedAt?: string; studentName?: string; kind?: string };
      const parts = x.r.path.split(posix.sep);
      return {
        id: x.index,
        label: parts.at(-1) ?? x.r.path,
        postedAt: p.postedAt ?? null,
        child: p.studentName ?? parts[0] ?? null,
        kind: p.kind === 'video' || VIDEO.test(x.r.path) ? 'video' : 'image',
      };
    }),
  };
}

/**
 * Turn an index the page was given back into a file on disk, or refuse.
 *
 * This is the whole security of the photo route, so it is one function and it is narrow.
 * The browser never names a path: it names a number, and a number can only ever resolve to
 * something the manifest already lists. There is no traversal to defend against because
 * there is no caller-supplied path to traverse with, and a manifest entry is by
 * construction a file this tool wrote inside the archive folder.
 *
 * The `startsWith` check is belt to that braces: a manifest edited by hand, or written by
 * a future bug, does not get to make this serve `/etc/passwd`.
 */
export async function photoAt(config: Config, id: string | null): Promise<{ path: string; bytes: number; type: string } | null> {
  const index = typeof id === 'string' ? Number(id) : NaN;
  if (!Number.isInteger(index) || index < 0) return null;

  const all = await records(config);
  const record = all[index];
  if (!record || typeof record.path !== 'string') return null;

  const root = config.archiveDir;
  const absolute = join(root, ...record.path.split(posix.sep));
  if (!absolute.startsWith(root.endsWith('/') ? root : `${root}/`)) return null;

  const info = await stat(absolute).catch(() => null);
  if (!info?.isFile()) return null;

  const ext = (record.path.split('.').pop() ?? '').toLowerCase();
  const type =
    ext === 'png' ? 'image/png'
    : ext === 'heic' ? 'image/heic'
    : ext === 'mp4' || ext === 'm4v' ? 'video/mp4'
    : ext === 'mov' ? 'video/quicktime'
    : 'image/jpeg';
  return { path: absolute, bytes: info.size, type };
}
