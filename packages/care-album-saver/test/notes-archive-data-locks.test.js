// First, before anything that can read the config directory or write an archive.
import { assertIsolatedConfigDir } from '../../../scripts/test-env.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, open, readdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BrightwheelClient,
  DEFAULT_CONFIG,
  RUN_LOCK_FILENAME,
  Secret,
  addToPhotos,
  startMockBrightwheel,
  sync,
  takeRunLock,
} from '../dist/index.js';
import { RunLockUnusableError, runLockRefusal, setAsideIfUnchanged, sightLock, writeLockOrRemove } from '../dist/run-lock.js';

/**
 * The two locks — the archive folder's run lock and the Photos step's own — as the security
 * review's NOTEs left them (docs/SECURITY-REVIEW-2026-09-23.md §4.3):
 *
 *  - fs-7: two runs that judged the same abandoned lock at once could both end up holding it,
 *    because the lock was removed by name. It is now removed only by the one taker holding a
 *    small guard file, and only if it is still the lock that was judged; moved aside first.
 *    (Rename-and-compare alone was tried first: three takers at once still got two holders.)
 *  - "lock not a file" (the filesystem verifier): a dangling link at the lock's name refused
 *    every run for ever as a benign "another run is already saving photos"; a folder there
 *    threw a raw EISDIR. Both are now a failure that says what to do.
 *  - processes-10: a lock written on another computer was honoured as long as it kept being
 *    refreshed; now for a day at most, unless a live process here may be its holder.
 *  - processes-6: the Photos lock had the same takeover race, left an empty lock behind when
 *    its write failed, and its release removed whatever lock was there.
 */

const SESSION = 'test-session-value';
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

let mock;
before(assertIsolatedConfigDir);
before(async () => { mock = await startMockBrightwheel({ validSession: SESSION, activitiesPerStudent: 3 }); });
after(async () => { await mock?.close(); });

const exists = (p) => stat(p).then(() => true, () => false);
const hoursAgo = (h) => new Date(Date.now() - h * 60 * 60 * 1000);
const posixOnly = process.platform === 'win32' ? 'symbolic links need a privilege on Windows' : false;

/** A process id that is not running here. */
function deadPid() {
  for (let pid = 999_983; pid > 900_000; pid -= 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') return pid;
    }
  }
  throw new Error('no free process id found');
}

async function folder(prefix) {
  return mkdtemp(join(tmpdir(), `cas-notes-lock-${prefix}-`));
}

const litter = async (dir) => (await readdir(dir)).filter((n) => n.includes('.stale-') || n.endsWith('.takeover'));

// ---------------------------------------------------------------- fs-7: taking over by rename

test('fs-7: of three runs that find the same abandoned lock at once, exactly one holds the folder', async () => {
  const dead = deadPid();
  for (let round = 0; round < 25; round += 1) {
    const dir = await folder('race');
    const file = join(dir, RUN_LOCK_FILENAME);
    try {
      // Left by a run on this computer whose process has gone: abandoned, however fresh.
      await writeFile(file, JSON.stringify({ pid: dead, host: hostname(), startedAt: hoursAgo(1).toISOString(), purpose: 'run' }));
      const outcomes = await Promise.allSettled([takeRunLock(dir), takeRunLock(dir), takeRunLock(dir)]);
      const held = outcomes.filter((o) => o.status === 'fulfilled');
      const refused = outcomes.filter((o) => o.status === 'rejected');
      assert.equal(held.length, 1, `round ${round}: one holder, not ${held.length}`);
      for (const r of refused) assert.equal(r.reason.name, 'RunInProgressError', `round ${round}: ${r.reason.message}`);
      // The lock on disk is the winner's, and nothing was left lying about.
      const onDisk = JSON.parse(await readFile(file, 'utf8'));
      assert.equal(onDisk.pid, process.pid);
      assert.deepEqual(await litter(dir), [], 'no lock moved aside is left behind');
      await held[0].value.release();
      assert.equal(await exists(file), false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test('fs-7: a lock that is no longer the one judged is left alone, and one still the same is removed', async () => {
  const dir = await folder('aside');
  const file = join(dir, RUN_LOCK_FILENAME);
  try {
    // What the slower run judged: an abandoned lock, an hour unrefreshed.
    await writeFile(file, JSON.stringify({ pid: 1, host: 'another-mac', startedAt: hoursAgo(2).toISOString() }));
    await utimes(file, hoursAgo(1), hoursAgo(1));
    const judged = await sightLock(file);
    // Meanwhile the faster run set it aside and made its own lock in its place.
    await rm(file);
    const fresh = JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString(), token: 'faster' });
    await writeFile(file, fresh);
    const before = (await stat(file)).mtimeMs;

    await setAsideIfUnchanged(file, judged);
    assert.equal(await readFile(file, 'utf8'), fresh, 'the faster run keeps its lock');
    assert.equal((await stat(file)).mtimeMs, before, 'untouched');
    assert.deepEqual(await litter(dir), []);

    // The same call against the lock it judged removes it, and against nothing does nothing.
    const now = await sightLock(file);
    await setAsideIfUnchanged(file, now);
    assert.equal(await exists(file), false);
    await setAsideIfUnchanged(file, now);
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('fs-7: a lock refreshed after it was judged abandoned is not removed', async () => {
  const dir = await folder('refreshed');
  const file = join(dir, RUN_LOCK_FILENAME);
  try {
    const text = JSON.stringify({ pid: 1, host: 'another-mac', startedAt: hoursAgo(2).toISOString() });
    await writeFile(file, text);
    await utimes(file, hoursAgo(1), hoursAgo(1));
    const judged = await sightLock(file);
    // Its holder wakes and refreshes it before the rename.
    await utimes(file, new Date(), new Date());
    await setAsideIfUnchanged(file, judged);
    assert.equal(await readFile(file, 'utf8'), text);
    assert.ok(Date.now() - (await stat(file)).mtimeMs < 60_000, 'still the refreshed lock');
    assert.deepEqual(await litter(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('fs-7: a takeover guard left by a process that died is cleared; one in use makes the taker wait its turn', async () => {
  const dir = await folder('guard');
  const file = join(dir, RUN_LOCK_FILENAME);
  const guard = `${file}.takeover`;
  const stale = JSON.stringify({ pid: deadPid(), host: hostname(), startedAt: hoursAgo(1).toISOString() });
  try {
    // Another taker is in the middle of it: this one gives it its moment, and removes nothing.
    await writeFile(file, stale);
    await writeFile(guard, '4242 busy\n');
    await assert.rejects(takeRunLock(dir), { name: 'RunInProgressError' });
    assert.equal(await readFile(file, 'utf8'), stale, 'the lock is the guard holder\'s to remove');
    assert.equal(await readFile(guard, 'utf8'), '4242 busy\n');

    // The guard of a process that died in the middle, minutes ago: cleared, and the lock taken.
    await utimes(guard, hoursAgo(0.1), hoursAgo(0.1));
    const lock = await takeRunLock(dir);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).pid, process.pid);
    assert.deepEqual(await litter(dir), []);
    await lock.release();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a lock whose write fails is taken away again, not left empty to refuse every run', async () => {
  const dir = await folder('write');
  const file = join(dir, RUN_LOCK_FILENAME);
  try {
    const handle = await open(file, 'wx', 0o600);
    // A closed handle cannot be written to: the write fails, as on a full disk.
    await handle.close();
    await assert.rejects(writeLockOrRemove(handle, file, '{"pid":1}'));
    assert.equal(await exists(file), false, 'no empty lock left behind');
    // And the folder can be taken at once.
    const lock = await takeRunLock(dir);
    await lock.release();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- the lock is not a file

test('a dangling link at the lock\'s name is a failure that says what to do, not "another run is saving"', { skip: posixOnly }, async () => {
  const dir = await folder('dangling');
  const file = join(dir, RUN_LOCK_FILENAME);
  try {
    await symlink(join(dir, 'nowhere', 'at-all'), file);
    await assert.rejects(takeRunLock(dir), (error) => {
      assert.ok(error instanceof RunLockUnusableError, `${error.name}: ${error.message}`);
      assert.notEqual(error.name, 'RunInProgressError');
      assert.match(error.message, /not the lock file this tool makes/);
      assert.match(error.message, /a link/);
      assert.match(error.message, /Move it out of that folder/);
      return true;
    });
    assert.equal(await runLockRefusal(dir, 'check'), null, 'a look at the folder is not refused by it');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a link at the lock\'s name to a real file is neither read through, refreshed through nor removed', { skip: posixOnly }, async () => {
  const dir = await folder('link');
  const elsewhere = await folder('elsewhere');
  const target = join(elsewhere, 'someone-elses.json');
  const file = join(dir, RUN_LOCK_FILENAME);
  try {
    const text = JSON.stringify({ pid: deadPid(), host: hostname(), startedAt: hoursAgo(5).toISOString() });
    await writeFile(target, text);
    await utimes(target, hoursAgo(5), hoursAgo(5));
    await symlink(target, file);
    await assert.rejects(takeRunLock(dir), { name: 'RunLockUnusableError' });
    assert.equal(await readFile(target, 'utf8'), text, 'the file it points at is untouched');
    assert.ok(Date.now() - (await stat(target)).mtimeMs > 4 * 60 * 60 * 1000, 'and not refreshed');
    assert.ok(await exists(file), 'the link is left for a person to look at');
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(elsewhere, { recursive: true, force: true });
  }
});

test('a folder at the lock\'s name is the same clear failure, never a raw EISDIR, however old it is', async () => {
  const dir = await folder('dir');
  const file = join(dir, RUN_LOCK_FILENAME);
  try {
    await mkdir(file);
    await writeFile(join(file, 'inside.txt'), 'kept');
    await utimes(file, hoursAgo(3), hoursAgo(3)).catch(() => {}); // a folder's time, where the platform lets it be set
    await assert.rejects(takeRunLock(dir), (error) => {
      assert.equal(error.name, 'RunLockUnusableError');
      assert.match(error.message, /a folder/);
      assert.equal(error.code, undefined, 'not the filesystem\'s own error');
      return true;
    });
    assert.equal(await readFile(join(file, 'inside.txt'), 'utf8'), 'kept', 'nothing in it was touched');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a run meeting a folder at the lock\'s name fails with that message, and asks Brightwheel nothing', async () => {
  const dir = join(REPO_ROOT, 'node_modules', '.cache', `cas-notes-lockdir-${process.pid}-${Date.now()}`);
  await mkdir(join(dir, RUN_LOCK_FILENAME), { recursive: true });
  try {
    const before = mock.requests?.length;
    const client = new BrightwheelClient({ session: new Secret(SESSION), baseUrl: `${mock.url}/api/v1`, delayMs: 0 });
    await assert.rejects(
      sync(client, { ...DEFAULT_CONFIG, archiveDir: dir, delayMs: 0 }, () => {}),
      { name: 'RunLockUnusableError' },
    );
    if (before !== undefined) assert.equal(mock.requests.length, before);
    assert.equal(await exists(join(dir, 'archive.json')), false, 'nothing was written');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- processes-10: another computer's lock

test('processes-10: another computer\'s lock is honoured while it is refreshed, but for a day at most', async () => {
  const dir = await folder('foreign');
  const file = join(dir, RUN_LOCK_FILENAME);
  const plant = (startedAt) => writeFile(file, JSON.stringify({ pid: 4242, host: 'another-mac.example', startedAt }));
  try {
    // Taken an hour ago and refreshed just now: somebody is working, whatever computer it is.
    await plant(hoursAgo(1).toISOString());
    await assert.rejects(takeRunLock(dir), { name: 'RunInProgressError' });
    assert.ok(await runLockRefusal(dir, 'check'));

    // Taken more than a day ago, and still being refreshed: set aside.
    for (const startedAt of [hoursAgo(25).toISOString(), new Date(Date.now() + 49 * 3600 * 1000).toISOString(), 'not a time']) {
      await plant(startedAt);
      assert.equal(await runLockRefusal(dir, 'check'), null, `${startedAt}: not plainly in use`);
      const lock = await takeRunLock(dir);
      assert.equal(JSON.parse(await readFile(file, 'utf8')).pid, process.pid, `${startedAt}: taken over`);
      await lock.release();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('processes-10: the day\'s limit is not applied to a lock written on this computer, whose process decides', async () => {
  const dir = await folder('here');
  const file = join(dir, RUN_LOCK_FILENAME);
  const short = hostname().split('.')[0];
  try {
    // This process, alive, started two days ago (as far as the lock says) and refreshed now:
    // under this computer's name, and under the name a Mac takes from another network.
    for (const host of [hostname(), `${short}.another-network.example`]) {
      await writeFile(file, JSON.stringify({ pid: process.pid, host, startedAt: hoursAgo(48).toISOString() }));
      await assert.rejects(takeRunLock(dir), { name: 'RunInProgressError' }, host);
    }
    // The same name with a process that is not here is another computer's, and the limit holds.
    await writeFile(file, JSON.stringify({ pid: deadPid(), host: `${short}.another-network.example`, startedAt: hoursAgo(48).toISOString() }));
    const lock = await takeRunLock(dir);
    await lock.release();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- processes-6: the Photos step's lock

async function photosArchive() {
  process.env.CARE_ALBUM_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'cas-notes-photos-'));
  delete process.env.CARE_ALBUM_SESSION;
  const configDir = assertIsolatedConfigDir();
  const dir = join(REPO_ROOT, 'node_modules', '.cache', `cas-notes-photos-${Math.random().toString(16).slice(2, 10)}`);
  await mkdir(dir, { recursive: true });
  const client = new BrightwheelClient({ session: new Secret(SESSION), baseUrl: `${mock.url}/api/v1`, delayMs: 0 });
  const config = { ...DEFAULT_CONFIG, archiveDir: dir, incremental: false, delayMs: 0, includeStudents: ['stu-aaa-111'] };
  await sync(client, config, () => {}, { allowTemporaryDir: true });
  return { dir, configDir, config: { ...config, addToPhotos: true, addToPhotosFrom: null } };
}

function recorder(during = async () => {}) {
  const calls = [];
  const spawn = async (file, args) => {
    calls.push(args);
    await during();
    return { code: 0, stdout: `${args.length}\n`, stderr: '' };
  };
  return { calls, spawn };
}

test('processes-6: the Photos lock is released only while it is still this run\'s', async () => {
  const { dir, configDir, config } = await photosArchive();
  const lock = join(configDir, 'photos.lock');
  try {
    // While Photos is working, the lock is taken from this run — as another run would, had it
    // found it stale — and replaced with that run's own.
    const theirs = '4242 2026-09-24T00:00:00.000Z someone-else\n';
    const photos = recorder(async () => {
      if ((await readFile(lock, 'utf8')) !== theirs) await writeFile(lock, theirs);
    });
    const result = await addToPhotos(config, { platform: 'darwin', spawn: photos.spawn });
    assert.equal(result.ok, true);
    assert.ok(photos.calls.length > 0);
    assert.equal(await readFile(lock, 'utf8'), theirs, 'the other run\'s lock is not removed by this one\'s release');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('processes-6: a stale Photos lock is set aside, not deleted by name, and leaves nothing behind', async () => {
  const { dir, configDir, config } = await photosArchive();
  const lock = join(configDir, 'photos.lock');
  try {
    await writeFile(lock, '99999 2026-09-24T00:00:00.000Z dead\n');
    await utimes(lock, hoursAgo(1), hoursAgo(1));
    const photos = recorder(async () => {
      // Held by this run while Photos works: its own text, not the dead run's.
      assert.match(await readFile(lock, 'utf8'), new RegExp(`^${process.pid} `));
    });
    const result = await addToPhotos(config, { platform: 'darwin', spawn: photos.spawn });
    assert.equal(result.ok, true);
    assert.ok(result.added > 0);
    assert.equal(await exists(lock), false, 'released');
    assert.deepEqual((await readdir(configDir)).filter((n) => n.includes('.stale-') || n.startsWith('photos-handover-')), []);

    // A fresh one is another run's: this one stops, and leaves it be.
    await writeFile(lock, '4242 now other\n');
    const busy = await addToPhotos({ ...config, addToPhotosFrom: null }, { platform: 'darwin', spawn: recorder().spawn });
    assert.equal(busy.reason, 'busy');
    assert.equal(await readFile(lock, 'utf8'), '4242 now other\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('§4.6 F2: a Photos lock dated 2100 is set aside, not honoured for ever', async () => {
  const { dir, configDir, config } = await photosArchive();
  const lock = join(configDir, 'photos.lock');
  try {
    await writeFile(lock, '99999 2100-01-01T00:00:00.000Z planted\n');
    const future = new Date('2100-01-01T00:00:00Z');
    await utimes(lock, future, future);
    const result = await addToPhotos(config, { platform: 'darwin', spawn: recorder().spawn });
    assert.equal(result.ok, true, `not refused as busy: ${JSON.stringify(result)}`);
    assert.ok(result.added > 0);
    assert.equal(await exists(lock), false, 'released');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('processes-6: something at the Photos lock\'s name that is not a file is said, not taken for a busy run', async () => {
  const { dir, configDir, config } = await photosArchive();
  const lock = join(configDir, 'photos.lock');
  try {
    await mkdir(lock);
    await utimes(lock, hoursAgo(2), hoursAgo(2)).catch(() => {});
    const photos = recorder();
    await assert.rejects(addToPhotos(config, { platform: 'darwin', spawn: photos.spawn }), /not the lock file this tool makes/);
    assert.equal(photos.calls.length, 0, 'Photos was not asked');
    assert.ok((await stat(lock)).isDirectory(), 'and it was left where it was');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
