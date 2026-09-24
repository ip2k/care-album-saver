/**
 * Proves the metadata embedding, for photos and for videos, by reading it back.
 *
 * Every test in this file runs in one fixed, non-UTC timezone. The whole point of the
 * date handling is the difference between local time and UTC — EXIF dates are naive local
 * time, QuickTime headers are UTC — and on a CI machine set to UTC the two are identical,
 * so a test there could not tell "wrote UTC" from "wrote local". Honolulu has no daylight
 * saving to reason about, and at -10:00 an evening capture lands on the next UTC day, so
 * the calendar-day question is exercised rather than assumed. Node re-reads TZ when it is
 * assigned. The ExifTool child process does not inherit it — the wrapper spawns it with a
 * bare environment — so the reader below is handed the zone explicitly.
 */
process.env.TZ = 'Pacific/Honolulu';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { applyMetadata, BrightwheelClient, startMockBrightwheel, sync, Secret, DEFAULT_CONFIG, buildTags } from '../dist/index.js';
import { closeMetadata } from '../dist/metadata.js';
import { placeholderJpeg, placeholderMp4, MP4_CONTAINER_CREATED } from '../dist/mock/fixtures.js';
import { exifDateTime, exifOffset } from '../dist/ferry/index.js';
import { exifToolSkipReason } from '../../../scripts/test-env.js';

const run = promisify(execFile);

let mock;
/** Our own ExifTool for reading back. `sync()` ends the one it writes with. */
let exiftool = null;
/**
 * False when ExifTool is here, and the reason when it is not — passed to node:test's `skip`
 * option below rather than decided inside each test body. Node does count an in-body
 * `t.skip()` as skipped rather than as a pass, so the option is not what makes the skip
 * visible; what it changes is that the reason is declared before the test runs and cannot
 * be reached only on some paths. The real protection is elsewhere: a CI cell whose optional
 * dependency failed to install would otherwise print a green-with-skips run having proved
 * nothing about what goes into a photo, so scripts/test-env.js turns these skips into
 * failures there.
 */
const exiftoolMissing = await exifToolSkipReason(() => import('exiftool-vendored'));
const SESSION = 'test-session-value';

before(async () => {
  mock = await startMockBrightwheel({ validSession: SESSION, activitiesPerStudent: 12 });
  if (!exiftoolMissing) {
    const { ExifTool } = await import('exiftool-vendored');
    exiftool = new ExifTool({ exiftoolEnv: { TZ: process.env.TZ } });
  }
});
after(async () => {
  await mock?.close();
  await exiftool?.end();
});

const client = () =>
  new BrightwheelClient({ session: new Secret(SESSION), baseUrl: `${mock.url}/api/v1`, delayMs: 0 });

const syncInto = async (overrides = {}) => {
  const dir = await mkdtemp(join(tmpdir(), 'bw-media-'));
  const config = { ...DEFAULT_CONFIG, archiveDir: dir, incremental: false, delayMs: 0, ...overrides };
  const result = await sync(client(), config, () => {}, { allowTemporaryDir: true });
  assert.equal(result.failed, 0, `failures: ${result.warnings.join('; ')}`);
  assert.deepEqual(result.warnings, [], 'every file should have been embedded, not degraded');
  return dir;
};

/** Every archived file of one child with its sidecar parsed, so a test can pick by note or kind. */
async function archived(dir, child = 'Robin-Maple') {
  const out = [];
  for (const week of await readdir(join(dir, child))) {
    for (const name of await readdir(join(dir, child, week))) {
      if (!/\.(jpg|mp4)$/.test(name)) continue;
      const path = join(dir, child, week, name);
      const sidecar = JSON.parse(await readFile(`${path}.json`, 'utf8'));
      out.push({ path, name, sidecar, postedAt: new Date(sidecar.postedAt) });
    }
  }
  return out;
}

/** `exiftool -j -G1 -a`, verbatim strings, with the QuickTime UTC rule off unless asked. */
const readRaw = (file, ...extra) =>
  exiftool.readRaw(file, { readArgs: ['-G1', '-a', '-api', 'QuickTimeUTC=0', ...extra] });

const asList = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** The UTC wall clock in ExifTool's format, which is what a QuickTime header holds. */
function utcStamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}:${p(d.getUTCMonth() + 1)}:${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  );
}

/** Everything from the SOS marker to the end: the entropy-coded pixels, which must not change. */
function scanSegment(jpeg) {
  assert.deepEqual([...jpeg.subarray(0, 2)], [0xff, 0xd8], 'not a JPEG');
  let i = 2;
  while (i < jpeg.length) {
    assert.equal(jpeg[i], 0xff, `marker expected at ${i}`);
    if (jpeg[i + 1] === 0xda) return jpeg.subarray(i);
    i += 2 + jpeg.readUInt16BE(i + 2);
  }
  throw new Error('no scan in JPEG');
}

/** The payload of a top-level MP4 box. */
function topLevelBox(mp4, type) {
  for (let i = 0; i < mp4.length; ) {
    const size = mp4.readUInt32BE(i);
    if (mp4.toString('latin1', i + 4, i + 8) === type) return mp4.subarray(i + 8, i + size);
    i += size;
  }
  throw new Error(`no ${type} box`);
}

/** ffprobe is a developer convenience, never a test dependency: null when it is not installed. */
async function ffprobe(file) {
  try {
    const { stdout, stderr } = await run('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file]);
    return { ...JSON.parse(stdout), stderr };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// ---------------------------------------------------------------- fixtures

test('the mock serves a genuine JPEG and a genuine MP4, deterministically', async () => {
  const jpg = await fetch(`${mock.url}/media/act-111-0000.jpg?signature=x&expires=1`);
  assert.equal(jpg.headers.get('content-type'), 'image/jpeg');
  assert.match(jpg.headers.get('etag'), /^"[0-9a-f]{16}"$/, 'archive.json records the etag verbatim');
  assert.ok(jpg.headers.get('last-modified'), 'archive.json records Last-Modified verbatim');
  const jpgBytes = Buffer.from(await jpg.arrayBuffer());
  assert.equal(Number(jpg.headers.get('content-length')), jpgBytes.length);
  assert.deepEqual([...jpgBytes.subarray(0, 3)], [0xff, 0xd8, 0xff]);
  assert.deepEqual([...jpgBytes.subarray(-2)], [0xff, 0xd9]);

  const mp4 = await fetch(`${mock.url}/media/act-111-0005.mp4?signature=x&expires=1`);
  assert.equal(mp4.headers.get('content-type'), 'video/mp4');
  const mp4Bytes = Buffer.from(await mp4.arrayBuffer());
  assert.equal(mp4Bytes.toString('latin1', 4, 8), 'ftyp');
  assert.ok(topLevelBox(mp4Bytes, 'moov').length > 0);
  assert.deepEqual(topLevelBox(mp4Bytes, 'mdat'), placeholderJpeg('act-111-0005'), 'the frame is the same placeholder');

  // Same id, same bytes; different id, different colour. The screenshots depend on the
  // first and the manifest's content hashes are only meaningful given the second.
  assert.deepEqual(placeholderJpeg('act-111-0000'), jpgBytes);
  assert.notDeepEqual(placeholderJpeg('act-111-0001'), jpgBytes);
  assert.ok(jpgBytes.length < 1024 && mp4Bytes.length < 2048, 'fixtures stay tiny');

  const dir = await mkdtemp(join(tmpdir(), 'bw-fixture-'));
  const [jpgPath, mp4Path] = [join(dir, 'a.jpg'), join(dir, 'a.mp4')];
  await writeFile(jpgPath, jpgBytes);
  await writeFile(mp4Path, mp4Bytes);

  if (exiftool) {
    // ExifTool's own structural validation, the same check `exiftool -validate` runs.
    for (const file of [jpgPath, mp4Path]) {
      const v = await exiftool.readRaw(file, { readArgs: ['-validate', '-Validate', '-Warning', '-G1', '-a'] });
      assert.equal(v['ExifTool:Validate'], 'OK', `${file}: ${JSON.stringify(v)}`);
    }
  }
  const probe = await ffprobe(mp4Path);
  if (probe) {
    assert.equal(probe.stderr, '', 'ffprobe must not complain about the container');
    assert.equal(probe.streams[0].codec_name, 'mjpeg');
    assert.equal(probe.streams[0].width, 64);
  }
});

test('buildTags picks the table by kind: EXIF for photos, QuickTime for videos', () => {
  const when = new Date('2026-09-17T18:14:55-10:00');
  const base = {
    filePath: '/nowhere', tagChildName: true, tagNote: true, stripLocation: true, writeSidecar: false,
    student: { id: 's', firstName: 'Robin', lastName: 'Maple', fullName: 'Robin Maple', schoolName: 'Sunnybrook' },
  };
  const activity = { id: 'a', studentId: 's', postedAt: when, note: 'Water play.', url: 'u', author: 'Ms. Alvarez' };

  const photo = buildTags({ ...base, activity: { ...activity, kind: 'image' } });
  assert.equal(photo['EXIF:DateTimeOriginal'], '2026:09:17 18:14:55');
  assert.equal(photo['EXIF:OffsetTimeOriginal'], '-10:00');
  assert.equal(photo['XMP-photoshop:DateCreated'], '2026-09-17T18:14:55-10:00');
  assert.ok(!Object.keys(photo).some((k) => k.startsWith('QuickTime:') || k.startsWith('Keys:')));

  const video = buildTags({ ...base, activity: { ...activity, kind: 'video' } });
  // The header is UTC: 18:14 in Honolulu is 04:14 the next morning in Greenwich.
  assert.equal(video['QuickTime:CreateDate'], '2026:09:18 04:14:55');
  assert.equal(video['QuickTime:MediaCreateDate'], '2026:09:18 04:14:55');
  // Apple's own date keeps the local wall clock and says which one it is.
  assert.equal(video['Keys:CreationDate'], '2026:09:17 18:14:55-10:00');
  assert.equal(video['XMP-photoshop:DateCreated'], '2026-09-17T18:14:55-10:00');
  assert.ok(!Object.keys(video).some((k) => k.startsWith('EXIF:') || k.startsWith('IPTC:')), 'no EXIF in a video');
  assert.equal(typeof video['Keys:Keywords'], 'string', 'Keys:Keywords is not a list tag');
  assert.deepEqual(video['XMP-iptcExt:PersonInImage'], ['Robin Maple']);

  // Every tag names its group, so nothing is left to ExifTool's MWG fan-out.
  for (const tags of [photo, video]) {
    for (const key of Object.keys(tags)) assert.match(key, /^[A-Za-z-]+:/, `${key} must be grouped`);
  }
});

// ---------------------------------------------------------------- photos

test('photo metadata round-trips: capture time, offset, name and note, pixels untouched', { skip: exiftoolMissing }, async () => {
  const dir = await syncInto();
  const files = await archived(dir);
  const photo = files.find((f) => f.name.endsWith('.jpg') && f.sidecar.note);
  assert.ok(photo, 'expected a photo with a note');
  const { postedAt } = photo;
  const tags = await readRaw(photo.path);

  // The date family, all in local time — and not the upload time six hours later.
  const local = exifDateTime(postedAt);
  const uploaded = exifDateTime(new Date(postedAt.getTime() + 6 * 3600 * 1000));
  assert.notEqual(local, uploaded);
  assert.equal(tags['ExifIFD:DateTimeOriginal'], local);
  assert.equal(tags['ExifIFD:CreateDate'], local);
  assert.equal(tags['IFD0:ModifyDate'], local);
  assert.equal(tags['ExifIFD:OffsetTimeOriginal'], exifOffset(postedAt));
  assert.equal(tags['ExifIFD:OffsetTimeOriginal'], '-10:00', 'TZ pin did not take effect');
  assert.equal(tags['XMP-photoshop:DateCreated'], `${local}${exifOffset(postedAt)}`);
  assert.equal(tags['XMP-xmp:CreateDate'], `${local}${exifOffset(postedAt)}`);
  assert.equal(tags['IPTC:DateCreated'], local.slice(0, 10));
  assert.equal(tags['IPTC:TimeCreated'], `${local.slice(11)}${exifOffset(postedAt)}`);
  assert.ok(!JSON.stringify(tags).includes(uploaded), 'the upload time must appear nowhere');

  // The name, once in each place — a regression test for the doubled keyword list.
  assert.deepEqual(asList(tags['XMP-iptcExt:PersonInImage']), ['Robin Maple']);
  assert.deepEqual(asList(tags['XMP-dc:Subject']), ['Robin Maple', 'Brightwheel']);
  assert.deepEqual(asList(tags['IPTC:Keywords']), ['Robin Maple', 'Brightwheel']);
  assert.equal(tags['XMP-dc:Description'], photo.sidecar.note);
  assert.equal(tags['IPTC:Caption-Abstract'], photo.sidecar.note);
  assert.equal(tags['XMP-dc:Creator'], photo.sidecar.postedBy);
  assert.equal(tags['XMP-iptcExt:LocationCreatedSublocation'], 'Sunnybrook Early Learning');
  // A backstop, not the proof: the mock's photos carry no coordinates in the first place,
  // so this line would hold with the stripping removed. What the strip actually does is
  // proved further down, on a file that does carry them.
  assert.deepEqual(Object.keys(tags).filter((k) => /GPS/i.test(k)), [], 'nothing added any location');

  // The picture itself: the scan is byte-identical to what the mock served, and the file
  // still opens as the same image.
  const bytes = await readFile(photo.path);
  const original = placeholderJpeg(photo.sidecar.brightwheelActivityId);
  assert.ok(bytes.length > original.length, 'metadata was added');
  assert.deepEqual(scanSegment(bytes), scanSegment(original));
  assert.equal(tags['File:ImageWidth'], 64);
  assert.equal(tags['File:ImageHeight'], 48);

  // And every other photo of both children got the same treatment.
  for (const other of [...files, ...(await archived(dir, 'Sam-Maple'))].filter((f) => f.name.endsWith('.jpg'))) {
    const o = await readRaw(other.path, '-EXIF:DateTimeOriginal', '-XMP-iptcExt:PersonInImage');
    assert.equal(o['ExifIFD:DateTimeOriginal'], exifDateTime(other.postedAt), other.name);
    assert.equal(o['XMP-iptcExt:PersonInImage'], other.sidecar.child.name, other.name);
  }
});

test('with the name and note options off, neither is written anywhere', { skip: exiftoolMissing }, async () => {
  const dir = await syncInto({ tagChildName: false, tagNote: false });
  const files = await archived(dir);
  for (const kind of ['.jpg', '.mp4']) {
    const file = files.find((f) => f.name.endsWith(kind) && f.sidecar.note);
    const tags = await readRaw(file.path);
    for (const key of ['XMP-iptcExt:PersonInImage', 'XMP-dc:Subject', 'IPTC:Keywords', 'Keys:Keywords',
      'XMP-dc:Description', 'IPTC:Caption-Abstract', 'ExifIFD:UserComment', 'Keys:Description']) {
      assert.equal(tags[key], undefined, `${kind}: ${key} was written`);
    }
    for (const key of Object.keys(tags)) {
      if (/^(System|File):|^SourceFile$/.test(key)) continue;
      assert.ok(!String(tags[key]).includes('Robin'), `${kind}: ${key} carries the name`);
      assert.ok(!String(tags[key]).includes(file.sidecar.note), `${kind}: ${key} carries the note`);
    }
    // The date is still corrected: opting out of the name is not opting out of the fix.
    const stamp = kind === '.jpg' ? tags['ExifIFD:DateTimeOriginal'] : tags['Keys:CreationDate'];
    assert.ok(stamp.startsWith(exifDateTime(file.postedAt)), `${kind}: ${stamp}`);
  }
});

// ---------------------------------------------------------------- videos

test('video metadata round-trips: UTC headers, local Apple date, name and note, frame untouched', { skip: exiftoolMissing }, async () => {
  const dir = await syncInto();
  const video = (await archived(dir)).find((f) => f.name.endsWith('.mp4'));
  assert.ok(video, 'expected a video');
  const { postedAt } = video;
  const local = exifDateTime(postedAt);
  const offset = exifOffset(postedAt);

  // Guard: this capture must straddle midnight UTC, or the test below proves nothing about
  // calendar days. If the mock's schedule changes, pick another file rather than weaken this.
  assert.notEqual(utcStamp(postedAt).slice(0, 10), local.slice(0, 10), 'fixture no longer crosses a UTC day');

  // The archive puts it on the local day.
  assert.ok(video.name.startsWith(local.slice(0, 10).replaceAll(':', '-')), video.name);

  // The container headers hold UTC — every one of them, not just the movie header — and
  // the transcoder's own timestamp that the fixture shipped with is gone.
  const raw = await readRaw(video.path);
  const stale = utcStamp(MP4_CONTAINER_CREATED);
  for (const key of ['QuickTime:CreateDate', 'QuickTime:ModifyDate', 'Track1:TrackCreateDate',
    'Track1:TrackModifyDate', 'Track1:MediaCreateDate', 'Track1:MediaModifyDate']) {
    assert.equal(raw[key], utcStamp(postedAt), key);
    assert.notEqual(raw[key], stale, `${key} still says when the file was encoded`);
  }
  // Read with the QuickTime UTC rule, as Apple Photos, Immich and Google Photos do, the
  // same header comes back as the local capture time — on the right calendar day.
  const applied = await readRaw(video.path, '-api', 'QuickTimeUTC=1', '-QuickTime:CreateDate');
  // ExifTool on Windows reads the local zone from the system, not from TZ, so the local
  // spellings are checked where the pin can take effect; the UTC ones above hold everywhere.
  if (process.platform !== 'win32') assert.equal(applied['QuickTime:CreateDate'], `${local}${offset}`);

  // Apple's own key carries the wall clock and the offset explicitly.
  if (process.platform !== 'win32') assert.equal(raw['Keys:CreationDate'], `${local}${offset}`);
  assert.equal(raw['XMP-photoshop:DateCreated'], `${local}${offset}`);
  assert.equal(raw['XMP-xmp:CreateDate'], `${local}${offset}`);
  assert.equal(raw['ExifIFD:DateTimeOriginal'], undefined, 'DateTimeOriginal is not a QuickTime tag');

  // What the library's rich reader — the one Immich is built on — makes of it.
  const rich = await exiftool.read(video.path);
  assert.equal(Math.floor(rich.CreateDate.toDate().getTime() / 1000), Math.floor(postedAt.getTime() / 1000));
  assert.equal(rich.CreateDate.day, postedAt.getDate());
  assert.equal(rich.CreateDate.hour, postedAt.getHours());

  // Name and note, in the XMP that galleries read and the Apple keys that Photos indexes.
  assert.deepEqual(asList(raw['XMP-iptcExt:PersonInImage']), ['Robin Maple']);
  assert.deepEqual(asList(raw['XMP-dc:Subject']), ['Robin Maple', 'Brightwheel']);
  assert.equal(raw['Keys:Keywords'], 'Robin Maple, Brightwheel');
  assert.equal(raw['XMP-dc:Description'], video.sidecar.note);
  assert.equal(raw['Keys:Description'], video.sidecar.note);
  assert.equal(raw['Keys:Author'], video.sidecar.postedBy);
  // As with the photo above: a backstop against something adding coordinates, not a test
  // of the stripping, which the location section below exercises on a video that has some.
  assert.deepEqual(Object.keys(raw).filter((k) => /GPS/i.test(k)), [], 'nothing added any location');

  // The frame is untouched: ExifTool grew `moov` and moved `mdat`, but the sample inside
  // is byte-for-byte the placeholder the mock served.
  const bytes = await readFile(video.path);
  assert.deepEqual(topLevelBox(bytes, 'mdat'), placeholderJpeg(video.sidecar.brightwheelActivityId));

  // ffprobe, hence Jellyfin and Plex, sees the UTC instant; and the rewritten chunk
  // offsets still point at the frame, or the stream would fail to probe.
  const probe = await ffprobe(video.path);
  if (probe) {
    assert.equal(probe.stderr, '');
    assert.equal(probe.format.tags.creation_time, `${postedAt.toISOString().slice(0, 19)}.000000Z`);
    assert.equal(probe.format.tags['com.apple.quicktime.creationdate'], `${local.slice(0, 10).replaceAll(':', '-')}T${local.slice(11)}${offset.replace(':', '')}`);
    assert.equal(probe.streams[0].codec_name, 'mjpeg');
  }
});

// ---------------------------------------------------------------- where it was taken

/**
 * A file that arrives carrying coordinates, which the mock's own fixtures never do.
 *
 * "Remove the location" is one of the promises the setup page makes to a parent, and until
 * this existed nothing tested it: the two round-trips above assert that no GPS tag comes
 * out of a file that had none going in, which stays true however thoroughly the stripping
 * is broken. So the coordinates are written in here first, with ExifTool, and the strip
 * then has something to remove.
 *
 * 21.2870 N, 157.8390 W is Kapiolani Park in Honolulu — a public park, chosen because it
 * matches this file's timezone and because nothing in this project has ever been there.
 */
const GPS_LAT_DMS = /21 deg 17/;
async function fileCarryingGps(kind) {
  const dir = await mkdtemp(join(tmpdir(), 'bw-gps-'));
  const id = kind === 'video' ? 'act-111-0005' : 'act-111-0000';
  const file = join(dir, kind === 'video' ? 'a.mp4' : 'a.jpg');
  await writeFile(file, kind === 'video' ? placeholderMp4(id) : placeholderJpeg(id));
  // A video's coordinates live in one ISO 6709 string under Apple's Keys table; a photo's
  // live in the EXIF GPS IFD as four separate tags. Both are what a phone camera writes.
  const coordinates =
    kind === 'video'
      ? { 'Keys:GPSCoordinates': '+21.2870-157.8390/' }
      : { GPSLatitude: 21.287, GPSLatitudeRef: 'N', GPSLongitude: -157.839, GPSLongitudeRef: 'W' };
  await exiftool.write(file, coordinates, { writeArgs: ['-overwrite_original'] });

  // The fixture is only worth anything if the coordinates really went in.
  const before = await readRaw(file);
  assert.ok(Object.keys(before).some((k) => /GPS/i.test(k)), `${kind}: no GPS was written to the fixture`);
  assert.match(String(before['Composite:GPSPosition']), GPS_LAT_DMS, `${kind}: the fixture's own coordinates`);

  return { id, file };
}

/** The activity and child a stripping run is given; only the switch differs between runs. */
const gpsActivity = (id, kind) => ({
  id,
  studentId: 'stu-x',
  postedAt: new Date('2026-09-17T18:14:55-10:00'),
  note: 'Water play in the garden.',
  url: 'https://example.invalid/a',
  author: 'Ms. Alvarez',
  kind,
});
const GPS_STUDENT = {
  id: 'stu-x', firstName: 'Robin', lastName: 'Maple', fullName: 'Robin Maple', schoolName: 'Sunnybrook Early Learning',
};

test('coordinates that come in with a photo or a video are taken back out', { skip: exiftoolMissing }, async () => {
  try {
    for (const kind of ['image', 'video']) {
      const { id, file } = await fileCarryingGps(kind);
      const outcome = await applyMetadata({
        filePath: file,
        activity: gpsActivity(id, kind),
        student: GPS_STUDENT,
        tagChildName: true,
        tagNote: true,
        stripLocation: true,
        writeSidecar: false,
      });
      assert.equal(outcome.embedded, true, `${kind}: ${outcome.reason ?? ''}`);

      const after = await readRaw(file);
      assert.deepEqual(
        Object.keys(after).filter((k) => /GPS/i.test(k)),
        [],
        `${kind}: the place this was taken is still in the file`,
      );
      // Not only the named tags: the derived ones ExifTool computes from them are gone too,
      // which is the difference between "the coordinates are hidden" and "they are absent".
      assert.doesNotMatch(JSON.stringify(after), GPS_LAT_DMS, `${kind}: a copy survived somewhere else`);
      // And the date was still written, so this is the strip doing the work rather than a
      // write that failed and left the file alone.
      const stamp = kind === 'video' ? after['Keys:CreationDate'] : after['ExifIFD:DateTimeOriginal'];
      assert.ok(String(stamp).startsWith('2026:09:17 18:14:55'), `${kind}: ${stamp}`);
    }
  } finally {
    await closeMetadata();
  }
});

test('with the location switch off, coordinates are left exactly where they were', { skip: exiftoolMissing }, async () => {
  // The mirror of the test above, and what makes it mean something: the same fixture and
  // the same call with stripLocation false keeps every tag. Without this, a run that simply
  // failed to write anything would look identical to a successful strip.
  try {
    for (const kind of ['image', 'video']) {
      const { id, file } = await fileCarryingGps(kind);
      await applyMetadata({
        filePath: file,
        activity: gpsActivity(id, kind),
        student: GPS_STUDENT,
        tagChildName: true,
        tagNote: true,
        stripLocation: false,
        writeSidecar: false,
      });

      const after = await readRaw(file);
      assert.ok(
        Object.keys(after).some((k) => /GPS/i.test(k)),
        `${kind}: the coordinates went when nothing asked them to`,
      );
      assert.match(String(after['Composite:GPSPosition']), GPS_LAT_DMS, `${kind}: and they still read the same`);
    }
  } finally {
    await closeMetadata();
  }
});

// ---------------------------------------------------------------- without ExifTool

test('without ExifTool every file is still saved, unmodified, with the sidecar as the record', async () => {
  // Run a sync in a child process whose module loader refuses `exiftool-vendored`, which
  // is what a machine without the optional dependency looks like to this code.
  const hooks =
    `export async function resolve(s, c, next) {` +
    ` if (s === 'exiftool-vendored') throw new Error('simulated: not installed');` +
    ` return next(s, c); }`;
  const register =
    `import { register } from 'node:module';` +
    ` register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(hooks)}`)});`;
  const script = `
    import { mkdtemp, readFile } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    const m = await import(${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)});
    const f = await import(${JSON.stringify(new URL('../dist/mock/fixtures.js', import.meta.url).href)});
    const mock = await m.startMockBrightwheel({ validSession: 's', activitiesPerStudent: 12 });
    const client = new m.BrightwheelClient({ session: new m.Secret('s'), baseUrl: mock.url + '/api/v1', delayMs: 0 });
    const dir = await mkdtemp(join(tmpdir(), 'bw-noexif-'));
    const result = await m.sync(client, { ...m.DEFAULT_CONFIG, archiveDir: dir, incremental: false, delayMs: 0 }, () => {}, { allowTemporaryDir: true });
    const manifest = JSON.parse(await readFile(join(dir, 'archive.json'), 'utf8'));
    const untouched = [];
    for (const rec of manifest.files) {
      const id = rec.sourceId.replace('brightwheel:', '');
      const bytes = await readFile(join(dir, rec.path));
      const original = rec.path.endsWith('.mp4') ? f.placeholderMp4(id) : f.placeholderJpeg(id);
      untouched.push(bytes.equals(original));
    }
    console.log(JSON.stringify({ result, untouched }));
    await mock.close();
  `;
  const { stdout } = await run(process.execPath, [
    '--import', `data:text/javascript,${encodeURIComponent(register)}`,
    '--input-type=module', '-e', script,
  ]);
  const { result, untouched } = JSON.parse(stdout.trim().split('\n').pop());

  assert.equal(result.saved, 24);
  assert.equal(result.failed, 0);
  assert.ok(result.warnings.length > 0, 'the parent must be told the dates were not embedded');
  assert.match(result.warnings[0], /ExifTool is not installed/);
  assert.match(result.warnings[0], /alongside/, 'and told where the information went instead');
  assert.equal(untouched.length, 24);
  assert.ok(untouched.every(Boolean), 'without ExifTool no file may be altered at all');
});
