import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Manifest, download, hashFile, safeStem, uniqueName, weekFolder, weekLabel } from 'media-ferry';
import type { BrightwheelClient } from './api/client.js';
import type { MediaActivity, Student } from './api/schema.js';
import type { Config } from './config.js';
import { applyMetadata, closeMetadata } from './metadata.js';

export interface SyncProgress {
  phase: 'starting' | 'listing' | 'downloading' | 'done' | 'error';
  student?: string;
  message: string;
  saved: number;
  skipped: number;
  failed: number;
  total?: number;
}

export interface SyncResult {
  saved: number;
  skipped: number;
  failed: number;
  students: string[];
  archiveDir: string;
  warnings: string[];
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

export async function sync(
  client: BrightwheelClient,
  config: Config,
  onProgress: (p: SyncProgress) => void = () => {},
): Promise<SyncResult> {
  const result: SyncResult = {
    saved: 0,
    skipped: 0,
    failed: 0,
    students: [],
    archiveDir: config.archiveDir,
    warnings: [],
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

  await mkdir(config.archiveDir, { recursive: true });
  const manifest = await Manifest.open(config.archiveDir, 'brightwheel');

  // Names already used in each folder, so collisions get a suffix rather than overwrite.
  const takenByFolder = new Map<string, Set<string>>();
  const seenFolders = new Set<string>();

  for (const student of students) {
    onProgress({
      phase: 'listing',
      student: student.fullName,
      message: `Looking for ${student.fullName}'s photos`,
      ...counts(result),
    });

    // Incremental: stop paging once we reach posts older than what we already hold.
    let newest: Date | undefined;
    if (config.incremental) {
      for (const record of manifest.all) {
        const captured = record.provenance?.capturedAt;
        if (typeof captured === 'string' && record.provenance?.studentId === student.id) {
          const d = new Date(captured);
          if (!newest || d > newest) newest = d;
        }
      }
    }

    for await (const page of client.activities(student.id, { stopBefore: newest })) {
      for (const activity of page) {
        if (manifest.has({ sourceId: `brightwheel:${activity.id}`, url: activity.url })) {
          result.skipped += 1;
          continue;
        }

        const rel = folderFor(config, student, activity.capturedAt);
        const dir = join(config.archiveDir, rel);
        if (!seenFolders.has(dir)) {
          await mkdir(dir, { recursive: true });
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
        });

        try {
          const dl = await download({
            url: activity.url,
            destination: target,
            headers: client.mediaHeaders(),
          });
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
            path: join(rel, filename),
            sourceId: `brightwheel:${activity.id}`,
            transferId: activity.url,
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
          result.failed += 1;
          const message = error instanceof Error ? error.message : String(error);
          if (result.warnings.length < 8) result.warnings.push(`${filename}: ${message}`);
        }
      }
    }
  }

  await manifest.save();
  await closeMetadata();

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
