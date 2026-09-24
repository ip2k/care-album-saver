// First, before anything that can read the config directory: install() and remove() record
// what they did there, and the round trip below writes a log (see scripts/test-env.js).
import { assertIsolatedConfigDir } from '../../../scripts/test-env.js';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { loadConfig } from '../dist/config.js';
import { configPath } from '../dist/paths.js';
import * as schedule from '../dist/schedule.js';

/**
 * The security review's schedule findings (2026-09-23): processes-1, processes-4 and
 * missed-processes.
 *
 * processes-1: the crontab lines and systemd's ExecStart= wrapped each path in double quotes
 * and nothing else, so a folder called `$(…)` ran as a command. The job is text that cron's
 * shell, systemd and Windows' C runtime each read their own way, so these tests read it back
 * the way each of them does — the crontab through real shells, and systemd and Windows
 * through models of their documented rules — and require every path to come back exactly.
 *
 * processes-4: a LaunchAgent launchctl refused was left in place with RunAtLoad, and went live
 * at the next login while the settings recorded no daily run.
 *
 * missed-processes: remove() read only the crontab's answer; a bootout, a disable or a
 * schtasks /Delete that failed was recorded as the daily run being off.
 *
 * No scheduler is touched: every command goes to a stand-in that answers as the real one
 * would, as in schedule.test.js.
 */

before(assertIsolatedConfigDir);

const run = promisify(execFile);

async function freshConfigDir() {
  process.env.CARE_ALBUM_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'cas-sched-warn-config-'));
  return assertIsolatedConfigDir();
}

const freshHome = () => mkdtemp(join(tmpdir(), 'cas-sched-warn-home-'));
const exists = (path) => stat(path).then(() => true, () => false);

/** A stand-in operating system: `answer` decides each call's result, and every call is kept. */
function recorder(answer = () => ({})) {
  const calls = [];
  const runner = async (file, args, input) => {
    calls.push({ file, args, input });
    return { code: 0, stdout: '', stderr: '', ...(answer({ file, args, input }) || {}) };
  };
  return { run: runner, calls, said: () => calls.map((c) => `${c.file} ${c.args.join(' ')}`) };
}

/**
 * Every awkward thing a folder name can hold on a Mac or Linux: a space, a command
 * substitution in both spellings, both quotes, a backslash, a percent sign alone and one
 * right after a backslash, and the shapes cron, systemd and Windows would each expand.
 */
const AWKWARD = 'a b $(echo INJECTED) `echo TICKED` it\'s "q" 100% n\\%d $HOME ${HOME} %h %PATH% $$';

// ---------------------------------------------------------------- processes-1: cron

/**
 * What cronie and Vixie cron hand to the shell, ported from cronie's do_command.c: the
 * command ends at the first `%` not after a backslash, the rest becomes the job's input, and
 * `\%` loses its backslash. Any other backslash is kept.
 */
function cronieReads(command) {
  let out = '';
  let escaped = false;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (escaped) {
      out = ch === '%' ? `${out.slice(0, -1)}%` : out + ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      out += ch;
      continue;
    }
    if (ch === '%') return { command: out, input: command.slice(i + 1) };
    out += ch;
  }
  return { command: out, input: '' };
}

const SHELLS = ['/bin/sh', '/bin/dash', '/bin/bash', '/bin/ksh', '/bin/zsh'].filter((shell) => existsSync(shell));

/** The command part of a crontab line: after `@reboot`, or after the five time fields. */
const commandOf = (line) => line.replace(/^(?:@reboot|\S+ \S+ \S+ \S+ \S+) /, '');

test('a crontab line gives every path back exactly, through a real shell and two kinds of cron', async (t) => {
  if (process.platform === 'win32') return t.skip('cron and /bin/sh are not on Windows');
  const base = await mkdtemp(join(tmpdir(), 'cas-cron-quoting-'));
  const folder = join(base, AWKWARD);
  await mkdir(join(folder, 'logs'), { recursive: true });
  // A stand-in for node that writes down how it was called, one argument a line: the path
  // it was started by, then everything after it.
  const node = join(folder, 'node');
  await writeFile(node, '#!/bin/sh\nprintf \'%s\\n\' "$0" "$@"\n');
  await chmod(node, 0o755);
  const cli = join(folder, 'cli.js');
  const log = join(folder, 'logs', 'daily.log');

  const savedLogDir = process.env.CARE_ALBUM_LOG_DIR;
  process.env.CARE_ALBUM_LOG_DIR = join(folder, 'logs');
  try {
    const env = { platform: 'linux', home: base, run: recorder().run, nodePath: node, cliPath: cli, uid: 1000 };
    const lines = schedule.cronLines(env, { hour: 19, minute: 0 });
    assert.equal(lines.length, 2);
    for (const line of lines) {
      // No `%` reaches any cron, since cronie and BusyBox read one differently.
      assert.ok(!line.includes('%'), `no percent sign in the line: ${line}`);
      const cronie = cronieReads(commandOf(line));
      assert.equal(cronie.input, '', 'cronie hands nothing to the job as input');
      // BusyBox's crond hands the command to the shell exactly as written.
      for (const [cron, command] of [['cronie', cronie.command], ['busybox', commandOf(line)]]) {
        // cron's own /bin/sh, and whichever other shells this machine has, since a crontab
        // may name another in SHELL= (on Ubuntu /bin/sh is dash; on a Mac it is bash).
        for (const shell of SHELLS) {
          await rm(log, { force: true });
          await run(shell, ['-c', command]);
          const argv = (await readFile(log, 'utf8')).split('\n').slice(0, -1);
          assert.deepEqual(argv, [node, cli, 'run', '--scheduled'], `${cron}, ${shell}: ${line}`);
        }
      }
    }
  } finally {
    process.env.CARE_ALBUM_LOG_DIR = savedLogDir;
  }
});

test('an ordinary path still reads as an ordinary crontab line', () => {
  const env = { platform: 'linux', home: '/home/sam', run: recorder().run, nodePath: '/usr/bin/node', cliPath: '/opt/bw/cli.js', uid: 1000 };
  const [daily, reboot] = schedule.cronLines(env, { hour: 19, minute: 45 });
  assert.match(daily, /^45 19 \* \* \* '\/usr\/bin\/node' '\/opt\/bw\/cli\.js' run --scheduled >> '.*daily\.log' 2>&1$/);
  assert.match(reboot, /^@reboot '\/usr\/bin\/node' '\/opt\/bw\/cli\.js' run --scheduled >> '.*daily\.log' 2>&1$/);
});

// ---------------------------------------------------------------- processes-1: systemd

/**
 * ExecStart= as systemd reads it (systemd.service(5) "Command lines", systemd.syntax(7)
 * "Quoting"; config_parse_exec in load-fragment.c, exec_invoke in exec-invoke.c):
 *
 *  1. split into words, with double or single quotes around a word and C escapes inside;
 *  2. `%` specifiers in every word, the program's path included — `%%` is a percent sign;
 *  3. `$` variables in argv only, never in the path that is executed — `$$` is a dollar sign.
 *
 * Stricter than systemd where it does not matter: an escape or a specifier this tool should
 * never produce is an error here rather than a guess, and so is any `$` in an argument that
 * is not `$$`, since only `${NAME}` would be expanded inside a word and nothing here should
 * come near it.
 */
function systemdReads(line) {
  const value = line.replace(/^ExecStart=/, '');
  const escapes = { '\\': '\\', '"': '"', "'": "'", n: '\n', t: '\t', s: ' ' };
  const words = [];
  let i = 0;
  for (;;) {
    while (value[i] === ' ' || value[i] === '\t') i += 1;
    if (i >= value.length) break;
    let word = '';
    let quote = null;
    for (; i < value.length; i += 1) {
      const c = value[i];
      if (c === '\\') {
        const next = value[(i += 1)];
        if (!(next in escapes)) throw new Error(`an escape systemd would read some other way: \\${next}`);
        word += escapes[next];
      } else if (quote) {
        if (c === quote) quote = null;
        else word += c;
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === ' ' || c === '\t') {
        break;
      } else {
        word += c;
      }
    }
    if (quote) throw new Error('a quote that systemd would find unclosed');
    words.push(word);
  }
  const specifiers = (word) =>
    word.replace(/%(.?)/g, (_, s) => {
      if (s === '%') return '%';
      throw new Error(`a specifier systemd would expand: %${s}`);
    });
  const variables = (word) =>
    word.replace(/\$(.?)/g, (_, s) => {
      if (s === '$') return '$';
      throw new Error(`a variable systemd would substitute: $${s}`);
    });
  const expanded = words.map(specifiers);
  return { path: expanded[0], args: expanded.slice(1).map(variables) };
}

test('systemd gives back the program and every argument exactly, however the folders are named', async () => {
  await freshConfigDir();
  const home = await freshHome();
  const nodePath = `/opt/${AWKWARD}/bin/node`;
  const cliPath = `/srv/${AWKWARD}/dist/cli.js`;
  const env = { platform: 'linux', home, run: recorder().run, nodePath, cliPath, uid: 1000 };
  await schedule.install('19:00', env);

  const service = await readFile(join(home, '.config', 'systemd', 'user', 'care-album-saver.service'), 'utf8');
  const line = service.split('\n').find((l) => l.startsWith('ExecStart='));
  const read = systemdReads(line);
  assert.equal(read.path, nodePath, 'the program systemd executes');
  assert.deepEqual(read.args, [cliPath, 'run', '--scheduled'], 'and what it is given');
  // argv[0] is substituted where the path is not, so it is not asserted; Node finds itself
  // through the operating system, not through argv[0].
});

test('an ordinary path still reads as an ordinary ExecStart line', () => {
  // The spelling of every unit written before this change, so none of them reads differently.
  assert.deepEqual(systemdReads('ExecStart="/usr/bin/node" "/opt/bw/cli.js" run --scheduled'), {
    path: '/usr/bin/node',
    args: ['/opt/bw/cli.js', 'run', '--scheduled'],
  });
});

// ---------------------------------------------------------------- processes-1: Task Scheduler

/**
 * A command line as the Microsoft C runtime splits it, which is how node.exe gets its
 * arguments: whitespace separates outside quotes; backslashes are letters unless they run up
 * to a `"`, where each pair is one backslash and an odd one out makes the quote a letter.
 */
function windowsReads(line) {
  const out = [];
  let i = 0;
  for (;;) {
    while (line[i] === ' ' || line[i] === '\t') i += 1;
    if (i >= line.length) return out;
    let arg = '';
    let quoted = false;
    while (i < line.length && (quoted || (line[i] !== ' ' && line[i] !== '\t'))) {
      let slashes = 0;
      while (line[i] === '\\') {
        slashes += 1;
        i += 1;
      }
      if (line[i] === '"') {
        arg += '\\'.repeat(Math.floor(slashes / 2));
        if (slashes % 2 === 1) arg += '"';
        else quoted = !quoted;
        i += 1;
      } else {
        arg += '\\'.repeat(slashes);
        if (i < line.length && (quoted || (line[i] !== ' ' && line[i] !== '\t'))) {
          arg += line[i];
          i += 1;
        }
      }
    }
    out.push(arg);
  }
}

const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

test('the scheduled task gives this tool its path back as one argument', () => {
  const nodePath = 'C:\\Program Files\\nodejs\\node.exe';
  for (const cliPath of [
    'C:\\Users\\alex\\bw\\cli.js',
    "C:\\Users\\a b\\it's & ^ <x> $(y) `z` 100%\\cli.js",
    '\\\\server\\share\\care album saver\\cli.js',
    // Neither can be a Windows file name, and both are what the quoting exists for.
    'C:\\odd\\"quoted" \\\\"\\cli.js',
    'C:\\a folder\\ending in backslashes\\\\',
  ]) {
    const xml = schedule.schtasksXml({ platform: 'win32', home: 'C:\\Users\\alex', nodePath, cliPath }, { hour: 19, minute: 0 });
    const args = unxml(/<Arguments>(.*)<\/Arguments>/.exec(xml)[1]);
    assert.deepEqual(windowsReads(args), [cliPath, 'run', '--scheduled'], args);
    assert.equal(unxml(/<Command>(.*)<\/Command>/.exec(xml)[1]), nodePath);
  }
  // An ordinary path is spelled as it always was.
  const xml = schedule.schtasksXml({ platform: 'win32', home: 'C:\\Users\\alex', nodePath, cliPath: 'C:\\Users\\alex\\bw\\cli.js' }, { hour: 19, minute: 0 });
  assert.ok(xml.includes('<Arguments>"C:\\Users\\alex\\bw\\cli.js" run --scheduled</Arguments>'));
});

// ---------------------------------------------------------------- processes-1: refusals

test('a path with a line break or another control character is refused before anything is written', async () => {
  const cases = [
    ['darwin', { nodePath: '/opt/tools\n/bin/node' }],
    ['darwin', { cliPath: '/opt/tools/li\u0000b/cli.js' }],
    ['linux', { nodePath: '/usr/bin/node\r' }],
    ['linux', { cliPath: '/opt/b\tw/cli.js' }],
    ['linux-systemd', { cliPath: '/opt/b\u007fw/cli.js' }],
    ['win32', { cliPath: 'C:\\Users\\alex\\bw\u0085\\cli.js' }],
  ];
  for (const [kind, paths] of cases) {
    await freshConfigDir();
    const home = await freshHome();
    const os = recorder(({ file }) => (kind === 'linux' && file === 'systemctl' ? { code: 127 } : {}));
    const env = {
      platform: kind.replace('-systemd', ''),
      home,
      run: os.run,
      nodePath: '/usr/bin/node',
      cliPath: '/opt/bw/cli.js',
      uid: 501,
      ...paths,
    };
    await assert.rejects(() => schedule.install('19:00', env), /line break or another invisible character in it.*nothing was changed|nothing was changed.*line break or another invisible character/s, kind);
    const probes = kind === 'linux' || kind === 'linux-systemd' ? ['systemctl --user --version'] : [];
    assert.deepEqual(os.said(), probes, `${kind}: nothing but the probe for systemd was run`);
    assert.equal(await exists(join(home, 'Library')), false, `${kind}: no plist`);
    assert.equal(await exists(join(home, '.config')), false, `${kind}: no unit files`);
    assert.equal((await loadConfig()).schedule, null, `${kind}: and nothing recorded`);
  }
});

test('the log path is checked only where the job names it', async (t) => {
  // The systemd half creates the log folder, and Windows cannot name a folder with a line break.
  if (process.platform === 'win32') return t.skip('a line break cannot be in a Windows file name');
  const savedLogDir = process.env.CARE_ALBUM_LOG_DIR;
  process.env.CARE_ALBUM_LOG_DIR = join(await mkdtemp(join(tmpdir(), 'cas-sched-warn-logs-')), 'bad\nname');
  try {
    // cron writes it into the line, so it is refused there…
    await freshConfigDir();
    const noSystemd = recorder(({ file }) => (file === 'systemctl' ? { code: 127 } : {}));
    const cronEnv = { platform: 'linux', home: await freshHome(), run: noSystemd.run, nodePath: '/usr/bin/node', cliPath: '/opt/bw/cli.js', uid: 1000 };
    await assert.rejects(() => schedule.install('19:00', cronEnv), /the path to the daily log has a line break/);
    assert.ok(!noSystemd.calls.some((c) => c.file === 'crontab'), 'the crontab was not touched');
    // …while systemd sends the output to the journal, and never sees it.
    await freshConfigDir();
    const withSystemd = { ...cronEnv, home: await freshHome(), run: recorder().run };
    assert.equal((await schedule.install('19:00', withSystemd)).mechanism, 'systemd');
  } finally {
    process.env.CARE_ALBUM_LOG_DIR = savedLogDir;
  }
});

test('Task Scheduler is not handed a path it would expand a %NAME% in; one % is fine', async () => {
  for (const [path, refused] of [
    ['C:\\Users\\alex\\%USERPROFILE%\\cli.js', true],
    ['C:\\Users\\alex\\50% off\\and 50% on\\cli.js', true],
    ['C:\\Users\\alex\\100% sure\\cli.js', false],
  ]) {
    await freshConfigDir();
    const os = recorder();
    const env = { platform: 'win32', home: await freshHome(), run: os.run, nodePath: 'C:\\Program Files\\nodejs\\node.exe', cliPath: path, uid: 0 };
    if (refused) {
      await assert.rejects(() => schedule.install('19:00', env), /two % signs in it, and Task Scheduler would read the part between them/);
      assert.deepEqual(os.said(), [], 'nothing was run');
      assert.equal((await loadConfig()).schedule, null);
    } else {
      assert.equal((await schedule.install('19:00', env)).installed, true);
    }
  }
  // The same rule for Node's own path, which is the task's command.
  await freshConfigDir();
  const env = { platform: 'win32', home: await freshHome(), run: recorder().run, nodePath: 'C:\\%TOOLS%\\node.exe', cliPath: 'C:\\bw\\cli.js', uid: 0 };
  await assert.rejects(() => schedule.install('19:00', env), /the path to Node has two % signs/);
});

test('describing the job never refuses, so the setup page can still answer', async () => {
  // GET /api/schedule shows what would be installed on every page load; the refusal belongs
  // to install(), where it can be read and acted on.
  const env = { platform: 'darwin', home: await freshHome(), run: recorder().run, nodePath: '/opt/a\nb/node', cliPath: '/opt/bw/cli.js', uid: 501 };
  assert.equal((await schedule.describe('19:00', env)).mechanism, 'launchd');
});

// ---------------------------------------------------------------- processes-4: a failed install

const macEnv = (home, runner) => ({
  platform: 'darwin',
  home,
  run: runner,
  nodePath: '/opt/tools/bin/node',
  cliPath: '/opt/tools/lib/care-album-saver/cli.js',
  uid: 501,
});
const plistOf = (home) => join(home, 'Library', 'LaunchAgents', 'com.care-album-saver.daily.plist');

test('a LaunchAgent macOS would not start is taken away, not left to start at the next login', async () => {
  await freshConfigDir();
  const home = await freshHome();
  const os = recorder(({ args }) => (args[0] === 'bootstrap' ? { code: 5, stderr: 'Bootstrap failed: 5: Input/output error\n' } : {}));

  await assert.rejects(
    () => schedule.install('19:30', macEnv(home, os.run)),
    /macOS would not start the daily run, so it was taken away again .*: Bootstrap failed: 5: Input\/output error\./,
  );
  assert.equal(await exists(plistOf(home)), false, 'no plist with RunAtLoad left in ~/Library/LaunchAgents');
  assert.equal((await loadConfig()).schedule, null);
  assert.deepEqual(os.said(), [
    'launchctl bootout gui/501/com.care-album-saver.daily',
    'launchctl bootstrap gui/501 ' + plistOf(home),
    // In case launchd had taken some of it before refusing.
    'launchctl bootout gui/501/com.care-album-saver.daily',
  ]);
});

test('a change of time macOS refuses leaves no daily run, and the settings say so', async () => {
  await freshConfigDir();
  const home = await freshHome();
  await schedule.install('19:00', macEnv(home, recorder().run));
  assert.equal((await loadConfig()).schedule.time, '19:00');

  // Writing the new plist and unloading the old job are what a change of time does first,
  // so when launchd then refuses, the seven o'clock run is already gone too.
  const refuses = recorder(({ args }) => (args[0] === 'bootstrap' ? { code: 37, stderr: 'Bootstrap failed: 37: Operation already in progress' } : {}));
  await assert.rejects(() => schedule.install('20:00', macEnv(home, refuses.run)), /Operation already in progress/);
  assert.equal(await exists(plistOf(home)), false);
  assert.equal((await loadConfig()).schedule, null, 'not a record of a seven o\'clock run that no longer exists');
  const state = await schedule.status(macEnv(home, recorder().run));
  assert.equal(state.installed, false);
});

const unitDir = (home) => join(home, '.config', 'systemd', 'user');
const linuxEnv = (home, runner) => ({ platform: 'linux', home, run: runner, nodePath: '/usr/bin/node', cliPath: '/opt/bw/cli.js', uid: 1000 });

test('a timer systemd would not start is disabled and its files taken away', async () => {
  await freshConfigDir();
  const home = await freshHome();
  const os = recorder(({ args }) => (args[1] === 'enable' ? { code: 1, stderr: 'Failed to start care-album-saver.timer: Unit care-album-saver.service has a bad unit file setting.' } : {}));

  await assert.rejects(() => schedule.install('19:00', linuxEnv(home, os.run)), /systemd would not start the daily run, so its files were taken away again: Failed to start/);
  assert.equal(await exists(join(unitDir(home), 'care-album-saver.timer')), false);
  assert.equal(await exists(join(unitDir(home), 'care-album-saver.service')), false);
  assert.equal((await loadConfig()).schedule, null);
  const said = os.said();
  // `enable --now` links the timer before it starts it; the link would start it at the next login.
  assert.ok(said.indexOf('systemctl --user disable --now care-album-saver.timer') > said.indexOf('systemctl --user enable --now care-album-saver.timer'));
  assert.equal(said.at(-1), 'systemctl --user daemon-reload', 'and systemd is told the files are gone');
});

test('a reload that fails stops the install, rather than enabling the timer systemd read before', async () => {
  await freshConfigDir();
  const home = await freshHome();
  await schedule.install('19:00', linuxEnv(home, recorder().run));

  const os = recorder(({ args }) => (args[1] === 'daemon-reload' ? { code: 1, stderr: 'Failed to connect to bus: No medium found' } : {}));
  await assert.rejects(() => schedule.install('06:00', linuxEnv(home, os.run)), /No medium found/);
  assert.ok(!os.said().includes('systemctl --user enable --now care-album-saver.timer'), 'never enabled at a time it had not read');
  assert.equal(await exists(join(unitDir(home), 'care-album-saver.timer')), false);
  assert.equal((await loadConfig()).schedule, null, 'the seven o\'clock files were replaced, so its record goes too');
});

test('a crontab that refuses the new block keeps the old one, and the record that matches it', async () => {
  await freshConfigDir();
  const home = await freshHome();
  let crontab = '0 6 * * * /usr/local/bin/backup\n';
  let refuse = false;
  const os = recorder(({ file, args, input }) => {
    if (file === 'systemctl') return { code: 127 };
    if (args[0] === '-l') return { stdout: crontab };
    if (refuse) return { code: 1, stderr: 'crontab: installing new crontab: No space left on device' };
    crontab = input;
    return {};
  });
  await schedule.install('19:00', linuxEnv(home, os.run));
  const before = crontab;

  refuse = true;
  await assert.rejects(
    () => schedule.install('06:00', linuxEnv(home, os.run)),
    /could not be added to your crontab, so nothing was changed: crontab: installing new crontab: No space left on device/,
  );
  assert.equal(crontab, before, 'the seven o\'clock block is still there');
  assert.equal((await loadConfig()).schedule.time, '19:00', 'and so is its record');
});

// ---------------------------------------------------------------- missed-processes: removing

test('launchd: a job that will not unload is reported, and its plist and record are kept', async () => {
  await freshConfigDir();
  const home = await freshHome();
  await schedule.install('19:00', macEnv(home, recorder().run));

  const os = recorder(({ args }) => (args[0] === 'bootout' ? { code: 5, stderr: 'Boot-out failed: 5: Input/output error' } : {}));
  await assert.rejects(
    () => schedule.remove(macEnv(home, os.run)),
    /macOS would not stop the daily run, so it is still set up and nothing was changed: Boot-out failed: 5: Input\/output error\./,
  );
  assert.ok(await exists(plistOf(home)), 'the plist is still there, as the job is');
  assert.equal((await loadConfig()).schedule.time, '19:00', 'and the settings still say so');
  assert.deepEqual(os.said(), ['launchctl bootout gui/501/com.care-album-saver.daily', 'launchctl print gui/501/com.care-album-saver.daily']);
});

test('launchd: a job that was not loaded is already off, and its plist still goes', async () => {
  for (const [code, stderr] of [[3, 'Boot-out failed: 3: No such process'], [113, 'Could not find specified service']]) {
    await freshConfigDir();
    const home = await freshHome();
    await schedule.install('19:00', macEnv(home, recorder().run));
    const os = recorder(({ args }) => (args[0] === 'bootout' ? { code, stderr } : args[0] === 'print' ? { code: 113 } : {}));
    const state = await schedule.remove(macEnv(home, os.run));
    assert.equal(state.installed, false, stderr);
    assert.equal(await exists(plistOf(home)), false, 'a plist left behind would load it at the next login');
    assert.equal((await loadConfig()).schedule, null);
  }
});

test('launchd: with the settings unreadable, a refusal still leaves them exactly as they were', async () => {
  const dir = await freshConfigDir();
  const home = await freshHome();
  await writeFile(configPath(), '{ this is not json');
  const os = recorder(({ args }) => (args[0] === 'bootout' ? { code: 1, stderr: 'Boot-out failed: 1: Operation not permitted' } : {}));
  await assert.rejects(() => schedule.remove(macEnv(home, os.run)), /Operation not permitted/);
  assert.equal(await readFile(join(dir, 'config.json'), 'utf8'), '{ this is not json');
});

test('systemd: a timer that will not disable is reported, and its files and record are kept', async () => {
  await freshConfigDir();
  const home = await freshHome();
  await schedule.install('19:00', linuxEnv(home, recorder().run));

  const os = recorder(({ args }) => (args[1] === 'disable' ? { code: 1, stderr: 'Failed to connect to bus: No medium found' } : {}));
  await assert.rejects(
    () => schedule.remove(linuxEnv(home, os.run)),
    /systemd would not turn the daily run off, so it is still set up and nothing was changed: Failed to connect to bus: No medium found\./,
  );
  assert.ok(await exists(join(unitDir(home), 'care-album-saver.timer')));
  assert.ok(await exists(join(unitDir(home), 'care-album-saver.service')));
  assert.equal((await loadConfig()).schedule.time, '19:00');
  assert.ok(!os.said().includes('systemctl --user daemon-reload'), 'nothing after the refusal');
});

test('systemd: a timer whose file is already gone is already off', async () => {
  await freshConfigDir();
  const home = await freshHome();
  await schedule.install('19:00', linuxEnv(home, recorder().run));
  await rm(join(unitDir(home), 'care-album-saver.timer'));

  const os = recorder(({ args }) => (args[1] === 'disable' ? { code: 1, stderr: 'Failed to disable unit: Unit file care-album-saver.timer does not exist.' } : {}));
  assert.equal((await schedule.remove(linuxEnv(home, os.run))).installed, false);
  assert.equal(await exists(join(unitDir(home), 'care-album-saver.service')), false, 'the service goes with it');
  assert.equal((await loadConfig()).schedule, null);
});

const winEnv = (home, runner) => ({
  platform: 'win32',
  home,
  run: runner,
  nodePath: 'C:\\Program Files\\nodejs\\node.exe',
  cliPath: 'C:\\Users\\alex\\bw\\cli.js',
  uid: 0,
});

test('Task Scheduler: a task that will not delete is reported, and its record is kept', async () => {
  await freshConfigDir();
  const home = await freshHome();
  await schedule.install('19:00', winEnv(home, recorder().run));

  const os = recorder(({ args }) => (args[0] === '/Delete' ? { code: 1, stderr: 'ERROR: Access is denied.\r\n' } : {}));
  await assert.rejects(
    () => schedule.remove(winEnv(home, os.run)),
    /Windows Task Scheduler would not remove the daily run, so it is still set up and nothing was changed: ERROR: Access is denied\./,
  );
  assert.equal((await loadConfig()).schedule.time, '19:00');
  assert.deepEqual(os.said(), ['schtasks /Delete /TN Care Album Saver daily /F', 'schtasks /Query /TN Care Album Saver daily']);
});

test('Task Scheduler: a task that is not there is already off, in any language', async () => {
  await freshConfigDir();
  const home = await freshHome();
  await schedule.install('19:00', winEnv(home, recorder().run));

  // Exit 1 and a translated message, exactly as for "access is denied": /Query tells them apart.
  const gone = { code: 1, stderr: 'FEHLER: Das System kann die angegebene Datei nicht finden.' };
  const os = recorder(({ args }) => (args[0] === '/Delete' || args[0] === '/Query' ? gone : {}));
  assert.equal((await schedule.remove(winEnv(home, os.run))).installed, false);
  assert.equal((await loadConfig()).schedule, null);
});
