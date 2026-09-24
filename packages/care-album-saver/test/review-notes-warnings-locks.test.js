// First, before anything that can read the config directory.
import { assertIsolatedConfigDir } from '../../../scripts/test-env.js';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { RUN_LOCK_FILENAME, runLockRefusal, takeRunLock, touchedWithin } from '../dist/run-lock.js';

/**
 * The archive review's F2 (WARNING, docs/SECURITY-REVIEW-2026-09-23.md §4.6): a lock whose time
 * is set once to the far future counted as freshly refreshed for ever, so anything that could
 * write the archive folder could stop every daily run, silently, with one `touch -t`. Also the
 * takeover guard beside it, and Photos' lock (in notes-archive-data-locks.test.js).
 */

before(assertIsolatedConfigDir);

const FUTURE = new Date('2100-01-01T00:00:00Z');
const exists = (p) => stat(p).then(() => true, () => false);
const shortName = hostname().split('.')[0];

async function folderWithLock(text, when = FUTURE) {
  const root = await mkdtemp(join(tmpdir(), 'cas-notes-warnings-locks-'));
  const file = join(root, RUN_LOCK_FILENAME);
  await writeFile(file, text);
  await utimes(file, when, when);
  return { root, file };
}

/** Take the lock with a short refresh interval, so the wait for an unsure lock is short. */
async function take(root, extra = {}) {
  const waits = [];
  const lock = await takeRunLock(root, { touchEveryMs: 40, onWait: (m) => waits.push(m), ...extra });
  return { lock, waits };
}

const PLANTED = [
  ['text that is not a lock', 'garbage'],
  ['an empty file', ''],
  ['this computer, a process that is alive', JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString() })],
  ['a name that may be this computer, a process that is alive', JSON.stringify({ pid: process.pid, host: `${shortName}.elsewhere.example`, startedAt: new Date().toISOString() })],
  ['another computer, taken just now', JSON.stringify({ pid: 4242, host: 'another-computer.example', startedAt: new Date().toISOString() })],
];

for (const [what, text] of PLANTED) {
  test(`F2: a lock dated 2100 (${what}) does not stop runs for ever`, { timeout: 20_000 }, async () => {
    const { root, file } = await folderWithLock(text);
    try {
      // Not a run in progress to a look that changes nothing.
      assert.equal(await runLockRefusal(root, 'check'), null);
      const { lock } = await take(root);
      const mine = JSON.parse(await readFile(file, 'utf8'));
      assert.equal(mine.pid, process.pid);
      assert.equal(mine.host, hostname());
      await lock.release();
      assert.equal(await exists(file), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('F2: a future-dated lock whose holder keeps refreshing it is still honoured (a clock that runs fast)', { timeout: 20_000 }, async () => {
  const { root, file } = await folderWithLock(JSON.stringify({ pid: 4242, host: 'fast-clock.example', startedAt: new Date().toISOString() }));
  try {
    // The other computer, ten minutes ahead, refreshes during the wait.
    const ahead = new Date(Date.now() + 10 * 60 * 1000);
    const refresh = setTimeout(() => void utimes(file, ahead, ahead), 20);
    await assert.rejects(take(root), { name: 'RunInProgressError' });
    clearTimeout(refresh);
    assert.match(await readFile(file, 'utf8'), /fast-clock\.example/, 'left alone');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('F2: an unreadable lock is honoured only while it could still be being written', { timeout: 20_000 }, async () => {
  const fresh = await folderWithLock('', new Date());
  const old = await folderWithLock('', new Date(Date.now() - 2 * 60 * 1000));
  try {
    await assert.rejects(take(fresh.root), { name: 'RunInProgressError' });
    const { lock } = await take(old.root);
    await lock.release();
  } finally {
    await rm(fresh.root, { recursive: true, force: true });
    await rm(old.root, { recursive: true, force: true });
  }
});

test('F2: a takeover guard dated 2100 does not block taking over an abandoned lock', { timeout: 20_000 }, async () => {
  const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
  const { root, file } = await folderWithLock(
    JSON.stringify({ pid: 4242, host: 'another-computer.example', startedAt: twoDaysAgo.toISOString() }),
    twoDaysAgo,
  );
  try {
    const guard = `${file}.takeover`;
    await writeFile(guard, '4242 planted\n');
    await utimes(guard, FUTURE, FUTURE);
    const { lock } = await take(root);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).pid, process.pid);
    await lock.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('F2: touchedWithin allows a little clock skew and nothing more', () => {
  const now = Date.now();
  assert.equal(touchedWithin(now, 1000), true);
  assert.equal(touchedWithin(now - 500, 1000), true);
  assert.equal(touchedWithin(now - 5000, 1000), false);
  assert.equal(touchedWithin(now + 60 * 1000, 1000), true, 'a minute ahead: clocks disagree');
  assert.equal(touchedWithin(now + 6 * 60 * 1000, 1000), false, 'six minutes ahead: not a refresh');
  assert.equal(touchedWithin(FUTURE.getTime(), 1000), false);
});
