import { readFile, stat } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { MANIFEST_FILENAME, type ManifestRecord } from './ferry/index.js';
import type { Config } from './config.js';

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
  /** The child's folder and the file, for a caption. Not an absolute path. */
  label: string;
  /** ISO 8601, the posted time. */
  postedAt: string | null;
  note: string | null;
  child: string | null;
  bytes: number;
  kind: 'image' | 'video';
}

export interface ArchiveSummary {
  /** Every file the manifest lists, across every run this archive has ever had. */
  totalFiles: number;
  totalBytes: number;
  /** The most recent posted time in the archive, which is how fresh it really is. */
  newestPostedAt: string | null;
  /** The files the most recent run added, newest first. */
  recent: GalleryItem[];
  /** How many the most recent run added, which is `recent.length` before the display cap. */
  lastRunCount: number;
  /** When the archive was last added to. Null for an archive that has never had a run. */
  lastSavedAt: string | null;
}

const VIDEO = /\.(mp4|mov|m4v)$/i;

async function records(config: Config): Promise<ManifestRecord[]> {
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
 * The most recent run's files, and what the archive holds in total.
 *
 * "The most recent run" is taken from `downloadedAt` rather than from a run id, because the
 * manifest has never recorded one and inventing one now would make every archive written
 * before today look like it had no runs at all. Files saved within a few minutes of the
 * newest one are the same run — a run takes minutes, and the next one is a day later.
 */
export async function summarise(config: Config, limit = 12): Promise<ArchiveSummary> {
  const all = await records(config);
  const withTime = all
    .map((r) => ({ r, at: Date.parse(r.downloadedAt ?? '') }))
    .filter((x) => Number.isFinite(x.at))
    .sort((a, b) => b.at - a.at);

  const lastSavedAt = withTime[0]?.at ?? null;
  // A run is a burst. Ninety minutes is longer than any first run this tool has taken and
  // far shorter than the gap to the next day's.
  const WINDOW = 90 * 60 * 1000;
  const sameRun = lastSavedAt === null ? [] : withTime.filter((x) => lastSavedAt - x.at <= WINDOW);

  const postedTimes = all
    .map((r) => (r.provenance as { postedAt?: string } | undefined)?.postedAt)
    .filter((s): s is string => typeof s === 'string')
    .sort();

  return {
    totalFiles: all.length,
    totalBytes: all.reduce((sum, r) => sum + (r.bytes ?? 0), 0),
    newestPostedAt: postedTimes.at(-1) ?? null,
    lastRunCount: sameRun.length,
    lastSavedAt: lastSavedAt === null ? null : new Date(lastSavedAt).toISOString(),
    recent: sameRun.slice(0, limit).map((x) => {
      const p = (x.r.provenance ?? {}) as { postedAt?: string; note?: string; studentName?: string; kind?: string };
      const parts = x.r.path.split(posix.sep);
      return {
        id: all.indexOf(x.r),
        label: parts.at(-1) ?? x.r.path,
        postedAt: p.postedAt ?? null,
        note: p.note ?? null,
        child: p.studentName ?? parts[0] ?? null,
        bytes: x.r.bytes ?? 0,
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
export async function photoAt(config: Config, id: unknown): Promise<{ path: string; bytes: number; type: string } | null> {
  const index = typeof id === 'string' ? Number(id) : typeof id === 'number' ? id : NaN;
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
