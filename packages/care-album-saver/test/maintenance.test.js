// First, before anything that can read the config directory: points this file at a
// throwaway one even when it is run on its own with `node --test`, which applies no
// --import (see scripts/test-env.js).
import { assertIsolatedConfigDir } from '../../../scripts/test-env.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BrightwheelClient, DEFAULT_CONFIG, Secret, startMockBrightwheel, sync } from '../dist/index.js';
import {
  auditArchive,
  checkChildren,
  findDuplicates,
  humanBytes,
  removeDuplicates,
  repairManifest,
} from '../dist/maintenance.js';

/**
 * Looking after an archive a year after it was set up.
 *
 * These run against a real archive — the mock's invented children, downloaded to a real
 * folder, with a real manifest — because every one of them is about the folder and the
 * manifest disagreeing, and a stubbed filesystem cannot disagree with itself.
 */

let mock;
const SESSION = 'test-session-value';
const ROBIN = 'stu-aaa-111';
const SAM = 'stu-bbb-222';

before(assertIsolatedConfigDir);
before(async () => { mock = await startMockBrightwheel({ validSession: SESSION, activitiesPerStudent: 4 }); });
after(async () => { await mock?.close(); });

const client = () =>
  new BrightwheelClient({ session: new Secret(SESSION), baseUrl: mock.url + '/api/v1', delayMs: 0 });

/**
 * An archive with photos really in it.
 *
 * `allowTemporaryDir` is the test-only door in `checkArchiveDir`: the validator refuses a
 * temporary folder outright, and this suite has to archive into one.
 */
async function archive({ includeStudents = [] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'bw-maint-'));
  const config = { ...DEFAULT_CONFIG, archiveDir: dir, includeStudents, incremental: false, delayMs: 0 };
  const result = await sync(client(), config, () => {}, { allowTemporaryDir: true });
  assert.ok(result.saved > 0, 'the fixture archive must actually contain photos');
  return { dir, config, result };
}

const manifestPath = (dir) => join(dir, 'archive.json');
const readManifest = async (dir) => JSON.parse(await readFile(manifestPath(dir), 'utf8'));
async function writeManifest(dir, data) {
  await writeFile(manifestPath(dir), JSON.stringify(data, null, 2), 'utf8');
}
const exists = (path) => stat(path).then(() => true, () => false);

/** Every file under the archive, so a test can prove nothing was touched. */
async function allFiles(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) found.push(join(entry.parentPath ?? entry.path, entry.name));
  }
  return found.sort();
}

// ---------------------------------------------------------------- who is on the account

test('a child added to the account is noticed, and offered rather than assumed', async () => {
  // Only Robin has ever been archived; Sam is on the account and has nothing saved.
  const { dir, config } = await archive({ includeStudents: [ROBIN] });
  try {
    const check = await checkChildren(client(), config);

    assert.deepEqual(check.onAccount.map((c) => c.name).sort(), ['Robin Maple', 'Sam Maple']);
    assert.deepEqual(check.inArchive.map((c) => c.name), ['Robin Maple']);
    assert.deepEqual(check.added.map((c) => c.name), ['Sam Maple']);
    assert.deepEqual(check.removed, []);
    // The settings name Robin only, so Sam is excluded — which is the thing worth offering.
    assert.deepEqual(check.notIncluded.map((c) => c.name), ['Sam Maple']);
    assert.match(check.summary, /Sam Maple is on the account and has\s+no photos saved yet/);
    assert.match(check.summary, /leave out Sam Maple/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a child who has left is reported without a word suggesting their photos are at risk', async () => {
  const { dir, config } = await archive({ includeStudents: [ROBIN, SAM] });
  try {
    // A third child, archived at some point, who is no longer on the account.
    const data = await readManifest(dir);
    const first = { ...data.files[0] };
    first.path = 'Alex-Maple/2025-W10/2025-03-03_090000_old.jpg';
    first.sourceId = 'brightwheel:act-old-1';
    first.sha256 = 'a'.repeat(64);
    first.provenance = { ...first.provenance, studentId: 'stu-ccc-333', studentName: 'Alex Maple' };
    data.files.push(first);
    await writeManifest(dir, data);

    const check = await checkChildren(client(), config);
    assert.deepEqual(check.removed.map((c) => c.name), ['Alex Maple']);
    assert.match(check.summary, /Alex Maple is no longer on the Brightwheel account/);
    assert.match(check.summary, /photos already saved are untouched/i);
    // And nothing was done about it. Saying so is the whole action.
    assert.equal((await readManifest(dir)).files.length, data.files.length);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('nothing having changed is said plainly, not as an empty report', async () => {
  const { dir, config } = await archive();
  try {
    const check = await checkChildren(client(), config);
    assert.deepEqual(check.added, []);
    assert.deepEqual(check.removed, []);
    assert.deepEqual(check.notIncluded, []);
    assert.match(check.summary, /Nothing has changed/);
    assert.match(check.summary, /Robin Maple and Sam Maple/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- the folder against the list

test('a freshly saved archive agrees with its own list', async () => {
  const { dir, config, result } = await archive();
  try {
    const audit = await auditArchive(config);
    assert.deepEqual(audit.unrecorded, []);
    assert.deepEqual(audit.missing, []);
    assert.equal(audit.repairable, false);
    assert.equal(audit.onDisk, result.saved, 'the photos on disk are the photos that were saved');
    assert.equal(audit.recorded, result.saved);
    assert.ok(audit.bytesOnDisk > 0);
    assert.match(audit.summary, /Everything matches/);
    // The .json sidecar beside each photo and each week's README are about photos, not
    // photos: counting them would report an archive twice the size it is.
    assert.match(audit.summary, new RegExp(String(result.saved) + ' photos and videos on disk'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a file nobody recorded and a record whose file is gone are both found, and fixed without downloading', async () => {
  const { dir, config } = await archive();
  try {
    const before = await readManifest(dir);
    const victim = before.files[0];
    const victimAbsolute = join(dir, ...victim.path.split('/'));

    // A run force-quit between the download and the manifest save: the file is there and
    // nothing knows about it. Copied from a real photo so it has real bytes to hash.
    const stray = join(dirname(victimAbsolute), 'unrecorded-copy.jpg');
    await copyFile(victimAbsolute, stray);
    await copyFile(victimAbsolute + '.json', stray + '.json');
    // ...and a photo tidied away by hand, leaving a record pointing at nothing.
    const orphan = before.files[1];
    await rm(join(dir, ...orphan.path.split('/')));

    const audit = await auditArchive(config);
    const strayRel = victim.path.split('/').slice(0, -1).concat('unrecorded-copy.jpg').join('/');
    assert.deepEqual(audit.unrecorded, [strayRel]);
    assert.deepEqual(audit.missing, [orphan.path]);
    assert.equal(audit.repairable, true);
    assert.match(audit.summary, /would download it a second time/);
    assert.match(audit.summary, /moved, deleted, or on a drive that is not plugged in/);

    // Auditing is a question, not an action.
    assert.equal((await readManifest(dir)).files.length, before.files.length);

    const filesBefore = await allFiles(dir);
    const repair = await repairManifest(config);
    assert.equal(repair.added, 1);
    assert.equal(repair.dropped, 1);
    assert.match(repair.summary, /will not be downloaded again/);
    assert.match(repair.summary, /will fetch it again/);

    // The list changed; not one photo did.
    const filesAfter = await allFiles(dir);
    assert.deepEqual(filesAfter, filesBefore, 'a repair must not move, write or delete any photo');

    const after = await auditArchive(config);
    assert.deepEqual(after.unrecorded, []);
    assert.deepEqual(after.missing, []);
    assert.equal(after.repairable, false);

    // The recovered record carries what the sidecar still knew, so the next run recognises
    // the post rather than merely the bytes.
    const recovered = (await readManifest(dir)).files.find((f) => f.path === strayRel);
    assert.match(recovered.sourceId, /^brightwheel:/);
    assert.equal(recovered.sha256, victim.sha256);
    assert.equal(recovered.provenance.studentName, victim.provenance.studentName);
    assert.equal(recovered.transferId, null, 'a URL that cannot be known must not be invented');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- photos saved twice

/** The same photo on disk twice, both copies recorded — what a force-quit run leaves. */
async function withDuplicate(dir) {
  const data = await readManifest(dir);
  const original = data.files[0];
  const absolute = join(dir, ...original.path.split('/'));
  const copyRel = original.path.replace(/\.([a-z0-9]+)$/i, '-2.$1');
  const copyAbsolute = join(dir, ...copyRel.split('/'));
  await copyFile(absolute, copyAbsolute);
  await copyFile(absolute + '.json', copyAbsolute + '.json');
  data.files.push({
    ...original,
    path: copyRel,
    sourceId: original.sourceId + '-again',
    downloadedAt: new Date(Date.parse(original.downloadedAt) + 60_000).toISOString(),
  });
  await writeManifest(dir, data);
  return { original: original.path, copy: copyRel, copyAbsolute, absolute };
}

test('finding duplicates reports them and deletes nothing at all', async () => {
  const { dir, config } = await archive();
  try {
    const { original, copy, copyAbsolute, absolute } = await withDuplicate(dir);
    const filesBefore = await allFiles(dir);

    const report = await findDuplicates(config);
    assert.equal(report.groups.length, 1);
    assert.equal(report.files, 1);
    assert.ok(report.bytes > 0);
    // The first copy saved is the one that stays; the later one is the extra.
    assert.equal(report.groups[0].keep, original);
    assert.deepEqual(report.groups[0].extra, [copy]);
    assert.match(report.summary, /Nothing has been deleted/);

    assert.deepEqual(await allFiles(dir), filesBefore, 'a report must leave every file where it was');
    assert.equal(await exists(copyAbsolute), true);
    assert.equal(await exists(absolute), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('deleting a duplicate needs the exact file named back, and refuses anything else', async () => {
  const { dir, config } = await archive();
  try {
    const { original, copy, copyAbsolute, absolute } = await withDuplicate(dir);

    // No list at all: a boolean "yes" is not something this function accepts.
    await assert.rejects(() => removeDuplicates(config, { confirm: [] }), /nothing was deleted/i);
    await assert.rejects(() => removeDuplicates(config, {}), /nothing was deleted/i);
    // A path that is not one of the extras — a stale page, or the copy that should stay.
    await assert.rejects(() => removeDuplicates(config, { confirm: [original] }), /no longer a second copy/i);
    await assert.rejects(
      () => removeDuplicates(config, { confirm: [copy, 'Robin-Maple/2026-W38/invented.jpg'] }),
      /no longer a second copy/i,
    );
    assert.equal(await exists(copyAbsolute), true, 'a refused request deletes nothing, not even the valid half');

    const done = await removeDuplicates(config, { confirm: [copy] });
    assert.deepEqual(done.removed, [copy]);
    assert.ok(done.bytes > 0);
    assert.match(done.summary, /still here/);

    assert.equal(await exists(copyAbsolute), false, 'the extra copy is gone');
    assert.equal(await exists(copyAbsolute + '.json'), false, 'and so is the note describing it');
    assert.equal(await exists(absolute), true, 'the photo it was a copy of is untouched');
    assert.equal(await exists(absolute + '.json'), true);

    const paths = (await readManifest(dir)).files.map((f) => f.path);
    assert.ok(!paths.includes(copy), 'the list no longer mentions it');
    assert.ok(paths.includes(original));

    assert.equal((await findDuplicates(config)).files, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a record whose file is already gone is not offered as a duplicate to delete', async () => {
  const { dir, config } = await archive();
  try {
    const { copy, copyAbsolute } = await withDuplicate(dir);
    // The parent deleted the copy in Finder between the report and the press.
    await rm(copyAbsolute);
    const report = await findDuplicates(config);
    assert.equal(report.files, 0, 'two records and one file is not a duplicate');
    await assert.rejects(() => removeDuplicates(config, { confirm: [copy] }), /no longer a second copy/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('sizes are said the way a parent reads them', () => {
  assert.equal(humanBytes(0), '0 bytes');
  assert.equal(humanBytes(999), '999 bytes');
  assert.equal(humanBytes(1500), '1.5 KB');
  assert.equal(humanBytes(15_000), '15 KB');
  assert.equal(humanBytes(2_400_000_000), '2.4 GB');
});

// ---------------------------------------------------------------- an empty archive

test('an archive nothing has been saved into yet answers every question without failing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bw-maint-empty-'));
  await mkdir(dir, { recursive: true });
  const config = { ...DEFAULT_CONFIG, archiveDir: dir };
  try {
    const audit = await auditArchive(config);
    assert.equal(audit.recorded, 0);
    assert.equal(audit.onDisk, 0);
    assert.equal(audit.repairable, false);
    assert.equal((await findDuplicates(config)).files, 0);
    const check = await checkChildren(client(), config);
    assert.deepEqual(check.inArchive, []);
    assert.deepEqual(check.added.map((c) => c.name).sort(), ['Robin Maple', 'Sam Maple']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
