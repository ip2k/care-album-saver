import { writeFile } from 'node:fs/promises';
import { exifDateTime, exifOffset } from 'media-ferry';
import type { MediaActivity, Student } from './api/schema.js';

export interface MetadataInput {
  filePath: string;
  activity: MediaActivity;
  student: Student;
  /**
   * Write what identifies a person or a place into the file: the child, the nursery, the
   * teacher — and, because a note says all three, the note. It is the master switch the
   * setup page presents it as, so every identifying field is behind it. See `imageTags`.
   */
  tagChildName: boolean;
  /** Write the teacher's note. Takes effect only when `tagChildName` is on, as above. */
  tagNote: boolean;
  stripLocation: boolean;
  writeSidecar: boolean;
}

export type TagSet = Record<string, string | string[]>;

/**
 * Every tag carries an explicit group (`EXIF:`, `IPTC:`, `XMP-dc:`, `QuickTime:`, `Keys:`).
 *
 * An ungrouped name lets ExifTool decide where it lands, and that decision depends on the
 * `-use MWG` option the vendored wrapper adds by default: `Keywords` alone fans out to
 * IPTC *and* XMP-dc:subject, so naming both used to write the child's name into the same
 * list twice. Spelling every group out makes this file the exact table of what is
 * written, and the tests read the same table back.
 */

/** Local time with its UTC offset, in ExifTool's own format: "YYYY:MM:DD HH:MM:SS+HH:MM". */
function localWithOffset(when: Date): string {
  return `${exifDateTime(when)}${exifOffset(when)}`;
}

/** The same instant in the ISO 8601 form XMP uses: "YYYY-MM-DDTHH:MM:SS+HH:MM". */
function xmpDateTime(when: Date): string {
  const [date, time] = exifDateTime(when).split(' ');
  return `${date!.replaceAll(':', '-')}T${time}${exifOffset(when)}`;
}

/**
 * The UTC wall clock, in ExifTool's format, for the QuickTime container headers.
 *
 * QuickTime's movie, track and media headers are defined as seconds since 1904 *in UTC*.
 * Apple Photos, Immich, Google Photos, and ffprobe (hence Jellyfin and Plex) all honour
 * that and convert to the viewer's zone. ExifTool, for backwards compatibility, shows and
 * writes these headers verbatim unless its `QuickTimeUTC` option is on, and with the
 * option on it converts using *its own* local zone — which, since the vendored wrapper
 * spawns it with a bare environment, is not necessarily the zone this process is using.
 * So rather than lean on an option, the value is rendered as UTC here and stored exactly
 * as computed. A 22:17 capture in Los Angeles is stored as 05:17 the next morning and,
 * read by any application that follows the specification, lands back on the right
 * evening.
 */
function quickTimeUtc(when: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${when.getUTCFullYear()}:${p(when.getUTCMonth() + 1)}:${p(when.getUTCDate())} ` +
    `${p(when.getUTCHours())}:${p(when.getUTCMinutes())}:${p(when.getUTCSeconds())}`
  );
}

/**
 * What we write into a photo, and why each field was chosen.
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
 *   IPTC DateCreated        - the legacy pair that older galleries still read first
 *   XMP-photoshop:DateCreated - what Immich and several web galleries prefer
 *
 * Every date is the *local* capture time; the XMP and IPTC forms carry the offset too. A
 * value in UTC would be equally correct for an application that reads the zone and off by
 * hours — sometimes a day — for the many that do not.
 *
 * For the child's name:
 *   XMP-iptcExt:PersonInImage - the standards-track "who is in this picture" field
 *   XMP-dc:subject / IPTC Keywords - searchable keywords, understood almost everywhere
 *
 * PersonInImage is the correct field, but most consumer apps only build People groups from
 * their own face detection. The keyword is what actually makes the photos findable today,
 * so we write both: the correct one for the future, the pragmatic one for now.
 */
function imageTags(input: MetadataInput): TagSet {
  const { activity, student } = input;
  const when = activity.capturedAt;

  const tags: TagSet = {
    'EXIF:DateTimeOriginal': exifDateTime(when),
    'EXIF:CreateDate': exifDateTime(when),
    'EXIF:ModifyDate': exifDateTime(when),
    'EXIF:OffsetTimeOriginal': exifOffset(when),
    'EXIF:OffsetTimeDigitized': exifOffset(when),
    // IPTC splits the moment into a date and a time; ExifTool takes each from the whole.
    'IPTC:DateCreated': localWithOffset(when),
    'IPTC:TimeCreated': localWithOffset(when),
    'IPTC:DigitalCreationDate': localWithOffset(when),
    'IPTC:DigitalCreationTime': localWithOffset(when),
    'XMP-photoshop:DateCreated': xmpDateTime(when),
    'XMP-xmp:CreateDate': xmpDateTime(when),
    'XMP-xmp:ModifyDate': xmpDateTime(when),
  };

  if (input.tagChildName && student.fullName) {
    tags['XMP-iptcExt:PersonInImage'] = [student.fullName];
    tags['XMP-dc:subject'] = [student.fullName, 'Brightwheel'];
    tags['IPTC:Keywords'] = [student.fullName, 'Brightwheel'];
  }

  // `tagChildName` as well as `tagNote`, deliberately, and the names switch is the one that
  // decides. "Label photos with names" is presented to a parent as a master control — turn
  // it off and nothing inside the file says who or where — and a teacher's note is not a
  // neutral caption. "Robin fell asleep mid-song at circle time" names the child, and notes
  // routinely name the room, the class and the teacher too. Writing the note with the names
  // switch off would make that promise false in the *default* configuration, because the
  // note switch starts on.
  //
  // Keeping the two independent was the alternative, and it was rejected: it would need the
  // promise reworded into something a parent has to reason about ("names are removed, but
  // the note may still say your child's name"), and a switch that needs a footnote is not a
  // switch a tired parent reads. Nothing is lost either way — the note is always in the
  // .json sidecar beside the photo, which stays behind when the photo is shared.
  if (input.tagChildName && input.tagNote && activity.note) {
    tags['XMP-dc:description'] = activity.note;
    tags['IPTC:Caption-Abstract'] = activity.note;
    tags['EXIF:UserComment'] = activity.note;
  }

  // Under the same switch, deliberately. The nursery's name and the teacher's name
  // identify a child's whereabouts and a third party as surely as the child's own name
  // does, and they travel in the file the same way. A switch a parent reads as "do not
  // make this photo self-identifying" that still wrote the nursery into every file would
  // be a promise the file does not keep. Both remain in the .json sidecar beside the
  // photo, which stays behind when the photo is shared.
  if (input.tagChildName) {
    if (activity.author) tags['XMP-dc:creator'] = [activity.author];
    if (student.schoolName) tags['XMP-iptcExt:LocationCreatedSublocation'] = student.schoolName;
  }

  return tags;
}

/**
 * What we write into a video. MP4 and MOV are QuickTime containers, and none of the EXIF
 * fields above exist in them: DateTimeOriginal is not a QuickTime tag, and asking ExifTool
 * to write it into an MP4 buries it in an XMP block that no video application consults for
 * the date, while the container's own headers keep saying whenever the file was encoded —
 * for Brightwheel, the upload. What the applications actually read:
 *
 *   QuickTime:CreateDate / ModifyDate - the movie header. ffprobe reports it as
 *                                       creation_time, which is what Jellyfin and Plex
 *                                       show; Immich and Google Photos read it too.
 *   QuickTime:Track* / Media* dates   - the same instant in the track and media headers,
 *                                       so no reader that prefers those sees the upload
 *                                       time instead.
 *   Keys:CreationDate                 - com.apple.quicktime.creationdate, the one
 *                                       QuickTime date that carries its UTC offset. Apple
 *                                       Photos prefers it, and it is what keeps the
 *                                       wall-clock time available to anything that does
 *                                       not apply the UTC rule (see `quickTimeUtc`).
 *   XMP-photoshop:DateCreated         - as for photos, for Immich and the galleries.
 *
 * For the child's name and the note: the XMP fields as for photos, plus the Apple Keys
 * that Photos, Finder and Spotlight index. Keys:Keywords is one comma-separated string,
 * not a list, in Apple's own convention.
 */
function videoTags(input: MetadataInput): TagSet {
  const { activity, student } = input;
  const when = activity.capturedAt;

  const tags: TagSet = {
    'QuickTime:CreateDate': quickTimeUtc(when),
    'QuickTime:ModifyDate': quickTimeUtc(when),
    'QuickTime:TrackCreateDate': quickTimeUtc(when),
    'QuickTime:TrackModifyDate': quickTimeUtc(when),
    'QuickTime:MediaCreateDate': quickTimeUtc(when),
    'QuickTime:MediaModifyDate': quickTimeUtc(when),
    'Keys:CreationDate': localWithOffset(when),
    'XMP-photoshop:DateCreated': xmpDateTime(when),
    'XMP-xmp:CreateDate': xmpDateTime(when),
    'XMP-xmp:ModifyDate': xmpDateTime(when),
  };

  if (input.tagChildName && student.fullName) {
    tags['XMP-iptcExt:PersonInImage'] = [student.fullName];
    tags['XMP-dc:subject'] = [student.fullName, 'Brightwheel'];
    tags['Keys:Keywords'] = `${student.fullName}, Brightwheel`;
  }

  // Under the names switch as well as its own, for the reason given in imageTags.
  if (input.tagChildName && input.tagNote && activity.note) {
    tags['XMP-dc:description'] = activity.note;
    tags['Keys:Description'] = activity.note;
  }

  // Governed by the same switch as the child's name, for the reason given in imageTags.
  if (input.tagChildName) {
    if (activity.author) {
      tags['XMP-dc:creator'] = [activity.author];
      tags['Keys:Author'] = activity.author;
    }
    if (student.schoolName) tags['XMP-iptcExt:LocationCreatedSublocation'] = student.schoolName;
  }

  return tags;
}

/** The tag table for a file, chosen by what Brightwheel says the file is. */
export function buildTags(input: MetadataInput): TagSet {
  return input.activity.kind === 'video' ? videoTags(input) : imageTags(input);
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
  /** The tags were written into the file itself. */
  embedded: boolean;
  /** The JSON sidecar was written beside the file. Always true: it needs no external tool. */
  sidecar: boolean;
  /** The .xmp sidecar was written, when one was asked for. Absent when it was not asked for. */
  xmpSidecar?: boolean;
  /** Why something above is false, in words for the parent. */
  reason?: string;
}

/** The sliver of exiftool-vendored this module uses, so the import can stay dynamic. */
interface ExifToolLike {
  write(
    path: string,
    tags: object,
    args: string[],
  ): Promise<{ created?: number; updated?: number; unchanged?: number; warnings?: string[] }>;
  end(): Promise<void>;
}

let exiftoolPromise: Promise<ExifToolLike | null> | null = null;
let exiftoolUnavailable = false;

/**
 * Load ExifTool lazily, and only once per run.
 *
 * It is an optional dependency: it bundles a Perl distribution (~30MB) and is the only
 * practical way to write XMP and to touch video containers. Making it optional means the
 * base install stays small and `npm install` cannot fail on a machine where the binary
 * will not run. Without it we still write the JSON sidecar, so no information is lost —
 * it is just not embedded in the file itself.
 *
 * We construct our own instance rather than use the package's shared `exiftool` export.
 * `closeMetadata()` shuts the instance down at the end of a sync, and an ended instance
 * refuses all further work; a second sync in the same process (the setup assistant runs
 * several) would then silently fall back to sidecars. A fresh instance per run cannot.
 */
async function getExifTool(): Promise<ExifToolLike | null> {
  if (exiftoolUnavailable) return null;
  if (!exiftoolPromise) {
    exiftoolPromise = import('exiftool-vendored')
      .then((m) => new (m as { ExifTool: new () => ExifToolLike }).ExifTool())
      .catch(() => {
        exiftoolUnavailable = true;
        return null;
      });
  }
  return exiftoolPromise;
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
    // Two different things happen here, and only one of them is harmless.
    //
    // The dates and names are *deferred*: they go into the .json sidecar instead of into
    // the file, and nothing is lost. Removing location information is not deferred
    // anywhere — deleting a tag needs the same tool as writing one, so a photo that
    // arrived carrying coordinates keeps them. "Remove location information" is on by
    // default, so a message about dates and names alone would leave a parent believing
    // something that did not happen.
    //
    // Why not strip the GPS ourselves? Because the safe version of it is not small.
    // Dropping the whole EXIF block would also destroy the capture date the camera wrote,
    // which is the one part of the original we cannot put back. Removing only the GPS
    // block means rewriting a TIFF structure of absolute offsets inside a JPEG segment by
    // hand, with no library — and it would cover JPEG alone, not HEIC and not the MP4
    // container, so "location removed" would be true of some archived files and false of
    // others. A half-kept promise is worse than a plainly stated one, and the risk of
    // corrupting a family's only copy of a photo is not worth the difference. Saying so is
    // the honest fix; installing ExifTool is the real one.
    const location = input.stripLocation
      ? ' Location information could not be removed from inside the photo either, because that needs ExifTool as well — if this photo arrived with coordinates in it, they are still there.'
      : '';
    return {
      embedded: false,
      sidecar: true,
      reason:
        'ExifTool is not installed, so the date and the other details were saved alongside ' +
        `the photo, in the .json file beside it, rather than inside the photo itself.${location}`,
    };
  }

  const tags = buildTags(input);
  if (input.stripLocation) {
    // Brightwheel has never been seen to include coordinates, but a teacher's phone might
    // one day. Deleting a tag that is absent is a no-op, so this costs nothing. These names
    // are deliberately ungrouped, unlike everything in the tables above: a bare name deletes
    // the tag from every group it lives in (EXIF, XMP-exif, QuickTime), which is what a
    // deletion wants, whereas a grouped name would leave the copies in the other groups.
    Object.assign(tags, { GPSLatitude: '', GPSLongitude: '', GPSPosition: '', GPSCoordinates: '' });
  }

  const embed = await writeTags(tool, input.filePath, tags);
  if (!embed.ok) return { embedded: false, sidecar: true, reason: embed.reason };
  if (!input.writeSidecar) return { embedded: true, sidecar: true };

  // An .xmp file can only hold XMP; the EXIF, IPTC and QuickTime fields have no home there.
  const xmpOnly = Object.fromEntries(Object.entries(buildTags(input)).filter(([k]) => k.startsWith('XMP-')));
  const aside = await writeTags(tool, `${input.filePath}.xmp`, xmpOnly);
  // The file itself is done by now; a sidecar that failed does not undo that, and must not
  // be reported as though it did — nor pass unmentioned.
  return aside.ok
    ? { embedded: true, sidecar: true, xmpSidecar: true }
    : { embedded: true, sidecar: true, xmpSidecar: false, reason: `The .xmp sidecar was not written: ${aside.reason}` };
}

/** One ExifTool write, with its outcome read for what it is. */
async function writeTags(
  tool: ExifToolLike,
  path: string,
  tags: TagSet,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const outcome = await tool.write(path, tags, ['-overwrite_original']);
    // ExifTool reports a file it could not change as a warning, not an error, and the
    // wrapper passes that through as "0 files updated". Treat it as the failure it is.
    const touched = (outcome.created ?? 0) + (outcome.updated ?? 0) + (outcome.unchanged ?? 0);
    if (touched === 0) return { ok: false, reason: outcome.warnings?.join('; ') || 'ExifTool wrote nothing' };
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Shut ExifTool's helper process down. The next `applyMetadata` starts a fresh one. */
export async function closeMetadata(): Promise<void> {
  const pending = exiftoolPromise;
  exiftoolPromise = null;
  const tool = await pending;
  await tool?.end().catch(() => {});
}
