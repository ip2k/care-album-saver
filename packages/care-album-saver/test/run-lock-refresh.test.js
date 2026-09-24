// First, like every test file: nothing here reads the config directory, but the rule is kept.
import { assertIsolatedConfigDir } from '../../../scripts/test-env.js';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrightwheelClient, DEFAULT_CONFIG, RUN_LOCK_FILENAME, Secret, startMockBrightwheel, sync, takeRunLock } from '../dist/index.js';

/**
 * A held lock stays held for as long as its holder is working, however quiet the work is.
 *
 * Security review 2026-09-23, fs-6: the lock was refreshed only when a run reported progress,
 * so a single slow download or a Retry-After wait let the daily run read it as abandoned after
 * thirty minutes and save into the folder beside it — and age alone overrode a process that
 * was provably still alive on this computer, such as a run the computer's sleep had suspended.
 */

before(assertIsolatedConfigDir);

const exists = (p) => stat(p).then(() => true, () => false);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hourAgo = () => new Date(Date.now() - 60 * 60 * 1000);

test('a held lock is refreshed on a timer, however long nothing is reported, and not after release', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cas-lock2-timer-'));
  const file = join(dir, RUN_LOCK_FILENAME);
  try {
    const lock = await takeRunLock(dir, { touchEveryMs: 40 });
    assert.equal(JSON.parse(await readFile(file, 'utf8')).purpose, 'run');
    // As if the last refresh were an hour ago: the long download that reports nothing.
    await utimes(file, hourAgo(), hourAgo());
    await sleep(250);
    assert.ok(Date.now() - (await stat(file)).mtimeMs < 5_000, 'the timer brought it back up to date');
    // So a daily run arriving now finds it held, not abandoned.
    await assert.rejects(takeRunLock(dir), { name: 'RunInProgressError', message: /Another run is already saving photos/ });

    await lock.release();
    assert.equal(await exists(file), false);
    // After release the timer is gone: a lock someone else takes is never refreshed by it.
    await writeFile(file, JSON.stringify({ pid: 1, host: 'another-mac', startedAt: new Date().toISOString() }));
    await utimes(file, hourAgo(), hourAgo());
    await sleep(200);
    assert.ok(Date.now() - (await stat(file)).mtimeMs > 30 * 60 * 1000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an old lock whose process is alive here is given time to show it is still working, and kept when it does', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cas-lock2-asleep-'));
  const file = join(dir, RUN_LOCK_FILENAME);
  try {
    // A run the computer's sleep suspended hours ago: its process exists (this one), and
    // nothing has refreshed its lock since.
    const holder = { pid: process.pid, host: hostname(), startedAt: hourAgo().toISOString(), purpose: 'run' };
    await writeFile(file, JSON.stringify(holder));
    await utimes(file, hourAgo(), hourAgo());
    const said = [];
    await assert.rejects(
      takeRunLock(dir, {
        touchEveryMs: 100,
        onWait: (message) => {
          said.push(message);
          // The computer wakes, and the suspended run's timer refreshes its lock.
          setTimeout(() => { const now = new Date(); utimes(file, now, now).catch(() => {}); }, 30);
        },
      }),
      { name: 'RunInProgressError' },
    );
    assert.equal(said.length, 1);
    assert.match(said[0], /Checking whether it is still going/);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), holder, 'the sleeping run keeps its lock');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an old lock whose process number is alive but which nobody refreshes is taken over after that wait', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cas-lock2-reused-'));
  const file = join(dir, RUN_LOCK_FILENAME);
  try {
    // A run that died, and whose number the system has since given to another program.
    await writeFile(file, JSON.stringify({ pid: process.pid, host: hostname(), startedAt: hourAgo().toISOString() }));
    await utimes(file, hourAgo(), hourAgo());
    const said = [];
    const lock = await takeRunLock(dir, { touchEveryMs: 30, onWait: (m) => said.push(m) });
    assert.equal(said.length, 1, 'it waited once, and said so');
    const now = JSON.parse(await readFile(file, 'utf8'));
    assert.ok(Date.parse(now.startedAt) > Date.now() - 60_000, 'the lock is the new holder\'s');
    await lock.release();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a live holder under this Mac\'s name on another network is given the wait too, never taken at once', async () => {
  // macOS takes its host name from the network when none is set: a Mac that slept mid-run
  // on one network wakes on another as `name.lan`, holding a lock it wrote as `name.localdomain`.
  const dir = await mkdtemp(join(tmpdir(), 'cas-lock2-renamed-'));
  const file = join(dir, RUN_LOCK_FILENAME);
  const short = hostname().split('.')[0];
  try {
    for (const [host, waits] of [[`${short}.some-other-network`, true], ['a-different-computer.lan', false]]) {
      await writeFile(file, JSON.stringify({ pid: process.pid, host, startedAt: hourAgo().toISOString() }));
      await utimes(file, hourAgo(), hourAgo());
      const said = [];
      const lock = await takeRunLock(dir, { touchEveryMs: 30, onWait: (m) => said.push(m) });
      assert.equal(said.length, waits ? 1 : 0, host);
      await lock.release();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Stop during that wait ends it at once, and the earlier holder\'s lock is left where it was', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cas-lock2-stop-'));
  const file = join(dir, RUN_LOCK_FILENAME);
  try {
    const before = JSON.stringify({ pid: process.pid, host: hostname(), startedAt: hourAgo().toISOString() });
    await writeFile(file, before);
    await utimes(file, hourAgo(), hourAgo());
    const stop = new AbortController();
    const started = Date.now();
    await assert.rejects(
      () => takeRunLock(dir, { touchEveryMs: 5000, signal: stop.signal, onWait: () => setTimeout(() => stop.abort(), 20) }),
      { name: 'LockWaitStoppedError' },
    );
    assert.ok(Date.now() - started < 2000, 'not the full ten seconds');
    assert.equal(await readFile(file, 'utf8'), before, 'the other holder\'s lock is untouched');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a run stopped during that wait ends as stopped, having asked Brightwheel nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cas-lock2-stoprun-'));
  const mock = await startMockBrightwheel({ validSession: 'test-session-value', activitiesPerStudent: 1 });
  try {
    await writeFile(join(dir, RUN_LOCK_FILENAME), JSON.stringify({ pid: process.pid, host: hostname(), startedAt: hourAgo().toISOString() }));
    await utimes(join(dir, RUN_LOCK_FILENAME), hourAgo(), hourAgo());
    const client = new BrightwheelClient({ session: new Secret('test-session-value'), baseUrl: `${mock.url}/api/v1`, delayMs: 0 });
    const stop = new AbortController();
    const phases = [];
    const result = await sync(
      client,
      { ...DEFAULT_CONFIG, archiveDir: dir, delayMs: 0 },
      (p) => {
        phases.push(p.phase);
        if (/Checking whether it is still going/.test(p.message)) stop.abort();
      },
      { allowTemporaryDir: true, signal: stop.signal },
    );
    assert.equal(result.stopped, true);
    assert.equal(phases.at(-1), 'stopped');
    assert.deepEqual(mock.requests, [], 'not even the session was checked');
  } finally {
    await mock.close();
    await rm(dir, { recursive: true, force: true });
  }
});
