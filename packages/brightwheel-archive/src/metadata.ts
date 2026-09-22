import { writeFile } from 'node:fs/promises';
import { exifDateTime, exifOffset } from 'media-ferry';
import type { MediaActivity, Student } from './api/schema.js';

export interface MetadataInput {
  filePath: string;
  activity: MediaActivity;
  student: Student;
  tagChildName: boolean;
  tagNote: boolean;
  stripLocation: boolean;
  writeSidecar: boolean;
}

/**
 * What we write, and why each field was chosen.
 *
 * Photo applications disagree about which tag means "when was this taken", so writing one
 * field only works in one app. We write the whole family:
 *
 *   EXIF DateTimeOriginal   - what Apple Photos, Lightroom and most tools sort by
 *   EXIF CreateDate         - the digitisation time; kept equal to the above
 *   EXIF OffsetTimeOriginal - the UTC offset. EXIF datetimes are naive local time with no
 *                             timezone, which is the single most common cause of photos
 *                             landing on the wrong day. Writing the offset removes the
 *                             ambiguity for tools that read it.
 *   XMP-photoshop:DateCreated - what Immich and several web galleries prefer
 *
 * For the child's name:
 *   XMP-iptcExt:PersonInImage - the standards-track "who is in this picture" field
 *   XMP-dc:subject / IPTC Keywords - searchable keywords, understood almost everywhere
 *
 * PersonInImage is the correct field, but most consumer apps only build People groups from
 * their own face detection. The keyword is what actually makes the photos findable today,
 * so we write both: the correct one for the future, the pragmatic one for now.
 */
export function buildTags(input: MetadataInput): Record<string, string | string[]> {
  const { activity, student } = input;
  const when = activity.capturedAt;

  const tags: Record<string, string | string[]> = {
    DateTimeOriginal: exifDateTime(when),
    CreateDate: exifDateTime(when),
    ModifyDate: exifDateTime(when),
    OffsetTimeOriginal: exifOffset(when),
    OffsetTimeDigitized: exifOffset(when),
    'XMP-photoshop:DateCreated': when.toISOString(),
    'XMP-xmp:CreateDate': when.toISOString(),
  };

  if (input.tagChildName && student.fullName) {
    tags['XMP-iptcExt:PersonInImage'] = [student.fullName];
    tags['XMP-dc:subject'] = [student.fullName, 'Brightwheel'];
    tags['Keywords'] = [student.fullName, 'Brightwheel'];
  }

  if (input.tagNote && activity.note) {
    tags['XMP-dc:description'] = activity.note;
    tags['Caption-Abstract'] = activity.note;
    tags['UserComment'] = activity.note;
  }

  if (activity.author) tags['XMP-dc:creator'] = [activity.author];
  if (student.schoolName) tags['XMP-iptcExt:LocationCreatedSublocation'] = student.schoolName;

  return tags;
}

/** The JSON sidecar. Always written — it needs no external tool and never fails. */
export async function writeJsonSidecar(input: MetadataInput): Promise<void> {
  const { activity, student } = input;
  const sidecar = {
    source: 'brightwheel',
    brightwheelActivityId: activity.id,
    capturedAt: activity.capturedAt.toISOString(),
    child: { id: student.id, name: student.fullName },
    school: student.schoolName,
    note: activity.note,
    postedBy: activity.author,
    kind: activity.kind,
    savedAt: new Date().toISOString(),
    savedBy: 'brightwheel-archive',
  };
  await writeFile(`${input.filePath}.json`, JSON.stringify(sidecar, null, 2), 'utf8');
}

export interface MetadataResult {
  embedded: boolean;
  sidecar: boolean;
  reason?: string;
}

let exiftoolPromise: Promise<unknown> | null = null;
let exiftoolUnavailable = false;

/**
 * Load ExifTool lazily, and only once.
 *
 * It is an optional dependency: it bundles a Perl distribution (~30MB) and is the only
 * practical way to write XMP and to touch video containers. Making it optional means the
 * base install stays small and `npm install` cannot fail on a machine where the binary
 * will not run. Without it we still write the JSON sidecar, so no information is lost —
 * it is just not embedded in the file itself.
 */
async function getExifTool(): Promise<{ write: (path: string, tags: object, args: string[]) => Promise<void> } | null> {
  if (exiftoolUnavailable) return null;
  if (!exiftoolPromise) {
    exiftoolPromise = import('exiftool-vendored')
      .then((m) => (m as { exiftool: unknown }).exiftool)
      .catch(() => {
        exiftoolUnavailable = true;
        return null;
      });
  }
  return (await exiftoolPromise) as { write: (p: string, t: object, a: string[]) => Promise<void> } | null;
}

/**
 * Write metadata into the file, preserving the original image bytes.
 *
 * `-overwrite_original` edits the metadata segment in place; it does not re-encode pixels,
 * so the photo you archive is byte-for-byte the photo Brightwheel served, apart from the
 * metadata block. That matters — a tool that silently recompressed every family photo
 * would be worse than useless.
 */
export async function applyMetadata(input: MetadataInput): Promise<MetadataResult> {
  await writeJsonSidecar(input);

  const tool = await getExifTool();
  if (!tool) {
    return {
      embedded: false,
      sidecar: true,
      reason: 'ExifTool is not installed, so the date and name were saved alongside the photo instead of inside it.',
    };
  }

  const tags = buildTags(input);
  if (input.stripLocation) {
    Object.assign(tags, { 'GPSLatitude': '', 'GPSLongitude': '', 'GPSPosition': '' });
  }

  try {
    await tool.write(input.filePath, tags, ['-overwrite_original']);
    if (input.writeSidecar) {
      await tool.write(`${input.filePath}.xmp`, buildTags(input), ['-overwrite_original']);
    }
    return { embedded: true, sidecar: true };
  } catch (error) {
    return {
      embedded: false,
      sidecar: true,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function closeMetadata(): Promise<void> {
  const tool = (await exiftoolPromise) as { end?: () => Promise<void> } | null;
  await tool?.end?.().catch(() => {});
}
