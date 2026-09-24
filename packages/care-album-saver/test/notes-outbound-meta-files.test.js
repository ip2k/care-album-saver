// First, before anything that can read the config directory or the archive folder.
import { assertIsolatedConfigDir, exifToolSkipReason } from '../../../scripts/test-env.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BrightwheelClient, DEFAULT_CONFIG, Secret, applyMetadata, buildTags, startMockBrightwheel, sync } from '../dist/index.js';
import { closeMetadata } from '../dist/metadata.js';
import { placeholderJpeg } from '../dist/mock/fixtures.js';

/**
 * The security review's NOTE-level findings for what the tool writes into the archive
 * (docs/SECURITY-REVIEW-2026-09-23.md §4.3):
 *
 *  - fs-12: a NUL in a note made ExifTool refuse the whole write, so the photo lost its dates
 *    and its location strip too, and the refusal quoted the note.
 *  - fs-10: every file but archive.json took the umask's mode, so a terminal run and the
 *    daily job left different modes in one archive.
 */

const exiftoolMissing = await exifToolSkipReason(() => import('exiftool-vendored'));
const posixOnly = { skip: process.platform === 'win32' ? 'Windows has no POSIX modes' : false };
const SESSION = 'test-session-value';

let mock;
before(async () => {
  assertIsolatedConfigDir();
  mock = await startMockBrightwheel({ validSession: SESSION, activitiesPerStudent: 4 });
});
after(async () => {
  await mock?.close();
  await closeMetadata();
});

const STUDENT = { id: 'stu-x', firstName: 'Robin', lastName: 'Maple', fullName: 'Robin\u0000 Maple', schoolName: 'Example\u0001 Care Provider' };
const ACTIVITY = {
  id: 'act-1',
  studentId: 'stu-x',
  postedAt: new Date('2026-09-18T09:15:00'),
  note: 'Robin painted.\u0000\nThen a nap.\u001b',
  url: 'https://example.invalid/a.jpg',
  kind: 'image',
  author: 'Ms.\u0000 Alvarez',
};
const input = (filePath, extra = {}) => ({
  filePath,
  activity: ACTIVITY,
  student: STUDENT,
  tagChildName: true,
  tagNote: true,
  stripLocation: true,
  writeSidecar: false,
  ...extra,
});

// ------------------------------------------------------------------ fs-12

test('fs-12: nothing ExifTool will refuse reaches a tag, and line breaks in a note survive', () => {
  for (const kind of ['image', 'video']) {
    const tags = buildTags(input('/dev/null', { activity: { ...ACTIVITY, kind } }));
    const all = JSON.stringify(tags);
    assert.ok(!/\\u000[0-8b-f]|\\u001|\\u007f|\\u00[89]/.test(all), `${kind}: no control character but \\t \\n \\r: ${all}`);
    assert.equal(tags['XMP-dc:description'], 'Robin painted.\nThen a nap.', `${kind}: the note's own line break is kept`);
    assert.deepEqual(tags['XMP-iptcExt:PersonInImage'], ['Robin Maple']);
    assert.deepEqual(tags['XMP-dc:creator'], ['Ms. Alvarez']);
    assert.equal(tags['XMP-iptcExt:LocationCreatedSublocation'], 'Example Care Provider');
  }
});

test('fs-12: a note with a NUL in it no longer costs the photo its dates', { skip: exiftoolMissing }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cas-fs12-'));
  const file = join(dir, 'photo.jpg');
  await writeFile(file, placeholderJpeg('fs12'));
  const outcome = await applyMetadata(input(file));
  assert.equal(outcome.embedded, true, outcome.reason ?? '');

  const { ExifTool } = await import('exiftool-vendored');
  const reader = new ExifTool();
  try {
    const tags = await reader.read(file);
    assert.equal(tags.Description, 'Robin painted.\nThen a nap.', 'the note went in, without what was refused');
    assert.ok(tags.DateTimeOriginal, 'and the dates went in with it');
  } finally {
    await reader.end();
  }
});

test('fs-12: a write ExifTool refuses says the location was not removed either', { skip: exiftoolMissing }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cas-fs12-bad-'));
  const file = join(dir, 'photo.jpg');
  await writeFile(file, 'not a photograph at all');

  const asked = await applyMetadata(input(file));
  assert.equal(asked.embedded, false);
  assert.equal(asked.sidecar, true, 'the .json is still written, so nothing is lost');
  assert.match(asked.reason, /ExifTool could not write into this photo/);
  assert.match(asked.reason, /only in the \.json file/);
  assert.match(asked.reason, /location information could not be removed/i, 'the switch is on; the parent must hear it did not happen');
  assert.match(asked.reason, /still there/);
  assert.ok(!asked.reason.includes('Robin'), 'and the refusal does not quote what was being written');

  const notAsked = await applyMetadata(input(file, { stripLocation: false }));
  assert.equal(notAsked.embedded, false);
  assert.ok(!/location/i.test(notAsked.reason), 'with the switch off there is nothing to report about location');
});

// ------------------------------------------------------------------ fs-10

async function filesUnder(root) {
  const out = [];
  for (const entry of await readdir(root, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) out.push(join(entry.parentPath ?? entry.path, entry.name));
  }
  return out;
}

test('fs-10: every file a run writes into the archive is owner-only, whatever the umask', posixOnly, async () => {
  // The interactive case: a terminal's usual umask, under which these used to be 0644.
  const previous = process.umask(0o022);
  try {
    const dir = await mkdtemp(join(tmpdir(), 'cas-fs10-'));
    const client = new BrightwheelClient({ session: new Secret(SESSION), baseUrl: `${mock.url}/api/v1`, delayMs: 0 });
    const config = { ...DEFAULT_CONFIG, archiveDir: dir, incremental: false, delayMs: 0, writeSidecar: !exiftoolMissing };
    const result = await sync(client, config, () => {}, { allowTemporaryDir: true });
    assert.equal(result.failed, 0, result.warnings.join('; '));
    assert.ok(result.saved > 0);

    const files = await filesUnder(dir);
    const names = files.map((f) => f.slice(dir.length + 1));
    assert.ok(names.some((n) => /\.jpg$/.test(n)), 'photos');
    assert.ok(names.some((n) => /\.jpg\.json$/.test(n)), 'their sidecars');
    assert.ok(names.some((n) => /README\.md$/.test(n)), 'the week READMEs');
    if (!exiftoolMissing) assert.ok(names.some((n) => /\.xmp$/.test(n)), 'the .xmp sidecars ExifTool writes');
    for (const file of files) {
      const mode = (await stat(file)).mode & 0o777;
      assert.equal(mode.toString(8), '600', file.slice(dir.length + 1));
    }
  } finally {
    process.umask(previous);
  }
});
