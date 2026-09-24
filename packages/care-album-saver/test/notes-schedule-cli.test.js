// First, before anything that can read the config directory or the log folder: install(),
// remove() and the notices record write there (see scripts/test-env.js).
import { assertIsolatedConfigDir } from '../../../scripts/test-env.js';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../dist/config.js';
import { configPath } from '../dist/paths.js';
import * as schedule from '../dist/schedule.js';

/**
 * The security review's NOTE-level findings on src/schedule.ts (§4.3 processes-3 and
 * processes-9, the missed log-folder mode, and the scheduler-change note). Every scheduler is
 * a stand-in: no test here installs anything for real.
 */

before(assertIsolatedConfigDir);

const posixOnly = process.platform === 'win32' ? 'file modes are POSIX' : false;

async function freshConfigDir() {
  process.env.CARE_ALBUM_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'cas-notes-sched-config-'));
  return assertIsolatedConfigDir();
}

/** A log folder of the test's own, which may not exist yet. */
async function freshLogDir(exists = true) {
  const parent = await mkdtemp(join(tmpdir(), 'cas-notes-sched-logs-'));
  process.env.CARE_ALBUM_LOG_DIR = exists ? parent : join(parent, 'not-yet');
  return process.env.CARE_ALBUM_LOG_DIR;
}

const freshHome = () => mkdtemp(join(tmpdir(), 'cas-notes-sched-home-'));
const mode = async (path) => (await stat(path)).mode & 0o777;

/** A stand-in operating system: `answer` decides each call's result, and every call is kept. */
function recorder(answer = () => ({})) {
  const calls = [];
  const run = async (file, args, input) => {
    calls.push({ file, args, input });
    return { code: 0, stdout: '', stderr: '', ...(answer({ file, args, input }) || {}) };
  };
  return { run, calls };
}

/** Linux with or without systemd, and a crontab kept between calls. */
function linux({ systemd }) {
  const state = { crontab: null, systemd, refuseCrontab: false };
  const os = recorder(({ file, args, input }) => {
    if (file === 'systemctl') return state.systemd ? {} : { code: 127 };
    if (file === 'crontab' && args[0] === '-l') {
      return state.crontab === null ? { code: 1, stderr: 'no crontab for alex' } : { stdout: state.crontab };
    }
    if (file === 'crontab' && args[0] === '-') {
      if (state.refuseCrontab) return { code: 1, stderr: 'crontab: permission denied' };
      state.crontab = input;
    }
    return {};
  });
  return { ...os, state };
}

const linuxEnv = (home, run) => ({ platform: 'linux', home, run, nodePath: '/usr/bin/node', cliPath: '/opt/cas/dist/cli.js', uid: 1000 });

// ---------------------------------------------------------------- processes-3

const MARKER = '# care-album-saver: the daily run. Delete this block to stop it.';
const END = '# care-album-saver: end of the daily run.';

test('processes-3: a block whose end marker was deleted by hand loses both of its lines, and only those', async () => {
  await freshConfigDir();
  await freshLogDir();
  const home = await freshHome();
  const os = linux({ systemd: false });
  const env = linuxEnv(home, os.run);

  await schedule.install('19:00', env);
  const [daily, reboot] = os.state.crontab.split('\n').filter((l) => /run --scheduled/.test(l));
  // The person deletes the end marker, and has their own lines on both sides of the block.
  os.state.crontab = ['# mine', '0 6 * * * /usr/local/bin/backup', MARKER, daily, reboot, '30 7 * * * /usr/local/bin/tidy', ''].join('\n');

  await schedule.install('20:00', env);
  const after = os.state.crontab.split('\n');
  assert.equal(after.filter((l) => l.startsWith('@reboot')).length, 1, 'one catch-up line, not the old one left beside the new');
  assert.equal(after.filter((l) => /run --scheduled/.test(l)).length, 2, 'the new block only');
  assert.ok(after.some((l) => l.startsWith('0 20 * * * ')), 'at the new time');
  assert.ok(!after.some((l) => l.startsWith('0 19 * * * ')), 'and not the old');
  for (const theirs of ['# mine', '0 6 * * * /usr/local/bin/backup', '30 7 * * * /usr/local/bin/tidy']) {
    assert.ok(after.includes(theirs), `their own line survives: ${theirs}`);
  }

  // The same with the end marker gone again, then turned off: nothing of ours is left.
  os.state.crontab = os.state.crontab.split('\n').filter((l) => l !== END).join('\n');
  await schedule.remove(env);
  assert.doesNotMatch(os.state.crontab, /run --scheduled|care-album-saver/);
  assert.match(os.state.crontab, /\/usr\/local\/bin\/tidy/, 'their line straight after ours is kept');
});

test('processes-3: the lines an older version wrote, in double quotes, are recognised as ours too', async () => {
  await freshConfigDir();
  await freshLogDir();
  const home = await freshHome();
  const os = linux({ systemd: false });
  const old = '"/usr/bin/node" "/opt/cas/dist/cli.js" run --scheduled >> "/home/alex/.local/state/care-album-saver/daily.log" 2>&1';
  os.state.crontab = [MARKER, `0 19 * * * ${old}`, `@reboot ${old}`, '15 3 * * * echo "run --scheduled" is only words here', ''].join('\n');
  await schedule.remove(linuxEnv(home, os.run));
  assert.equal(os.state.crontab, '15 3 * * * echo "run --scheduled" is only words here\n', 'only a line of the shape we write goes');
});

// ---------------------------------------------------------------- processes-9: readLog

test('processes-9: the log is read from its end, and a line cut by where reading starts is left out', async () => {
  const dir = await freshLogDir();
  const lines = Array.from({ length: 20000 }, (_, i) => `2026-09-24T19:00:00+00:00  line ${i}`);
  await writeFile(join(dir, 'daily.log'), `${lines.join('\n')}\n`);
  assert.ok((await stat(join(dir, 'daily.log'))).size > 256 * 1024, 'longer than what is read');
  const { text } = await schedule.readLog(5);
  assert.deepEqual(text.split('\n'), lines.slice(-5));

  // One line longer than the whole window: its tail is not passed off as a line.
  await writeFile(join(dir, 'daily.log'), `${'x'.repeat(300 * 1024)}\nthe last line\n`);
  assert.equal((await schedule.readLog(200)).text, 'the last line');
});

test('processes-9: a log far larger than memory is still read, because only its end is', { skip: posixOnly }, async () => {
  const dir = await freshLogDir();
  // Sparse, so it takes no disk: 3 GiB of nothing, then one line. Reading the whole file, as
  // before, fails outright past 2 GiB, and the page showed an empty log.
  const handle = await open(join(dir, 'daily.log'), 'w');
  try {
    await handle.truncate(3 * 1024 ** 3);
    await handle.write('\n2026-09-24T19:00:00+00:00  OK  3 saved\n', 3 * 1024 ** 3);
    await handle.close();
    assert.equal((await schedule.readLog(200)).text, '2026-09-24T19:00:00+00:00  OK  3 saved');
  } finally {
    await handle.close().catch(() => {});
    await rm(join(dir, 'daily.log'), { force: true });
  }
});

// ---------------------------------------------------------------- processes-9: notices

test('processes-9: a notice is chosen by kind, its AppleScript is made from its own words, and nothing else is shown', async () => {
  const home = await freshHome();
  const mac = recorder();
  const penguin = recorder();
  assert.equal(await schedule.notify('failed', { platform: 'darwin', home, run: mac.run }), true);
  assert.equal(await schedule.notify('photos', { platform: 'darwin', home, run: mac.run }), true);
  assert.equal(await schedule.notify('photos', { platform: 'linux', home, run: penguin.run }), true);
  for (const kind of ['toString', '__proto__', 'constructor', 'The daily photo run did not work. Open the setup assistant to see why.', undefined]) {
    assert.equal(await schedule.notify(kind, { platform: 'darwin', home, run: mac.run }), false, String(kind));
  }
  assert.equal(mac.calls.length, 2, 'only the two known kinds reached osascript');
  assert.match(mac.calls[0].args[1], /^display notification "The daily photo run did not work\. [^"]+" with title "Care Album Saver"$/);
  assert.match(mac.calls[1].args[1], /could not be added to Photos/);
  // The same words on every desktop: the Mac's are made from them, not kept beside them.
  const [title, text] = penguin.calls[0].args;
  assert.equal(title, 'Care Album Saver');
  assert.ok(mac.calls[1].args[1].includes(`"${text}"`));
  assert.equal(await schedule.notify('failed', { platform: 'win32', home, run: mac.run }), false, 'Windows has no notifier here');
});

test('§4.4 Photos notice: said once for each problem, and again once the problem is over', async () => {
  await freshConfigDir();
  const home = await freshHome();
  const os = recorder();
  const env = { platform: 'darwin', home, run: os.run };
  const damaged = 'The record of what has already been added to Photos cannot be read: it is not JSON.';

  assert.equal(await schedule.announceOnce('photos', damaged, env), true);
  assert.equal(await schedule.announceOnce('photos', damaged, env), false, 'the next evening: already said');
  assert.equal(await schedule.announceOnce('photos', damaged, env), false);
  assert.equal(os.calls.length, 1);

  await schedule.announceOnce('photos', 'The record cannot be read: permission denied.', env);
  assert.equal(os.calls.length, 2, 'a different problem is said');

  await schedule.forgetNotice('photos');
  await schedule.announceOnce('photos', damaged, env);
  assert.equal(os.calls.length, 3, 'the same problem again, after it was over, is said again');

  // A damaged memory of what was said only means saying it again.
  await writeFile(join(process.env.CARE_ALBUM_CONFIG_DIR, 'notices.json'), '{ not json');
  await schedule.announceOnce('photos', damaged, env);
  assert.equal(os.calls.length, 4);
  assert.equal(JSON.parse(await readFile(join(process.env.CARE_ALBUM_CONFIG_DIR, 'notices.json'), 'utf8')).photos, damaged);
});

// ---------------------------------------------------------------- processes-9: the copy's root

test('processes-9: a copy\'s folder is found from its package.json, so production is still production with cli.js one folder deeper', async () => {
  await freshConfigDir();
  await freshLogDir();
  const home = await freshHome();
  const run = async () => ({ code: 0, stdout: '', stderr: '' });
  const env = (cliPath) => ({ platform: 'darwin', home, run, cliPath, nodePath: '/usr/bin/node', uid: 501 });

  const copy = async (name, { production = false, deeper = false } = {}) => {
    const root = await mkdtemp(join(tmpdir(), `cas-notes-root-${name}-`));
    const pkg = join(root, 'packages', 'care-album-saver');
    const dist = deeper ? join(pkg, 'dist', 'bin') : join(pkg, 'dist');
    await mkdir(dist, { recursive: true });
    await writeFile(join(dist, 'cli.js'), '');
    await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: 'care-album-saver' }));
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'care-album-saver', private: true }));
    if (production) await writeFile(join(root, '.care-album-saver-production'), `${root}\nproduction\n`);
    return join(dist, 'cli.js');
  };

  const production = await copy('production', { production: true, deeper: true });
  await schedule.install('17:00', env(production));
  const stray = await copy('stray');
  // Counted three folders up, this production copy's root was packages/, which holds no
  // marker: it passed for a stray copy, and --replace from the page took its daily run.
  await assert.rejects(schedule.install('19:00', env(stray), { replace: true }), (error) => {
    assert.ok(error instanceof schedule.ScheduleOwnedElsewhereError);
    assert.equal(error.production, true);
    return true;
  });

  // An npm install: the package is the copy, and a project around it that is not ours is not.
  const project = await mkdtemp(join(tmpdir(), 'cas-notes-npm-'));
  await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'someone-elses-project' }));
  const installed = join(project, 'node_modules', 'care-album-saver');
  await mkdir(join(installed, 'dist'), { recursive: true });
  await writeFile(join(installed, 'package.json'), JSON.stringify({ name: 'care-album-saver' }));
  await writeFile(join(installed, 'dist', 'cli.js'), '');
  await writeFile(join(installed, '.care-album-saver-production'), `${installed}\nproduction\n`);
  await schedule.install('18:00', env(join(installed, 'dist', 'cli.js')), { replace: true, replaceProduction: true });
  await assert.rejects(schedule.install('19:00', env(stray), { replace: true }), (error) => error.production === true);
});

// ---------------------------------------------------------------- the log folder's mode

test('log-dir mode: setting up the daily run makes its log folder, and a log already there, owner-only', { skip: posixOnly }, async () => {
  await freshConfigDir();
  const home = await freshHome();
  const run = async () => ({ code: 0, stdout: '', stderr: '' });
  const env = { platform: 'darwin', home, run, nodePath: '/usr/bin/node', cliPath: '/opt/cas/dist/cli.js', uid: 501 };

  // A folder that does not exist yet is created owner-only, whatever the umask.
  const fresh = await freshLogDir(false);
  const umask = process.umask(0o022);
  try {
    await schedule.install('19:00', env);
  } finally {
    process.umask(umask);
  }
  assert.equal(await mode(fresh), 0o700);

  // One made earlier at the default, with a log a scheduler opened world-readable.
  const earlier = await freshLogDir();
  await chmod(earlier, 0o755);
  await writeFile(join(earlier, 'daily.log'), 'launchd wrote this\n', { mode: 0o644 });
  await chmod(join(earlier, 'daily.log'), 0o644);
  await schedule.install('19:30', env);
  assert.equal(await mode(earlier), 0o700);
  assert.equal(await mode(join(earlier, 'daily.log')), 0o600);
  assert.equal(await readFile(join(earlier, 'daily.log'), 'utf8'), 'launchd wrote this\n', 'and nothing else about it changed');
});

// ---------------------------------------------------------------- the scheduler changed

test('scheduler changed: a machine that gained systemd has its crontab block taken away before the timer is set up', async () => {
  await freshConfigDir();
  await freshLogDir();
  const home = await freshHome();
  const os = linux({ systemd: false });
  const env = linuxEnv(home, os.run);
  os.state.crontab = '0 6 * * * /usr/local/bin/backup\n';

  await schedule.install('19:00', env);
  assert.equal((await loadConfig()).schedule.mechanism, 'cron');
  assert.match(os.state.crontab, /run --scheduled/);

  os.state.systemd = true;
  await schedule.install('19:00', env);
  assert.equal((await loadConfig()).schedule.mechanism, 'systemd');
  assert.doesNotMatch(os.state.crontab, /run --scheduled|care-album-saver/, 'the old job is gone, so it does not run beside the timer');
  assert.match(os.state.crontab, /\/usr\/local\/bin\/backup/, 'their own line is kept');
  assert.ok(existsSync(join(home, '.config', 'systemd', 'user', 'care-album-saver.timer')));
});

test('scheduler changed: when the old job will not go, nothing is changed and the settings still name it', async () => {
  await freshConfigDir();
  await freshLogDir();
  const home = await freshHome();
  const os = linux({ systemd: false });
  const env = linuxEnv(home, os.run);
  await schedule.install('19:00', env);
  const before = os.state.crontab;

  os.state.systemd = true;
  os.state.refuseCrontab = true;
  await assert.rejects(schedule.install('20:00', env), /set up with cron, and this computer now uses systemd.*permission denied/s);
  assert.equal(os.state.crontab, before, 'the crontab block is still there');
  assert.equal((await loadConfig()).schedule.mechanism, 'cron', 'and the settings say so');
  assert.equal((await loadConfig()).schedule.time, '19:00');
  assert.equal(existsSync(join(home, '.config', 'systemd', 'user', 'care-album-saver.timer')), false, 'no timer was set up beside it');
  assert.equal(os.calls.some((c) => c.file === 'systemctl' && c.args.includes('enable')), false);
});

test('scheduler changed: the old job gone and the new one refused leaves no daily run, and the settings say none', async () => {
  await freshConfigDir();
  await freshLogDir();
  const home = await freshHome();
  const os = linux({ systemd: false });
  const env = linuxEnv(home, os.run);
  await schedule.install('19:00', env);

  os.state.systemd = true;
  const refusing = async (file, args, input) =>
    file === 'systemctl' && args.includes('enable') ? { code: 1, stdout: '', stderr: 'Failed to connect to bus' } : os.run(file, args, input);
  await assert.rejects(schedule.install('20:00', { ...env, run: refusing }), /systemd would not start the daily run/);
  assert.doesNotMatch(os.state.crontab, /run --scheduled/);
  assert.equal((await loadConfig()).schedule, null, 'not a record of a crontab line that is no longer there');
  // The record stays readable for status(): nothing is claimed that is not there.
  assert.equal(JSON.parse(await readFile(configPath(), 'utf8')).schedule, null);
});
