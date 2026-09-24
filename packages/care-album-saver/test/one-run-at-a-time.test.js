// First, before anything that can read the config directory or write an archive.
import { assertIsolatedConfigDir } from '../../../scripts/test-env.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  BrightwheelClient,
  DEFAULT_CONFIG,
  RUN_LOCK_FILENAME,
  Secret,
  configPath,
  startMockBrightwheel,
  startWebUi,
  sync,
  takeRunLock,
  writeSecureFile,
} from '../dist/index.js';
import { loadLastRun, recordRun } from '../dist/schedule.js';

/**
 * One run at a time per archive folder, across processes — and a run a person starts counts
 * as the day's run.
 *
 * Found by review on 2026-09-23: turning the daily run on starts one immediately (launchd's
 * RunAtLoad), runs started from the page were never recorded, so that immediate run always
 * did a full sync, and nothing stopped it saving into the archive alongside a run the parent
 * had just started. Two runs then both write archive.json, the later save replaces the
 * earlier one's records, and the next run fetches the unlisted photos again as "-2" copies.
 */

const SESSION = 'test-session-value';
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

let mock;
before(assertIsolatedConfigDir);
before(async () => { mock = await startMockBrightwheel({ validSession: SESSION, activitiesPerStudent: 12 }); });
after(async () => { await mock?.close(); });

const client = () => new BrightwheelClient({ session: new Secret(SESSION), baseUrl: `${mock.url}/api/v1`, delayMs: 0 });
const configFor = (dir, extra = {}) => ({ ...DEFAULT_CONFIG, archiveDir: dir, delayMs: 0, incremental: false, ...extra });

async function freshConfigDir() {
  process.env.CARE_ALBUM_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'cas-lock-config-'));
  delete process.env.CARE_ALBUM_SESSION;
  return assertIsolatedConfigDir();
}

/** An archive the destination rules accept, for the command line and the page (they refuse temp folders). */
async function realishArchive() {
  const dir = join(REPO_ROOT, 'node_modules', '.cache', `cas-lock-${Math.random().toString(16).slice(2, 10)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function filesUnder(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) out.push(join(entry.parentPath ?? entry.path, entry.name));
  }
  return out;
}

const exists = (p) => stat(p).then(() => true, () => false);

/** A pid that certainly belonged to a process and certainly no longer does. */
async function deadPid() {
  const child = spawn(process.execPath, ['-e', '0']);
  const pid = child.pid;
  await new Promise((r) => child.on('exit', r));
  return pid;
}

// ---------------------------------------------------------------- two runs at once

test('two runs started together: one saves, the other refuses, and nothing is saved twice', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cas-lock-archive-'));
  try {
    const config = configFor(dir);
    const outcomes = await Promise.allSettled([
      sync(client(), config, () => {}, { allowTemporaryDir: true }),
      sync(client(), config, () => {}, { allowTemporaryDir: true }),
    ]);
    const saved = outcomes.filter((o) => o.status === 'fulfilled');
    const refused = outcomes.filter((o) => o.status === 'rejected');
    assert.equal(saved.length, 1, 'exactly one run did the work');
    assert.equal(refused.length, 1);
    assert.equal(refused[0].reason.name, 'RunInProgressError');
    assert.match(refused[0].reason.message, /Another run is already saving photos into this folder/);

    const manifest = JSON.parse(await readFile(join(dir, 'archive.json'), 'utf8'));
    const media = (await filesUnder(dir)).filter((f) => /\.(jpe?g|png|mp4|mov)$/i.test(f));
    assert.equal(media.length, manifest.files.length, 'every file on disk is on the list, and no more');
    assert.equal(media.filter((f) => /-\d+\.[a-z0-9]+$/i.test(f)).length, 0, 'no "-2" copies');
    assert.equal(saved[0].value.saved, manifest.files.length);
    assert.equal(await exists(join(dir, RUN_LOCK_FILENAME)), false, 'the lock is gone when the run is');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a lock whose owner is gone is taken over; a live or unreadable one is not', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cas-lock-stale-'));
  const lock = join(dir, RUN_LOCK_FILENAME);
  try {
    // This computer, a process that has exited: taken over.
    await writeFile(lock, JSON.stringify({ pid: await deadPid(), host: hostname(), startedAt: new Date().toISOString() }));
    const a = await takeRunLock(dir);
    await a.release();
    assert.equal(await exists(lock), false);

    // Another computer's, untouched for an hour: taken over by age.
    await writeFile(lock, JSON.stringify({ pid: 1, host: 'another-mac', startedAt: new Date().toISOString() }));
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    await utimes(lock, hourAgo, hourAgo);
    const b = await takeRunLock(dir);
    await b.release();

    // Another computer's, fresh: its process cannot be checked from here, so it stands.
    await writeFile(lock, JSON.stringify({ pid: 1, host: 'another-mac', startedAt: new Date().toISOString() }));
    await assert.rejects(takeRunLock(dir), { name: 'RunInProgressError' });

    // Empty, as it is for the instant between its owner creating it and writing to it.
    await writeFile(lock, '');
    await assert.rejects(takeRunLock(dir), { name: 'RunInProgressError' }, 'unreadable is not abandoned');

    // This computer, this very process: alive, so held.
    await writeFile(lock, JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString() }));
    await assert.rejects(takeRunLock(dir), { name: 'RunInProgressError' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a run releases only its own lock, never one a later run took over', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cas-lock-own-'));
  const lock = join(dir, RUN_LOCK_FILENAME);
  try {
    const mine = await takeRunLock(dir);
    // Presumed dead and taken over by someone else meanwhile.
    await writeFile(lock, JSON.stringify({ pid: 1, host: 'another-mac', startedAt: new Date().toISOString() }));
    await mine.release();
    assert.equal(await exists(lock), true, 'the other run keeps its lock');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- the record of a run

test('a run started by hand counts as the day\'s: the daily run after it has nothing to do', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'cas-lock-cli-'));
  const archive = await realishArchive();
  try {
    await writeSecureFile(join(configDir, 'session.json'), JSON.stringify({ cookie: SESSION, savedAt: new Date().toISOString() }));
    await writeSecureFile(
      join(configDir, 'config.json'),
      JSON.stringify(configFor(archive, {
        schedule: { time: '00:00', mechanism: 'launchd', location: '/nowhere', installedAt: new Date().toISOString() },
      })),
    );
    const env = { ...process.env, CARE_ALBUM_CONFIG_DIR: configDir };
    const cli = (...args) => promisify(execFile)(process.execPath, [CLI, ...args, '--base-url', `${mock.url}/api/v1`], { env });

    const manual = await cli('run');
    assert.match(manual.stdout, /Done\./);
    const record = JSON.parse(await readFile(join(configDir, 'last-run.json'), 'utf8'));
    assert.equal(record.trigger, 'manual');
    assert.equal(record.ok, true);

    // What launchd's RunAtLoad would start the moment the daily run is turned on.
    const scheduled = await cli('run', '--scheduled');
    assert.match(scheduled.stdout, /Already up to date for today; nothing to do\./);
    assert.equal(mock.requests.filter((r) => r.path.endsWith('/users/me')).length > 0, true);
  } finally {
    await rm(archive, { recursive: true, force: true });
  }
});

test('a run limited to some children is not recorded as the day\'s run', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'cas-lock-cli-'));
  const archive = await realishArchive();
  try {
    await writeSecureFile(join(configDir, 'session.json'), JSON.stringify({ cookie: SESSION, savedAt: new Date().toISOString() }));
    await writeSecureFile(join(configDir, 'config.json'), JSON.stringify(configFor(archive)));
    await promisify(execFile)(process.execPath, [CLI, 'run', '--child', 'stu-aaa-111', '--base-url', `${mock.url}/api/v1`], {
      env: { ...process.env, CARE_ALBUM_CONFIG_DIR: configDir },
    });
    assert.equal(await exists(join(configDir, 'last-run.json')), false);
  } finally {
    await rm(archive, { recursive: true, force: true });
  }
});

test('a daily run that finds another run saving leaves quietly: no failure, no record, a line in the log', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'cas-lock-cli-'));
  const logDir = await mkdtemp(join(tmpdir(), 'cas-lock-log-'));
  const archive = await realishArchive();
  try {
    await writeSecureFile(join(configDir, 'session.json'), JSON.stringify({ cookie: SESSION, savedAt: new Date().toISOString() }));
    await writeSecureFile(join(configDir, 'config.json'), JSON.stringify(configFor(archive)));
    // Held by this test's own process, which is certainly alive.
    await writeFile(join(archive, RUN_LOCK_FILENAME), JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString() }));
    const { stdout } = await promisify(execFile)(process.execPath, [CLI, 'run', '--scheduled', '--base-url', `${mock.url}/api/v1`], {
      env: { ...process.env, CARE_ALBUM_CONFIG_DIR: configDir, CARE_ALBUM_LOG_DIR: logDir },
    });
    assert.match(stdout, /Another run is already saving photos into this folder/);
    assert.equal(await exists(join(configDir, 'last-run.json')), false, 'the other run records the outcome');
    assert.match(await readFile(join(logDir, 'daily.log'), 'utf8'), /SKIPPED another run was already saving photos/);
    assert.equal(await exists(join(archive, 'archive.json')), false, 'it read and wrote nothing');
  } finally {
    await rm(archive, { recursive: true, force: true });
  }
});

test('a run from the page is recorded, and one refused by a held lock ends plainly', async () => {
  await freshConfigDir();
  const archive = await realishArchive();
  await writeSecureFile(configPath(), JSON.stringify(configFor(archive)));
  const handle = await startWebUi({ baseUrl: `${mock.url}/api/v1` });
  const call = async (path, body) => {
    const res = await fetch(`http://127.0.0.1:${handle.port}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', 'x-setup-token': handle.token },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return res.json();
  };
  const finish = async () => {
    let s;
    for (let i = 0; i < 200; i += 1) {
      s = await call('/api/state');
      if (!s.running) return s;
      await new Promise((r) => setTimeout(r, 50));
    }
    return s;
  };
  try {
    await call('/api/session', { cookie: SESSION });
    await call('/api/sync', {});
    await finish();
    const record = await loadLastRun();
    assert.equal(record.trigger, 'manual');
    assert.equal(record.ok, true);

    await writeFile(join(archive, RUN_LOCK_FILENAME), JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString() }));
    await call('/api/sync', {});
    const s = await finish();
    assert.equal(s.progress.phase, 'stopped', 'an ending, not an error');
    assert.match(s.progress.message, /Another run is already saving photos into this folder/);
    assert.doesNotMatch(s.progress.message, /Error|at .*\.js/, 'no stack');
  } finally {
    await handle.close();
    await rm(archive, { recursive: true, force: true });
  }
});

test('the scheduler\'s own last run is remembered across runs a person starts', async () => {
  await freshConfigDir();
  await recordRun({ at: '2026-09-20T19:00:00.000Z', ok: true, saved: 3, failed: 0, message: 'x', trigger: 'schedule' });
  await recordRun({ at: '2026-09-23T10:00:00.000Z', ok: true, saved: 0, failed: 0, message: 'y', trigger: 'manual' });
  await recordRun({ at: '2026-09-23T11:00:00.000Z', ok: true, saved: 0, failed: 0, message: 'z', trigger: 'manual' });
  const last = await loadLastRun();
  assert.equal(last.at, '2026-09-23T11:00:00.000Z');
  assert.equal(last.scheduledAt, '2026-09-20T19:00:00.000Z', 'so "the daily run has stopped working" still has its answer');
});
