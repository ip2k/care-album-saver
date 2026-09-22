import { execFile } from 'node:child_process';
import { readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { platform as osPlatform } from 'node:os';
import { join, posix, relative, sep } from 'node:path';
import { Manifest, MANIFEST_FILENAME, hashFile, type ManifestRecord } from 'media-ferry';
import type { BrightwheelClient } from './api/client.js';
import type { Config } from './config.js';

/**
 * Looking after an archive that has been running for a year.
 *
 * Setting the tool up is one evening; living with it is everything after. Three things go
 * wrong slowly enough that nobody notices, and each has an action here:
 *
 *  1. The account changes. A sibling starts nursery, an older child leaves. A run that was
 *     told "these two children" keeps saving those two for ever and says nothing about the
 *     third.
 *  2. The archive and its own list drift apart. A run force-quit between the download and
 *     the manifest save leaves a file nobody recorded; a folder tidied up by hand leaves a
 *     record whose file is gone.
 *  3. The same photo ends up on disk twice, for the reason above: the next run does not
 *     know it has it, so it fetches it again under a new name.
 *
 * Every function here reports before it changes anything, and the one that deletes refuses
 * to act on anything the caller has not named back. These are photographs of a child; being
 * clever with them is not a thing this tool gets to do.
 */

/** Files that belong to the archive itself rather than to any photo. */
const ARCHIVE_FILES = new Set([MANIFEST_FILENAME, `${MANIFEST_FILENAME}.tmp`, 'README.md']);

/** Archive-relative path, forward slashes on every platform — the manifest's own spelling. */
const relPath = (root: string, absolute: string): string => relative(root, absolute).split(sep).join(posix.sep);

interface DiskFile {
  rel: string;
  absolute: string;
  bytes: number;
}

/** Every file under the archive root, with its size. Directories are walked, not reported. */
async function walkArchive(root: string): Promise<DiskFile[]> {
  const found: DiskFile[] = [];
  const visit = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      // A folder that vanished mid-walk, or one this account cannot open. Neither is worth
      // failing a read-only report over.
      return;
    }
    for (const entry of entries) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const info = await stat(absolute).catch(() => null);
      if (!info) continue;
      found.push({ rel: relPath(root, absolute), absolute, bytes: info.size });
    }
  };
  await visit(root);
  return found;
}

/**
 * Whether a file is one this tool wrote *about* a photo rather than a photo.
 *
 * The `.json` and `.xmp` files are named after the file they describe — `photo.jpg.json` —
 * and they are recognised by that shape rather than by their subject still being on disk.
 * Recognising them by their subject was the first attempt and it was wrong in a way that
 * mattered: a note left behind by a photo deleted in Finder was then reported as an
 * unrecorded *photo*, and the repair below duly wrote it into the manifest as one, so the
 * archive's own list claimed to hold a photograph that was a paragraph of JSON.
 *
 * A lone `notes.json` that was never named after anything is not a companion, and is
 * reported like any other file the tool does not recognise.
 */
function isCompanion(rel: string): boolean {
  return /\.[A-Za-z0-9]{1,8}\.(json|xmp)$/i.test(rel);
}

function isArchiveOwnFile(rel: string): boolean {
  const name = rel.slice(rel.lastIndexOf(posix.sep) + 1);
  return ARCHIVE_FILES.has(name) || name.startsWith('.');
}

/** Bytes as a parent would say them: "1.2 GB", not "1288490188". */
export function humanBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} bytes`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

// ------------------------------------------------------------------ the manifest, for writing

/**
 * The manifest as a plain object, so records can be added and removed.
 *
 * `Manifest` is built for the run — it adds and looks up, and deliberately has no way to
 * take a record away, because nothing in a run should ever want one. Maintenance does, so
 * it works on the file's own JSON instead. Everything but `files` is copied through
 * untouched: the schema number, the source, the notes a reader years from now will need,
 * and the walk state that decides where the next run starts.
 *
 * `Manifest.open` is still called first, and its refusal is still the refusal: it is the
 * one place that knows which manifests are unusable, and rebuilding that judgement here
 * would be a second opinion that could disagree with the run's.
 */
async function readManifestJson(archiveDir: string): Promise<{ data: Record<string, unknown>; records: ManifestRecord[] }> {
  await Manifest.open(archiveDir, 'brightwheel', { fileMode: 0o600 });
  const file = join(archiveDir, MANIFEST_FILENAME);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    // No manifest yet: an archive nothing has ever been saved into.
    return { data: {}, records: [] };
  }
  const data = JSON.parse(raw) as Record<string, unknown>;
  const records = Array.isArray(data.files) ? (data.files as ManifestRecord[]) : [];
  return { data, records };
}

/** Write the manifest back, atomically and owner-only, exactly as the run would. */
async function writeManifestJson(archiveDir: string, data: Record<string, unknown>, records: ManifestRecord[]): Promise<void> {
  const target = join(archiveDir, MANIFEST_FILENAME);
  const temp = `${target}.tmp`;
  const payload = { ...data, files: records, updatedAt: new Date().toISOString() };
  await writeFile(temp, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
  await rename(temp, target);
}

// ------------------------------------------------------------------ 1. who is on the account

export interface ChildRow {
  id: string;
  name: string;
}

export interface ChildCheck {
  /** Children Brightwheel says are on the account right now. */
  onAccount: ChildRow[];
  /** Children this archive already holds photos of, per the manifest. */
  inArchive: ChildRow[];
  /** On the account, nothing saved for them yet. */
  added: ChildRow[];
  /** In the archive, no longer on the account. */
  removed: ChildRow[];
  /** On the account but excluded by the saved settings — the ones worth offering. */
  notIncluded: ChildRow[];
  summary: string;
}

/**
 * Ask Brightwheel who is on the account now and compare that with the archive.
 *
 * The comparison is against what has actually been saved, not against the settings: a
 * child ticked but never run for is not "in the archive", and saying otherwise would hide
 * the thing worth knowing.
 */
export async function checkChildren(client: BrightwheelClient, config: Config): Promise<ChildCheck> {
  const me = await client.me();
  const live = await client.students(me.id);
  const onAccount: ChildRow[] = live.map((s) => ({ id: s.id, name: s.fullName }));

  const { records } = await readManifestJson(config.archiveDir);
  const seen = new Map<string, string>();
  for (const record of records) {
    const provenance = (record.provenance ?? {}) as Record<string, unknown>;
    const id = typeof provenance.studentId === 'string' ? provenance.studentId : null;
    const name = typeof provenance.studentName === 'string' ? provenance.studentName : null;
    if (id && !seen.has(id)) seen.set(id, name ?? id);
  }
  const inArchive: ChildRow[] = [...seen].map(([id, name]) => ({ id, name }));

  const archived = new Set(seen.keys());
  const liveIds = new Set(onAccount.map((c) => c.id));
  const added = onAccount.filter((c) => !archived.has(c.id));
  const removed = inArchive.filter((c) => !liveIds.has(c.id));
  // An empty list in the settings means every child, so nobody is excluded by it.
  const notIncluded =
    config.includeStudents.length === 0 ? [] : onAccount.filter((c) => !config.includeStudents.includes(c.id));

  const parts: string[] = [];
  if (added.length > 0) {
    parts.push(
      `${list(added.map((c) => c.name))} ${added.length === 1 ? 'is on the account and has' : 'are on the account and have'} ` +
        `no photos saved yet.`,
    );
  }
  if (removed.length > 0) {
    parts.push(
      `${list(removed.map((c) => c.name))} ${removed.length === 1 ? 'is' : 'are'} no longer on the Brightwheel account. ` +
        `The photos already saved are untouched and stay exactly where they are; there will simply be no new ones.`,
    );
  }
  if (notIncluded.length > 0) {
    parts.push(`Your settings currently leave out ${list(notIncluded.map((c) => c.name))}.`);
  }
  if (parts.length === 0) {
    parts.push(
      `Nothing has changed: ${list(onAccount.map((c) => c.name))} ${onAccount.length === 1 ? 'is' : 'are'} on the account, ` +
        `and that is who photos are being saved for.`,
    );
  }
  return { onAccount, inArchive, added, removed, notIncluded, summary: parts.join(' ') };
}

/** "Robin", "Robin and Sam", "Robin, Sam and Alex" — never "Robin,Sam". */
function list(names: string[]): string {
  if (names.length === 0) return 'nobody';
  if (names.length === 1) return names[0] as string;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

// ------------------------------------------------------------------ 2. the archive itself

export interface ArchiveAudit {
  archiveDir: string;
  /** Files the manifest lists. */
  recorded: number;
  /** Photos and videos found on disk. Companions and README files are not counted. */
  onDisk: number;
  /** On disk, not in the manifest: the next run would fetch these again. */
  unrecorded: string[];
  /** In the manifest, not on disk: moved, deleted, or on a drive that is not plugged in. */
  missing: string[];
  /** Everything under the archive folder, companions and all. */
  bytesOnDisk: number;
  /** Whether repairing the manifest would change anything. */
  repairable: boolean;
  summary: string;
}

/**
 * Walk what is on disk against what the manifest says, and change nothing.
 *
 * This is a read. A parent pressing "check the archive" is asking a question, and an
 * action that answered it by rewriting the manifest would be a bad surprise — so the repair
 * is a second, separate press.
 */
export async function auditArchive(config: Config): Promise<ArchiveAudit> {
  const root = config.archiveDir;
  const { records } = await readManifestJson(root);
  const files = await walkArchive(root);
  const everything = new Set(files.map((f) => f.rel));
  const media = files.filter((f) => !isArchiveOwnFile(f.rel) && !isCompanion(f.rel));

  const recordedPaths = new Set(records.map((r) => r.path.split('\\').join('/')));
  const unrecorded = media.filter((f) => !recordedPaths.has(f.rel)).map((f) => f.rel).sort();
  const missing = records.filter((r) => !everything.has(r.path.split('\\').join('/'))).map((r) => r.path).sort();
  const bytesOnDisk = files.reduce((sum, f) => sum + f.bytes, 0);

  const parts = [
    `${media.length === 1 ? '1 photo or video' : `${media.length} photos and videos`} on disk, ` +
      `${humanBytes(bytesOnDisk)} in all.`,
  ];
  if (unrecorded.length > 0) {
    parts.push(
      `${unrecorded.length} ${unrecorded.length === 1 ? 'file is' : 'files are'} not on the tool's own list, so the ` +
        `next run would download ${unrecorded.length === 1 ? 'it' : 'them'} a second time.`,
    );
  }
  if (missing.length > 0) {
    parts.push(
      `${missing.length} ${missing.length === 1 ? 'file the list mentions is' : 'files the list mentions are'} not there — ` +
        `moved, deleted, or on a drive that is not plugged in.`,
    );
  }
  if (unrecorded.length === 0 && missing.length === 0) parts.push('Everything matches.');

  return {
    archiveDir: root,
    recorded: records.length,
    onDisk: media.length,
    unrecorded,
    missing,
    bytesOnDisk,
    repairable: unrecorded.length > 0 || missing.length > 0,
    summary: parts.join(' '),
  };
}

export interface RepairResult {
  added: number;
  dropped: number;
  summary: string;
}

/**
 * Bring the manifest back in line with the folder, without downloading anything.
 *
 * Two repairs, and both are only ever about the *list*:
 *
 *  - A file on disk that nothing recorded is added to the list, with its real hash and the
 *    details from the `.json` file the run wrote beside it. The next run then knows it has
 *    it, and stops fetching it again every night.
 *  - A record whose file is gone is dropped from the list. That is not a deletion: the file
 *    is already not there. Dropping it is what lets the next run notice and fetch it back.
 *
 * No photo is written, moved or removed by this. That is the whole reason it can be offered
 * as a single press.
 */
export async function repairManifest(config: Config): Promise<RepairResult> {
  const root = config.archiveDir;
  const audit = await auditArchive(config);
  const { data, records } = await readManifestJson(root);

  const kept = records.filter((r) => !audit.missing.includes(r.path));
  const dropped = records.length - kept.length;

  let added = 0;
  for (const rel of audit.unrecorded) {
    const absolute = join(root, ...rel.split(posix.sep));
    const info = await stat(absolute).catch(() => null);
    if (!info) continue;
    const sidecar = await readSidecar(`${absolute}.json`);
    kept.push({
      path: rel,
      // Brightwheel's own id when the sidecar still has it, which is what lets the next run
      // recognise the post rather than merely the bytes.
      sourceId: sidecar?.brightwheelActivityId ? `brightwheel:${sidecar.brightwheelActivityId}` : null,
      // Deliberately not guessed. The remote URL is not recoverable from disk, and inventing
      // one would make the manifest lie about where the file came from.
      transferId: null,
      bytes: info.size,
      sha256: await hashFile(absolute),
      etag: null,
      lastModified: null,
      // The file's own modification time is the closest honest answer to "when did this
      // arrive": the run that downloaded it never got as far as writing it down.
      downloadedAt: info.mtime.toISOString(),
      provenance: {
        // `capturedAt` is what sidecars written before 2026-09-22 call it. The name was
        // wrong — the field has always held the moment the photo was POSTED, and after
        // checking the live service we know there is no capture time to hold — so both
        // spellings are read and only the true one is written.
        ...(sidecar?.postedAt ?? sidecar?.capturedAt
          ? { postedAt: sidecar.postedAt ?? sidecar.capturedAt }
          : {}),
        ...(sidecar?.child?.id ? { studentId: sidecar.child.id } : {}),
        ...(sidecar?.child?.name ? { studentName: sidecar.child.name } : {}),
        ...(sidecar?.note !== undefined ? { note: sidecar.note } : {}),
        ...(sidecar?.postedBy !== undefined ? { author: sidecar.postedBy } : {}),
        ...(sidecar?.kind ? { kind: sidecar.kind } : {}),
        recoveredBy: 'care-album-saver check-archive',
      },
    });
    added += 1;
  }

  if (added > 0 || dropped > 0) await writeManifestJson(root, data, kept);

  const parts: string[] = [];
  if (added > 0) parts.push(`${added} file${added === 1 ? '' : 's'} already on disk ${added === 1 ? 'is' : 'are'} now on the list, so ${added === 1 ? 'it' : 'they'} will not be downloaded again.`);
  if (dropped > 0) parts.push(`${dropped} entr${dropped === 1 ? 'y' : 'ies'} for ${dropped === 1 ? 'a file' : 'files'} that is not there ${dropped === 1 ? 'was' : 'were'} removed from the list, so the next run will fetch ${dropped === 1 ? 'it' : 'them'} again.`);
  if (parts.length === 0) parts.push('Nothing needed fixing.');
  return { added, dropped, summary: parts.join(' ') };
}

interface Sidecar {
  brightwheelActivityId?: string;
  postedAt?: string;
  /** What `postedAt` was called before 2026-09-22. Read, never written. */
  capturedAt?: string;
  child?: { id?: string; name?: string };
  note?: string | null;
  postedBy?: string | null;
  kind?: string;
}

async function readSidecar(path: string): Promise<Sidecar | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Sidecar;
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ 3. duplicates

export interface DuplicateGroup {
  sha256: string;
  /** The copy that stays. */
  keep: string;
  /** The copies that would go, if the parent says so. */
  extra: string[];
  /** Space the removal would return. */
  bytes: number;
}

export interface DuplicateReport {
  groups: DuplicateGroup[];
  /** How many files would be removed in total. */
  files: number;
  bytes: number;
  /** Files on disk that no manifest record mentions, which this search cannot compare. */
  unrecorded: number;
  summary: string;
}

/**
 * Find photos that are on disk more than once, byte for byte.
 *
 * This is a symptom with one main cause: a run force-quit after a download and before the
 * manifest was written. The file is on disk, nothing recorded it, so the next run fetches
 * it again — under a new name, because the old one is taken. The archive then holds the
 * same photograph twice.
 *
 * Only exact matches count. The hash in the manifest is the hash of the file *as it ended
 * up on disk*, taken after the names and dates were written into it, so two records with
 * the same hash really are the same bytes. Even so, both files are hashed again here before
 * anything is offered for removal: the manifest may be months old, and a photograph is not
 * something to delete on the strength of a stale record.
 *
 * It reports. It never removes: see `removeDuplicates`.
 */
export async function findDuplicates(config: Config): Promise<DuplicateReport> {
  const root = config.archiveDir;
  const { records } = await readManifestJson(root);

  const byHash = new Map<string, ManifestRecord[]>();
  for (const record of records) {
    if (!record.sha256) continue;
    const bucket = byHash.get(record.sha256);
    if (bucket) bucket.push(record);
    else byHash.set(record.sha256, [record]);
  }

  const groups: DuplicateGroup[] = [];
  for (const [sha256, bucket] of byHash) {
    if (bucket.length < 2) continue;
    // Only copies that are really there, and really identical now.
    const present: { rel: string; record: ManifestRecord; bytes: number }[] = [];
    for (const record of bucket) {
      const rel = record.path.split('\\').join('/');
      const absolute = join(root, ...rel.split(posix.sep));
      const info = await stat(absolute).catch(() => null);
      if (!info?.isFile()) continue;
      if ((await hashFile(absolute).catch(() => null)) !== sha256) continue;
      present.push({ rel, record, bytes: info.size });
    }
    if (present.length < 2) continue;

    // Keep the first one saved — the one the rest are copies of — and among equals the
    // first alphabetically, so the answer is the same every time it is asked.
    present.sort((a, b) => {
      const at = Date.parse(a.record.downloadedAt ?? '');
      const bt = Date.parse(b.record.downloadedAt ?? '');
      if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return at - bt;
      return a.rel.localeCompare(b.rel);
    });
    const [keep, ...extra] = present;
    groups.push({
      sha256,
      keep: (keep as { rel: string }).rel,
      extra: extra.map((e) => e.rel),
      bytes: extra.reduce((sum, e) => sum + e.bytes, 0),
    });
  }

  groups.sort((a, b) => a.keep.localeCompare(b.keep));
  const files = groups.reduce((sum, g) => sum + g.extra.length, 0);
  const bytes = groups.reduce((sum, g) => sum + g.bytes, 0);
  const summary =
    files === 0
      ? 'No photo is saved twice. Nothing to tidy up.'
      : `${files} file${files === 1 ? ' is' : 's are'} an exact second copy of ${groups.length === 1 ? 'another photo' : 'photos'} you already have, ` +
        `taking up ${humanBytes(bytes)}. Nothing has been deleted — check the list below first.`;

  /**
   * The blind spot, said out loud.
   *
   * This search compares the manifest against itself: two records, same hash, both files
   * present. A file on disk that no record mentions is invisible to it — and that is
   * precisely the thing it was written for, because the usual cause of a duplicate is a
   * run force-quit after the download and before the manifest was saved. Until the list
   * is repaired, "no duplicates" means "none that I have a record of", which is a
   * different sentence and has to read like one.
   */
  const audit = await auditArchive(config).catch(() => null);
  const blind = audit?.unrecorded.length ?? 0;
  const caveat = blind === 0
    ? ''
    : ` ${blind} file${blind === 1 ? ' is' : 's are'} not on the tool's own list yet, and this search cannot see ` +
      `${blind === 1 ? 'it' : 'them'} — the usual cause of a second copy is exactly that. Repair the list first, then look again.`;

  return { groups, files, bytes, unrecorded: blind, summary: summary + caveat };
}

export interface RemovalResult {
  removed: string[];
  bytes: number;
  summary: string;
}

/**
 * Remove duplicate copies — and only the exact ones the caller has named back.
 *
 * `confirm` is not a flag, it is the list. The caller has to send the same paths the report
 * showed, and every one of them has to still be an extra copy of a photo that is still
 * there, or nothing at all is deleted and the refusal says which path it could not vouch
 * for. A boolean `force` would let a stale page, a double-click or a race delete a file
 * nobody had looked at; a list cannot.
 *
 * The file's `.json` and `.xmp` companions go with it, because they describe the copy that
 * is being removed and would otherwise be left pointing at nothing.
 */
export async function removeDuplicates(config: Config, options: { confirm: string[] }): Promise<RemovalResult> {
  const wanted = [...new Set((options.confirm ?? []).map((p) => String(p).split('\\').join('/')))];
  if (wanted.length === 0) {
    throw new Error('Nothing was named for removal, so nothing was deleted.');
  }

  const report = await findDuplicates(config);
  const removable = new Map<string, DuplicateGroup>();
  for (const group of report.groups) for (const rel of group.extra) removable.set(rel, group);

  const unknown = wanted.filter((rel) => !removable.has(rel));
  if (unknown.length > 0) {
    throw new Error(
      `Nothing was deleted. ${unknown.length === 1 ? 'This file is' : 'These files are'} no longer a second copy of ` +
        `anything: ${unknown.join(', ')}. The archive has changed since that list was made — check it again.`,
    );
  }

  const root = config.archiveDir;
  const { data, records } = await readManifestJson(root);
  const removed: string[] = [];
  let bytes = 0;
  for (const rel of wanted) {
    const absolute = join(root, ...rel.split(posix.sep));
    const info = await stat(absolute).catch(() => null);
    if (!info) continue;
    await rm(absolute, { force: true });
    // The sidecars describe this copy, not the one that stays.
    await rm(`${absolute}.json`, { force: true });
    await rm(`${absolute}.xmp`, { force: true });
    removed.push(rel);
    bytes += info.size;
  }

  const gone = new Set(removed);
  await writeManifestJson(
    root,
    data,
    records.filter((r) => !gone.has(r.path.split('\\').join('/'))),
  );

  return {
    removed,
    bytes,
    summary:
      removed.length === 0
        ? 'Nothing was deleted.'
        : `${removed.length} duplicate${removed.length === 1 ? '' : 's'} removed, freeing ${humanBytes(bytes)}. ` +
          (removed.length === 1
            ? 'The photo it was a copy of is still here.'
            : 'The photos they were copies of are still here.'),
  };
}

// ------------------------------------------------------------------ opening the folder

