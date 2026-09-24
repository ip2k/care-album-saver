// First, before anything that can read the config directory.
import { assertIsolatedConfigDir } from '../../../scripts/test-env.js';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as schedule from '../dist/schedule.js';
import { loadConfig } from '../dist/config.js';

/**
 * The schedule review's F1 (WARNING, docs/SECURITY-REVIEW-2026-09-23.md §4.6). The "scheduler
 * changed" fix read every remover's answer, which was right, but read 127 — the scheduler's
 * program is not installed — as a refusal. On a Linux machine whose systemctl, or crontab,
 * has gone, the daily run could then be neither turned on nor off. Stand-in runners only;
 * nothing real is installed.
 */

before(assertIsolatedConfigDir);

async function fresh() {
  process.env.CARE_ALBUM_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'cas-notes-warnings-sched-config-'));
  process.env.CARE_ALBUM_LOG_DIR = await mkdtemp(join(tmpdir(), 'cas-notes-warnings-sched-logs-'));
  assertIsolatedConfigDir();
  return mkdtemp(join(tmpdir(), 'cas-notes-warnings-sched-home-'));
}

/** A Linux machine whose systemd and cron can each be there or not (127, not installed). */
function linux(state) {
  const run = async (file, args, input) => {
    if (file === 'systemctl') {
      if (!state.systemd) return { code: 127, stdout: '', stderr: '' };
      return state.systemctlFails ? { code: 1, stdout: '', stderr: 'Failed to connect to bus: No medium found' } : { code: 0, stdout: '', stderr: '' };
    }
    if (file === 'crontab') {
      if (!state.cron) return { code: 127, stdout: '', stderr: '' };
      if (args[0] === '-l') {
        return state.crontab === null ? { code: 1, stdout: '', stderr: 'no crontab for alex' } : { code: 0, stdout: state.crontab, stderr: '' };
      }
      if (args[0] === '-') state.crontab = input;
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  return run;
}

const env = (home, run) => ({ platform: 'linux', home, run, nodePath: '/usr/bin/node', cliPath: '/opt/cas/dist/cli.js', uid: 1000 });
const unitDir = (home) => join(home, '.config', 'systemd', 'user');
const unitFiles = (home) => [
  join(unitDir(home), 'care-album-saver.timer'),
  join(unitDir(home), 'care-album-saver.service'),
  join(unitDir(home), 'timers.target.wants', 'care-album-saver.timer'),
];

/** Installed with systemd, with the link `systemctl enable` would have made. */
async function installedWithSystemd(home, state, run) {
  const s = await schedule.install('19:00', env(home, run));
  assert.equal(s.mechanism, 'systemd');
  await mkdir(join(unitDir(home), 'timers.target.wants'), { recursive: true });
  await symlink('../care-album-saver.timer', unitFiles(home)[2]);
  assert.ok(unitFiles(home).every((f) => existsSync(f)));
}

test('F1: set up with systemd, and systemctl is gone: `schedule on` moves the run to cron', async () => {
  const home = await fresh();
  const state = { systemd: true, cron: true, crontab: null };
  const run = linux(state);
  await installedWithSystemd(home, state, run);
  state.systemd = false;
  const s = await schedule.install('20:00', env(home, run));
  assert.equal(s.mechanism, 'cron');
  assert.match(state.crontab, /run --scheduled/);
  assert.deepEqual(unitFiles(home).filter((f) => existsSync(f)), [], 'the timer, the service and the enable link are gone');
  assert.equal((await loadConfig()).schedule.mechanism, 'cron');
});

test('F1: set up with systemd, and systemctl is gone: `schedule off` turns it off', async () => {
  const home = await fresh();
  const state = { systemd: true, cron: true, crontab: null };
  const run = linux(state);
  await installedWithSystemd(home, state, run);
  state.systemd = false;
  const s = await schedule.remove(env(home, run));
  assert.equal(s.installed, false);
  assert.equal((await loadConfig()).schedule, null);
  assert.deepEqual(unitFiles(home).filter((f) => existsSync(f)), []);
});

test('F1: set up with cron, and crontab is gone: `schedule on` moves the run to systemd, and `schedule off` works', async () => {
  const home = await fresh();
  const state = { systemd: false, cron: true, crontab: null };
  const run = linux(state);
  assert.equal((await schedule.install('19:00', env(home, run))).mechanism, 'cron');
  state.cron = false;
  state.systemd = true;
  assert.equal((await schedule.install('20:00', env(home, run))).mechanism, 'systemd');

  const home2 = await fresh();
  const state2 = { systemd: false, cron: true, crontab: null };
  const run2 = linux(state2);
  await schedule.install('19:00', env(home2, run2));
  state2.cron = false;
  assert.equal((await schedule.remove(env(home2, run2))).installed, false);
});

test('F1: a systemd that is there and refuses is still a refusal, and says which files to delete', async () => {
  const home = await fresh();
  const state = { systemd: true, cron: true, crontab: null };
  const run = linux(state);
  await installedWithSystemd(home, state, run);
  state.systemctlFails = true;
  await assert.rejects(schedule.remove(env(home, run)), (error) => {
    assert.match(error.message, /systemd would not turn the daily run off, so it is still set up and nothing was changed/);
    assert.ok(error.message.includes(unitFiles(home)[0]) && error.message.includes(unitFiles(home)[2]), error.message);
    return true;
  });
  assert.ok(unitFiles(home).every((f) => existsSync(f)), 'nothing was removed');
  assert.equal((await loadConfig()).schedule.mechanism, 'systemd');
});
