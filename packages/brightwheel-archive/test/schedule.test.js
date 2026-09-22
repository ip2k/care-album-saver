// First, before anything that can read the config directory: points this file at a
// throwaway one even when it is run on its own with `node --test`, which applies no
// --import (see scripts/test-env.js).
import { assertIsolatedConfigDir } from '../../../scripts/test-env.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { loadConfig } from '../dist/config.js';
import { startMockBrightwheel, startWebUi } from '../dist/index.js';
import * as schedule from '../dist/schedule.js';

/**
 * The daily run, on four schedulers, without installing one.
 *
 * Every command is recorded rather than executed: a test may not put a LaunchAgent in the
 * developer's home directory, and the systemd, cron and schtasks branches are for machines
 * this one is not. So the runner is injected and the assertions are about exactly what
 * would be handed to the operating system — which is also the only way to check the rule
 * that matters most here, that nothing is ever passed through a shell.
 */

before(assertIsolatedConfigDir);

/**
 * A config directory of this test's own, per test.
 *
 * `install` and `remove` write the record of what they did into config.json, and
 * `configDir()` reads the environment on every call — so each test gets a computer that
 * nothing has been scheduled on before.
 */
async function freshConfigDir() {
  process.env.BRIGHTWHEEL_ARCHIVE_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'bw-sched-config-'));
  return assertIsolatedConfigDir();
}

/** A home directory of this test's own, for the plist, the unit files and the log folder. */
const freshHome = () => mkdtemp(join(tmpdir(), 'bw-sched-home-'));

/**
 * A stand-in for the operating system that remembers what it was asked to run.
 *
 * `answer` decides each call's exit status, so a test can make `systemctl --user --version`
 * fail and see the Linux branch fall back to cron.
 */
function recorder(answer = () => ({ code: 0 })) {
  const calls = [];
  const run = async (file, args, input) => {
    calls.push({ file, args, input });
    return { code: 0, stdout: '', stderr: '', ...(answer({ file, args, input }) || {}) };
  };
  return { run, calls };
}

const exists = (path) => stat(path).then(() => true, () => false);

const macEnv = (home, run) => ({
  platform: 'darwin',
  home,
  run,
  nodePath: '/opt/tools/bin/node',
  cliPath: '/opt/tools/lib/brightwheel-archive/cli.js',
  uid: 501,
});

// ---------------------------------------------------------------- the time of day

test('a time of day is read strictly, because it ends up inside a plist and a crontab', () => {
  assert.deepEqual(schedule.parseTimeOfDay('19:00'), { hour: 19, minute: 0 });
  assert.deepEqual(schedule.parseTimeOfDay('7:05'), { hour: 7, minute: 5 });
  assert.deepEqual(schedule.parseTimeOfDay('00:00'), { hour: 0, minute: 0 });
  assert.deepEqual(schedule.parseTimeOfDay(' 23:59 '), { hour: 23, minute: 59 });
  for (const bad of ['24:00', '19:60', '7', '19:0', 'evening', '', '19:00; rm -rf /', '1 9:00']) {
    assert.equal(schedule.parseTimeOfDay(bad), null, bad + ' must not be read as a time');
  }
});

test('the next run is the next time that clock reads, not twenty-four hours from now', () => {
  const monday = new Date('2026-09-21T08:00:00');
  const evening = schedule.nextOccurrence({ hour: 19, minute: 30 }, monday);
  assert.equal(evening.getDate(), monday.getDate(), 'still today when the time is ahead of us');
  assert.equal(evening.getHours(), 19);
  assert.equal(evening.getMinutes(), 30);

  const afterwards = new Date('2026-09-21T20:00:00');
  const tomorrow = schedule.nextOccurrence({ hour: 19, minute: 30 }, afterwards);
  assert.equal(tomorrow.getDate(), afterwards.getDate() + 1, 'tomorrow once the time has gone by');
  assert.equal(tomorrow.getHours(), 19);
});

// ---------------------------------------------------------------- macOS

test('on a Mac the daily run is a LaunchAgent, loaded with an argument array', async () => {
  await freshConfigDir();
  const home = await freshHome();
  const os = recorder();

  const state = await schedule.install('19:30', macEnv(home, os.run));

  const plist = join(home, 'Library', 'LaunchAgents', 'com.brightwheel-archive.daily.plist');
  assert.ok(await exists(plist), 'the plist must be written into ~/Library/LaunchAgents');
  const xml = await readFile(plist, 'utf8');

  // The job itself: node, this tool's own entry point, and the run that records its outcome.
  assert.match(xml, /<key>Label<\/key>\s*\n?\s*<string>com\.brightwheel-archive\.daily<\/string>/);
  assert.match(xml, /<string>\/opt\/tools\/bin\/node<\/string>/);
  assert.match(xml, /<string>\/opt\/tools\/lib\/brightwheel-archive\/cli\.js<\/string>/);
  assert.match(xml, /<string>run<\/string>/);
  assert.match(xml, /<string>--scheduled<\/string>/);
  // Not npx. A scheduled job has almost no PATH, and on Windows `npx` is `npx.cmd`; the
  // absolute paths above are what make both problems not exist.
  assert.ok(!xml.includes('npx'), 'the scheduled job must never go through npx');

  // The daily trigger, which is what makes it a schedule rather than a one-off.
  assert.match(xml, /<key>StartCalendarInterval<\/key>/);
  assert.match(xml, /<key>Hour<\/key><integer>19<\/integer>/);
  assert.match(xml, /<key>Minute<\/key><integer>30<\/integer>/);

  assert.deepEqual(
    os.calls.map((c) => [c.file, c.args]),
    [
      // Unloaded first: launchctl refuses to bootstrap a label it already holds, so without
      // this a change of time would write a plist nothing ever read.
      ['launchctl', ['bootout', 'gui/501/com.brightwheel-archive.daily']],
      ['launchctl', ['bootstrap', 'gui/501', plist]],
      // status() asks the operating system whether it really has the job.
      ['launchctl', ['print', 'gui/501/com.brightwheel-archive.daily']],
    ],
  );

  assert.equal(state.installed, true);
  assert.equal(state.mechanism, 'launchd');
  assert.equal(state.time, '19:30');
  assert.equal(state.registered, true);
  assert.ok(new Date(state.nextRun).getTime() > Date.now(), 'the next run must be in the future');
  assert.match(state.summary, /every day at 7:30 in the evening/);
  assert.match(state.summary, /only happens while the computer is on/i);

  // And written down, so the page can say what time it runs without asking launchd.
  const config = await loadConfig();
  assert.equal(config.schedule.time, '19:30');
  assert.equal(config.schedule.mechanism, 'launchd');
  assert.equal(config.schedule.location, plist);
});

test('installing twice changes the time instead of leaving two daily runs', async () => {
  await freshConfigDir();
  const home = await freshHome();
  const os = recorder();
  const env = macEnv(home, os.run);

  await schedule.install('19:30', env);
  const second = await schedule.install('06:15', env);

  const plist = join(home, 'Library', 'LaunchAgents', 'com.brightwheel-archive.daily.plist');
  const xml = await readFile(plist, 'utf8');
  assert.match(xml, /<key>Hour<\/key><integer>6<\/integer>/);
  assert.match(xml, /<key>Minute<\/key><integer>15<\/integer>/);
  assert.ok(!xml.includes('<integer>19</integer>'), 'the old time must be gone, not alongside the new one');
  assert.equal((await loadConfig()).schedule.time, '06:15');
  assert.equal(second.time, '06:15');

  // One label, loaded once per install, each preceded by an unload. Two bootstraps with no
  // bootout between them is exactly the state that leaves a Mac running the job twice.
  const bootstraps = os.calls.filter((c) => c.args[0] === 'bootstrap');
  const bootouts = os.calls.filter((c) => c.args[0] === 'bootout');
  assert.equal(bootstraps.length, 2);
  assert.equal(bootouts.length, 2);
});

test('removing the daily run takes the plist away, and removing it twice is not an error', async () => {
  await freshConfigDir();
  const home = await freshHome();
  const os = recorder();
  const env = macEnv(home, os.run);
  await schedule.install('19:30', env);
  const plist = join(home, 'Library', 'LaunchAgents', 'com.brightwheel-archive.daily.plist');

  const after = await schedule.remove(env);
  assert.equal(await exists(plist), false, 'the plist must be gone');
  assert.equal(after.installed, false);
  assert.equal(after.time, null);
  assert.equal((await loadConfig()).schedule, null);
  assert.match(after.summary, /not being saved automatically/i);
  assert.ok(os.calls.some((c) => c.file === 'launchctl' && c.args[0] === 'bootout'));

  // Again, on a computer that now has no schedule at all.
  const again = await schedule.remove(env);
  assert.equal(again.installed, false);
});

test('a daily run the computer no longer has is reported as gone, not as working', async () => {
  await freshConfigDir();
  const home = await freshHome();
  await schedule.install('19:30', macEnv(home, recorder().run));

  // Someone deleted the LaunchAgent by hand, or a migration lost it.
  const denies = recorder(({ args }) => (args[0] === 'print' ? { code: 113 } : { code: 0 }));
  const state = await schedule.status(macEnv(home, denies.run));
  assert.equal(state.installed, true, 'the tool still believes it set one up');
  assert.equal(state.registered, false, 'and the operating system says otherwise');
  assert.match(state.summary, /no longer there/i);
});

// ---------------------------------------------------------------- Linux

test('on Linux with systemd the daily run is a user timer', async () => {
  await freshConfigDir();
  const home = await freshHome();
  const os = recorder();
  const env = { platform: 'linux', home, run: os.run, nodePath: '/usr/bin/node', cliPath: '/opt/bw/cli.js', uid: 1000 };

  const state = await schedule.install('19:00', env);
  assert.equal(state.mechanism, 'systemd');

  const unitDir = join(home, '.config', 'systemd', 'user');
  const service = await readFile(join(unitDir, 'brightwheel-archive.service'), 'utf8');
  const timer = await readFile(join(unitDir, 'brightwheel-archive.timer'), 'utf8');
  assert.match(service, /^ExecStart="\/usr\/bin\/node" "\/opt\/bw\/cli\.js" run --scheduled$/m);
  assert.match(timer, /^OnCalendar=\*-\*-\* 19:00:00$/m);
  // A run missed because the machine was off should happen when it comes back, not be
  // skipped until tomorrow.
  assert.match(timer, /^Persistent=true$/m);
  assert.match(timer, /^WantedBy=timers\.target$/m);

  const commands = os.calls.map((c) => [c.file, c.args.join(' ')]);
  assert.deepEqual(commands[0], ['systemctl', '--user --version'], 'systemd is looked for before it is used');
  assert.ok(commands.some(([f, a]) => f === 'systemctl' && a === '--user daemon-reload'));
  assert.ok(commands.some(([f, a]) => f === 'systemctl' && a === '--user enable --now brightwheel-archive.timer'));

  const gone = await schedule.remove(env);
  assert.equal(gone.installed, false);
  assert.equal(await exists(join(unitDir, 'brightwheel-archive.timer')), false);
  assert.equal(await exists(join(unitDir, 'brightwheel-archive.service')), false);
});

test('on Linux without systemd it falls back to cron, and keeps the crontab that is there', async () => {
  await freshConfigDir();
  const home = await freshHome();
  // No systemd, and a crontab the person wrote themselves.
  const theirs = '# my own job\n0 8 * * * /usr/local/bin/backup.sh\n';
  let crontab = theirs;
  const os = recorder(({ file, args, input }) => {
    if (file === 'systemctl') return { code: 127 };
    if (file === 'crontab' && args[0] === '-l') return { code: 0, stdout: crontab };
    if (file === 'crontab' && args[0] === '-') {
      crontab = input;
      return { code: 0 };
    }
    return { code: 0 };
  });
  const env = { platform: 'linux', home, run: os.run, nodePath: '/usr/bin/node', cliPath: '/opt/bw/cli.js', uid: 1000 };

  const state = await schedule.install('19:45', env);
  assert.equal(state.mechanism, 'cron');
  assert.ok(crontab.includes(theirs.trim()), 'their own job must survive untouched');
  assert.match(crontab, /^45 19 \* \* \* "\/usr\/bin\/node" "\/opt\/bw\/cli\.js" run --scheduled >> ".*daily\.log" 2>&1$/m);
  assert.equal(crontab.match(/brightwheel-archive: the daily run/g).length, 1);

  // Changing the time rewrites the one block rather than adding a second.
  await schedule.install('06:00', env);
  assert.equal(crontab.match(/brightwheel-archive: the daily run/g).length, 1, 'exactly one block, always');
  assert.match(crontab, /^0 6 \* \* \* /m);
  assert.ok(crontab.includes(theirs.trim()));

  await schedule.remove(env);
  assert.ok(!crontab.includes('brightwheel-archive'), 'ours is gone');
  assert.ok(crontab.includes('/usr/local/bin/backup.sh'), 'and theirs is not');
});

// ---------------------------------------------------------------- Windows

test('on Windows the daily run is a scheduled task, created with /F so there is only ever one', async () => {
  await freshConfigDir();
  const home = await freshHome();
  const os = recorder();
  const env = {
    platform: 'win32',
    home,
    run: os.run,
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    cliPath: 'C:\\Users\\alex\\bw\\cli.js',
    uid: 0,
  };

  const state = await schedule.install('19:00', env);
  assert.equal(state.mechanism, 'schtasks');

  const create = os.calls.find((c) => c.args[0] === '/Create');
  assert.equal(create.file, 'schtasks');
  assert.deepEqual(create.args, [
    '/Create',
    '/TN',
    'Brightwheel Archive daily',
    '/TR',
    '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\alex\\bw\\cli.js" run --scheduled',
    '/SC',
    'DAILY',
    '/ST',
    '19:00',
    '/F',
  ]);
  // The documented Windows trap: Task Scheduler cannot run a bare `npx`, because the shim
  // is `npx.cmd` and there is no `npx.exe`. Naming node.exe outright sidesteps it.
  assert.ok(!create.args.join(' ').includes('npx'));

  await schedule.remove(env);
  const del = os.calls.find((c) => c.args[0] === '/Delete');
  assert.deepEqual(del.args, ['/Delete', '/TN', 'Brightwheel Archive daily', '/F']);
});

// ---------------------------------------------------------------- the rule that matters

test('nothing the scheduler is asked to do goes through a shell', async () => {
  await freshConfigDir();
  const seen = [];
  const collect = recorder(({ file, args, input }) => {
    seen.push({ file, args, input });
    if (file === 'systemctl' && args[1] === '--version') return { code: 127 };
    return { code: 0, stdout: '' };
  });

  // Every branch, on a machine that is none of them.
  for (const platform of ['darwin', 'linux', 'win32']) {
    const home = await freshHome();
    await freshConfigDir();
    const env = { platform, home, run: collect.run, nodePath: '/usr/bin/node', cliPath: '/opt/bw/cli.js', uid: 501 };
    await schedule.install('19:00', env);
    await schedule.remove(env);
  }

  const shells = ['sh', 'bash', 'zsh', 'dash', 'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', '/bin/sh', '/bin/bash'];
  for (const call of seen) {
    assert.ok(!shells.includes(call.file), call.file + ' is a shell, and no command here may be one');
    assert.ok(Array.isArray(call.args), 'arguments are always an array, never one joined string');
    for (const arg of call.args) {
      // A `&&`, a `|` or a `;` inside an argument is the signature of a command line that
      // was built as text. The crontab's own redirection is not here: it travels on stdin.
      assert.ok(!/[;&|`$]/.test(arg), 'an argument must not carry shell punctuation: ' + arg);
    }
  }
  assert.ok(seen.length > 0, 'the loop above must actually have run some commands');
});

// ---------------------------------------------------------------- how the last run went

test('how the last run went survives the run, and sits beside the config, not in the archive', async () => {
  const dir = await freshConfigDir();
  assert.equal(await schedule.loadLastRun(), null, 'nothing has run yet');

  assert.equal(schedule.lastRunPath(), join(dir, 'last-run.json'));
  await schedule.recordRun({
    at: '2026-09-22T19:00:12.000Z',
    ok: false,
    saved: 0,
    failed: 0,
    message: 'Your Brightwheel session has expired.',
    trigger: 'schedule',
  });

  const home = await freshHome();
  await schedule.install('19:00', macEnv(home, recorder().run));
  const state = await schedule.status(macEnv(home, recorder().run));
  assert.equal(state.lastRun.ok, false);
  assert.equal(state.lastRun.trigger, 'schedule');
  assert.match(state.lastRun.message, /session has expired/);

  // Owner-only, like the session: it names how many of a child's photos arrived and when.
  if (process.platform !== 'win32') {
    const mode = (await stat(schedule.lastRunPath())).mode & 0o777;
    assert.equal(mode, 0o600);
  }
});

// ---------------------------------------------------------------- the setup page and its routes

/**
 * The page and the endpoints behind step 4.
 *
 * Nothing here installs anything. `POST /api/schedule` reaches the real launchd on the
 * machine running the tests — there is deliberately no way to hand the web server an
 * injected runner, because a web request must not be able to choose which scheduler it
 * talks to — so these exercise the reads and the refusals, and the installing itself is
 * covered above, where the operating system is a recorder.
 */

let mock;
before(async () => { mock = await startMockBrightwheel({ validSession: 'test-session-value' }); });
after(async () => { await mock?.close(); });

async function setupUi() {
  const handle = await startWebUi({ baseUrl: mock.url + '/api/v1' });
  const call = async (path, body) => {
    const res = await fetch('http://127.0.0.1:' + handle.port + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', 'x-setup-token': handle.token },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const html = () => fetch('http://127.0.0.1:' + handle.port + '/?token=' + handle.token).then((r) => r.text());
  return { handle, call, html };
}

test('the page carries a fourth step that explains the daily run in a parent’s words', async () => {
  await freshConfigDir();
  const { handle, html } = await setupUi();
  try {
    const page = await html();
    // Asserted against the card itself rather than the whole document: a failure then
    // prints the card, not fifty kilobytes of stylesheet.
    const fourth = page.indexOf('id="card-schedule"');
    const card = page.slice(fourth, page.indexOf('</ol>', fourth));
    const runCard = page.slice(page.indexOf('id="card-run"'), fourth);

    assert.ok(card.length > 0, 'there is a step 4 card');
    assert.ok(card.includes('id="schedule-time"'), 'with a time to choose');
    assert.ok(card.includes('id="btn-schedule-on"') && card.includes('id="btn-schedule-off"'));

    // Step 3 stops reading as the end of the story.
    assert.match(runCard, /This is the one-time part/);
    assert.match(runCard, /Step 4 is what makes it happen without you/);

    // What a scheduled task is, and the one limitation that surprises people.
    assert.match(card, /What a scheduled task is/);
    assert.match(card, /only happens while the computer is\s+switched on/);
    // And it is genuinely optional: saying no has its own plain sentence, not a nag.
    assert.match(card, /You do not have to/);
    assert.match(card, /press <b>Start saving<\/b> in step 3/);

    // The steps still say how many there are, and the count is now four everywhere.
    assert.ok(!/Step \d of 3/.test(page.slice(page.indexOf('<script>'))), 'no leftover "of 3" in the script');
    assert.ok(card.includes('Step 4 of 4'));
  } finally {
    await handle.close();
  }
});

test('the page has a management rendering, folded away until the tool is really set up', async () => {
  await freshConfigDir();
  const { handle, html } = await setupUi();
  try {
    const page = await html();
    const script = page.slice(page.indexOf('<script>') + 8, page.indexOf('</script>'));
    new Script(script); // it must still be a script a browser can read
    const manage = page.slice(page.indexOf('id="card-manage"'), page.indexOf('<script>'));

    // Present in the markup and hidden, so the first-run page is unchanged by it.
    assert.ok(/<section class="card" id="card-manage"[^>]*hidden>/.test(page), 'the management card starts hidden');
    assert.ok(page.includes('<details id="setup-details" hidden>'), 'and so does the disclosure it folds into');

    // The five things a returning parent comes back for.
    for (const id of ['m-run', 'm-open', 'm-session', 'm-time', 'm-off']) {
      assert.ok(manage.includes('id="' + id + '"'), 'the management view offers ' + id);
    }
    // ...and the three maintenance actions.
    for (const id of ['m-children', 'm-check', 'm-dupes']) {
      assert.ok(manage.includes('id="' + id + '"'), 'the management view offers ' + id);
    }

    // It is the same page rendered differently: the steps are moved into the disclosure,
    // not duplicated or replaced.
    assert.match(script, /setup-inner'\)\.appendChild\(document\.querySelector\('ol\.steps-list'\)\)/);
    assert.match(script, /if \(d\.manage\) enterManageMode\(\)/);
    // Deleting is asked about, never done on one press.
    assert.match(script, /\$\('m-dupes-go'\)\.onclick = confirmDupes/);
    assert.match(script, /Yes, delete them/);
  } finally {
    await handle.close();
  }
});

test('the schedule endpoint answers, refuses a time that is not one, and needs the token', async () => {
  await freshConfigDir();
  const { handle, call } = await setupUi();
  try {
    const state = await call('/api/schedule');
    assert.equal(state.status, 200);
    assert.equal(state.body.ok, true);
    assert.equal(state.body.schedule.installed, false);
    // No session and no schedule is a first run, whatever else is true.
    assert.equal(state.body.manage, false);
    assert.ok(state.body.proposed.mechanism, 'it says which scheduler this machine would use');

    // Refused before anything is installed: the time goes into a plist and a crontab.
    const bad = await call('/api/schedule', { time: 'tea time' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.field, 'scheduleTime');
    assert.equal((await loadConfig()).schedule, null, 'and nothing was written down');

    // Deleting needs the list, at the endpoint as well as in the function behind it.
    const noList = await call('/api/maintenance/duplicates/remove', {});
    assert.equal(noList.status, 400);
    assert.match(noList.body.error, /nothing was deleted/i);

    for (const path of ['/api/schedule', '/api/maintenance/archive', '/api/open-folder']) {
      const res = await fetch('http://127.0.0.1:' + handle.port + path, {
        method: path === '/api/schedule' ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: path === '/api/schedule' ? undefined : '{}',
      });
      assert.equal(res.status, 403, path + ' must refuse a request with no token');
    }
  } finally {
    await handle.close();
  }
});
