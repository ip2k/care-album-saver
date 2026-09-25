// First, before anything that can read the config directory or write an archive.
import { assertIsolatedConfigDir } from '../../../scripts/test-env.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BrightwheelClient,
  DEFAULT_CONFIG,
  Secret,
  photosStatus,
  startMockBrightwheel,
  sync,
} from '../dist/index.js';
import { Manifest, ManifestUnusableError, readManifestFile, usableRecord } from '../dist/ferry/manifest.js';
import { photoAt, records, summarise } from '../dist/gallery.js';
import { startWebUi } from '../dist/web/server.js';
import { configPath, writeSecureFile } from '../dist/paths.js';
import { auditArchive, findDuplicates, removeDuplicates, repairManifest } from '../dist/maintenance.js';

/**
 * The archive's list, archive.json, and the one rule for an entry of it — security review
 * NOTEs fs-8 and web-9, and the processes verifier's "every maintenance action fails":
 * `files: [null]` or a path that is not a string threw a raw TypeError out of the run, the
 * gallery, the Photos count and every maintenance action. Now the run refuses such a list in
 * words, the gallery and the count pass over the entry, and maintenance reports it and sets
 * it aside, relisting from disk whatever photo it stood for.
 *
 * Also here: the repair no longer copies a `.json` beside a photo into the list through a
 * symbolic link (the filesystem verifier), and the photo route (web-11, page-9) accepts only
 * digits for an index and serves nothing it does not know as media.
 */

const SESSION = 'test-session-value';
const SHA = 'ab'.repeat(32);

let mock;
before(assertIsolatedConfigDir);
before(async () => { mock = await startMockBrightwheel({ validSession: SESSION, activitiesPerStudent: 3 }); });
after(async () => { await mock?.close(); });

const client = () => new BrightwheelClient({ session: new Secret(SESSION), baseUrl: `${mock.url}/api/v1`, delayMs: 0 });
const configFor = (dir) => ({ ...DEFAULT_CONFIG, archiveDir: dir, delayMs: 0, incremental: false, includeStudents: ['stu-aaa-111'] });
const listOf = async (dir) => JSON.parse(await readFile(join(dir, 'archive.json'), 'utf8'));
const writeList = (dir, data) => writeFile(join(dir, 'archive.json'), JSON.stringify(data, null, 2));

/** An archive saved by a real run against the mock. */
async function saved(prefix) {
  const dir = await mkdtemp(join(tmpdir(), `cas-notes-list-${prefix}-`));
  const config = configFor(dir);
  const result = await sync(client(), config, () => {}, { allowTemporaryDir: true });
  assert.ok(result.saved >= 2, 'the mock saved something');
  return { dir, config };
}

const record = (path, extra = {}) => ({
  path,
  sourceId: null,
  transferId: null,
  bytes: 1,
  sha256: SHA,
  downloadedAt: '2026-09-23T10:00:00.000Z',
  ...extra,
});

// ---------------------------------------------------------------- the rule

test('fs-8: one rule for a usable entry: an object, a path, a SHA-256 or none, and a time', () => {
  assert.equal(usableRecord(record('Robin/2026-W38/a.jpg')), true);
  assert.equal(usableRecord(record('a.jpg', { sha256: '' })), true, 'an empty hash is allowed');
  assert.equal(usableRecord(record('a.jpg', { sha256: SHA.toUpperCase() })), true);
  for (const [why, entry] of [
    ['null', null],
    ['a number', 5],
    ['a string', 'Robin/a.jpg'],
    ['an array', [record('a.jpg')]],
    ['a path that is a number', record(5)],
    ['no path', { ...record('a.jpg'), path: undefined }],
    ['an empty path', record('')],
    ['a NUL in the path', record('a\u0000.jpg')],
    ['a hash that is not hex', record('a.jpg', { sha256: 'x'.repeat(64) })],
    ['a hash of the wrong length', record('a.jpg', { sha256: 'abc' })],
    ['a hash that is not a string', record('a.jpg', { sha256: 7 })],
    ['no hash', { ...record('a.jpg'), sha256: undefined }],
    ['no time', { ...record('a.jpg'), downloadedAt: undefined }],
    ['a time no clock can read', record('a.jpg', { downloadedAt: 'yesterday-ish' })],
  ]) {
    assert.equal(usableRecord(entry), false, why);
  }
});

// ---------------------------------------------------------------- the run

test('fs-8: a run refuses a list with an unusable entry in words, and changes nothing', async () => {
  const { dir, config } = await saved('run');
  try {
    const data = await listOf(dir);
    data.files.push(null);
    await writeList(dir, data);
    const before = await readFile(join(dir, 'archive.json'), 'utf8');

    await assert.rejects(sync(client(), config, () => {}, { allowTemporaryDir: true }), (error) => {
      assert.ok(error instanceof ManifestUnusableError, `${error.name}: ${error.message}`);
      assert.doesNotMatch(error.message, /TypeError|Cannot read|null/);
      assert.match(error.message, /one of its entries is not in the form this tool writes/);
      assert.match(error.message, new RegExp(`entry ${data.files.length} of ${data.files.length}`));
      assert.match(error.message, /check --repair/, 'the way out is named');
      assert.match(error.message, /Nothing has been changed/);
      return true;
    });
    await assert.rejects(Manifest.open(dir, 'brightwheel'), { name: 'ManifestUnusableError' });
    assert.equal(await readFile(join(dir, 'archive.json'), 'utf8'), before, 'the list is exactly as it was');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('fs-8: the whole-list refusals are unchanged, and a missing list is still a first run', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cas-notes-list-whole-'));
  try {
    assert.equal(await readManifestFile(dir), null);
    assert.equal((await Manifest.open(dir, 'brightwheel')).size, 0);
    await writeFile(join(dir, 'archive.json'), '{"schema": 2, "files": {}}');
    await assert.rejects(readManifestFile(dir), /does not contain a list of saved files/);
    await writeFile(join(dir, 'archive.json'), '{"schema": 3, "files": []}');
    await assert.rejects(readManifestFile(dir), /newer version/);
    await writeFile(join(dir, 'archive.json'), 'null');
    await assert.rejects(readManifestFile(dir), { name: 'ManifestUnusableError' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- the page

test('web-9: the gallery, the photo route and the Photos count pass over unusable entries instead of throwing', async () => {
  const { dir, config } = await saved('gallery');
  try {
    const data = await listOf(dir);
    const good = data.files.length;
    data.files.unshift(null, 7, 'x', { path: 5 }, { ...data.files[0], path: 12 }, { ...data.files[0], downloadedAt: 'never' });
    await writeList(dir, data);

    assert.equal((await records(config)).length, good);
    const summary = await summarise(config);
    assert.equal(summary.totalFiles, good);
    assert.equal(summary.lastRunCount, good);
    // The ids the page is given index the usable list, and the photo route reads the same one.
    for (const item of summary.recent) {
      const found = await photoAt(config, String(item.id));
      assert.ok(found, `photo ${item.id} is served`);
      assert.ok(found.path.endsWith(item.label));
    }
    const status = await photosStatus({ ...config, addToPhotos: true }, { platform: 'darwin' });
    assert.equal(status.problem, null);
    assert.equal(status.pending, good);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- maintenance

test('fs-8: the check counts unusable entries, the fix sets them aside and relists their photos, and runs start again', async () => {
  const { dir, config } = await saved('repair');
  try {
    const data = await listOf(dir);
    const total = data.files.length;
    const lost = data.files[0];
    // The first entry damaged (its photo is still on disk, and so is the .json beside it),
    // and two entries that were never anything.
    data.files[0] = { ...lost, path: 404 };
    data.files.push(null, { path: 'Robin/nothing.jpg', sha256: 'not a hash', downloadedAt: '2026-09-23T00:00:00Z' });
    await writeList(dir, data);

    const audit = await auditArchive(config);
    assert.equal(audit.unusable, 3);
    assert.equal(audit.recorded, total - 1);
    assert.deepEqual(audit.unrecorded, [lost.path], 'the damaged entry\'s photo is on disk, unlisted');
    assert.equal(audit.repairable, true);
    assert.match(audit.summary, /3 entries on the list are not in the form this tool writes/);
    assert.match(audit.summary, /no run can start until the list is fixed/);

    // Looking for duplicates does not fail over them either.
    const dupes = await findDuplicates(config);
    assert.equal(dupes.files, 0);

    const repair = await repairManifest(config);
    assert.equal(repair.unusable, 3);
    assert.equal(repair.added, 1);
    assert.match(repair.summary, /3 entries not in the form this tool writes were set aside/);

    const after = await listOf(dir);
    assert.equal(after.files.length, total);
    assert.ok(after.files.every(usableRecord));
    const relisted = after.files.find((r) => r.path === lost.path);
    assert.equal(relisted.sourceId, lost.sourceId, 'recognised again by Brightwheel\'s own id, from the .json beside it');
    assert.equal(relisted.sha256, lost.sha256);
    assert.deepEqual(after.state, data.state, 'the walk state is carried through');

    // And the next run starts, and fetches nothing it already has.
    const again = await sync(client(), config, () => {}, { allowTemporaryDir: true });
    assert.equal(again.saved, 0, 'nothing downloaded a second time');
    assert.equal(again.failed, 0);
    assert.equal((await auditArchive(config)).repairable, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('fs-8: removing a duplicate carries every other entry through untouched, an unusable one included', async () => {
  const { dir, config } = await saved('dupes');
  try {
    const data = await listOf(dir);
    const original = data.files[0];
    const copy = original.path.replace(/\.([a-z0-9]+)$/i, '-2.$1');
    await copyFile(join(dir, ...original.path.split('/')), join(dir, ...copy.split('/')));
    data.files.push({ ...original, path: copy, sourceId: `${original.sourceId}-again`, downloadedAt: new Date(Date.parse(original.downloadedAt) + 60_000).toISOString() });
    data.files.push(null);
    await writeList(dir, data);

    const report = await findDuplicates(config);
    assert.deepEqual(report.groups.map((g) => g.extra), [[copy]]);
    const removal = await removeDuplicates(config, { confirm: [copy] });
    assert.deepEqual(removal.removed, [copy]);

    const after = await listOf(dir);
    assert.equal(after.files.length, data.files.length - 1);
    assert.equal(after.files.at(-1), null, 'setting it aside is the repair\'s, said in its report — not this');
    assert.ok(!after.files.some((r) => r?.path === copy));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the repair reads the .json beside a photo only as an ordinary file, never through a link', { skip: process.platform === 'win32' ? 'symbolic links need a privilege on Windows' : false }, async () => {
  const { dir, config } = await saved('sidecar');
  const outside = await mkdtemp(join(tmpdir(), 'cas-notes-outside-'));
  try {
    const data = await listOf(dir);
    const [linked, plain, oddTypes] = data.files;
    // Three photos the list has lost, each with something different beside it.
    data.files = data.files.slice(3);
    await writeList(dir, data);
    // A link to a file elsewhere that looks like a sidecar and names someone else.
    const planted = join(outside, 'other.json');
    await writeFile(planted, JSON.stringify({ brightwheelActivityId: 'someone-elses', child: { id: 'stu-zzz', name: 'Outside Person' }, note: 'not ours', kind: 'image' }));
    const linkedSidecar = join(dir, ...linked.path.split('/')) + '.json';
    await rm(linkedSidecar);
    await symlink(planted, linkedSidecar);
    // A sidecar in place, whose fields have types this tool never writes.
    const oddSidecar = join(dir, ...oddTypes.path.split('/')) + '.json';
    await writeFile(oddSidecar, JSON.stringify({ brightwheelActivityId: { $gt: '' }, child: { id: 5, name: ['x'] }, note: 42, postedBy: {}, kind: 'image' }));

    const repair = await repairManifest(config);
    assert.equal(repair.added, 3);
    const after = await listOf(dir);
    const byPath = (p) => after.files.find((r) => r.path === p);

    const fromLink = byPath(linked.path);
    assert.equal(fromLink.sourceId, null, 'nothing from the file the link points at');
    assert.equal(JSON.stringify(fromLink.provenance).includes('Outside Person'), false);
    assert.equal(JSON.stringify(fromLink.provenance).includes('not ours'), false);

    // The ordinary sidecar is still read, as it always was.
    const fromPlain = byPath(plain.path);
    assert.equal(fromPlain.sourceId, plain.sourceId);
    assert.equal(fromPlain.provenance.studentName, 'Robin Maple');

    const fromOdd = byPath(oddTypes.path);
    assert.equal(fromOdd.sourceId, null);
    assert.equal(fromOdd.provenance.studentId, undefined);
    assert.equal(fromOdd.provenance.studentName, undefined);
    assert.equal(fromOdd.provenance.note, undefined);
    assert.equal(fromOdd.provenance.author, undefined);
    assert.equal(fromOdd.provenance.kind, 'image');
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- the photo route

async function looseArchive(names) {
  const dir = await mkdtemp(join(tmpdir(), 'cas-notes-photo-'));
  await mkdir(join(dir, 'Robin'), { recursive: true });
  for (const name of names) await writeFile(join(dir, 'Robin', name), 'bytes');
  await writeList(dir, { schema: 2, source: 'brightwheel', files: names.map((n) => record(`Robin/${n}`)) });
  return { dir, config: { ...DEFAULT_CONFIG, archiveDir: dir } };
}

test('page-9, the server half: an unknown type is sent as a download, a photo is not', async () => {
  const { dir, config } = await looseArchive(['a.jpg', 'l.html', 'noextension']);
  process.env.CARE_ALBUM_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'cas-notes-photo-config-'));
  assertIsolatedConfigDir();
  await writeSecureFile(configPath(), JSON.stringify(config));
  // An address that is never asked: /photo reads the disk only.
  const ui = await startWebUi({ baseUrl: 'http://127.0.0.1:9/api/v1' });
  try {
    const get = (i) => fetch(`http://127.0.0.1:${ui.port}/photo?i=${i}`, { headers: { 'x-setup-token': ui.token } });
    const jpg = await get(0);
    assert.equal(jpg.headers.get('content-type'), 'image/jpeg');
    assert.equal(jpg.headers.get('content-disposition'), null, 'a photo is shown');
    for (const i of [1, 2]) {
      const other = await get(i);
      assert.equal(other.status, 200);
      assert.equal(other.headers.get('content-type'), 'application/octet-stream');
      assert.equal(other.headers.get('content-disposition'), 'attachment');
      await other.arrayBuffer();
    }
    await jpg.arrayBuffer();
  } finally {
    await ui.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('web-11: the photo route takes an index written in digits and nothing else', async () => {
  const { dir, config } = await looseArchive(['a.jpg', 'b.jpg']);
  try {
    assert.ok(await photoAt(config, '0'));
    assert.ok(await photoAt(config, '1'));
    for (const spelling of ['0x1', '0b1', '0o1', '1e0', '1.', '1.0', ' 1', '1 ', '+1', '-0', '', '١', 'Infinity', '1n', null, '9'.repeat(40)]) {
      assert.equal(await photoAt(config, spelling), null, JSON.stringify(spelling));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('page-9: the photo route serves media as media and anything else as a download, never as a document', async () => {
  const media = {
    'a.jpg': 'image/jpeg', 'b.JPEG': 'image/jpeg', 'c.png': 'image/png', 'd.heic': 'image/heic', 'e.webp': 'image/webp',
    'f.gif': 'image/gif', 'g.mp4': 'video/mp4', 'h.m4v': 'video/mp4', 'i.mov': 'video/quicktime',
  };
  const documents = ['j.svg', 'k.svgz', 'l.html', 'm.htm', 'n.xhtml', 'o.xml', 'p.xsl', 'q.pdf', 'r.js', 's.txt', 'noextension', 't.jpg.html'];
  const names = [...Object.keys(media), ...documents];
  const { dir, config } = await looseArchive(names);
  try {
    for (const [i, name] of names.entries()) {
      const found = await photoAt(config, String(i));
      assert.ok(found, name);
      assert.doesNotMatch(found.type, /svg|html|xml/i, `${name} must never be served as a document`);
      if (name in media) assert.equal(found.type, media[name], name);
      else assert.equal(found.type, 'application/octet-stream', name);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
