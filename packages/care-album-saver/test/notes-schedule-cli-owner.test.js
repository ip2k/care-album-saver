// First, before anything that can read the config directory: install() and remove() record
// what they did there (see scripts/test-env.js).
import { assertIsolatedConfigDir } from '../../../scripts/test-env.js';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../dist/config.js';
import { configPath } from '../dist/paths.js';
import * as schedule from '../dist/schedule.js';

/**
 * The review's §4.4 NOTE (from missed-web): ownership of the daily run lived only in
 * config.json's `cliPath`, so a record written before that field existed — or by a copy of
 * the tool from before it — was owned by nobody, and any copy could take the daily run over
 * without being asked. Such a record's owner is now read from the installed job itself.
 *
 * Every scheduler is a stand-in that keeps what it was given, so each test round-trips a
 * real install through the job text the scheduler would hold: the plist, the unit, the
 * crontab and the task XML. The copies of the tool are real folders, named awkwardly so each
 * scheduler's quoting has to be read back correctly (no `"`, which Windows forbids).
 */

before(assertIsolatedConfigDir);

async function freshConfigDir() {
  process.env.CARE_ALBUM_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'cas-owner-config-'));
  return assertIsolatedConfigDir();
}

/** A copy of the tool as a clone lays it out, in a folder whose name every scheduler quotes. */
async function copyOfTheTool(name, { production = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), `cas-owner-${name} it's $HOME & 100%-`));
  const pkg = join(root, 'packages', 'care-album-saver');
  await mkdir(join(pkg, 'dist'), { recursive: true });
  await writeFile(join(pkg, 'dist', 'cli.js'), '');
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: 'care-album-saver' }));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'care-album-saver', private: true }));
  if (production) await writeFile(join(root, '.care-album-saver-production'), `${root}\nproduction\n`);
  return join(pkg, 'dist', 'cli.js');
}

/** Forget which copy set the daily run up, as a record written before 2026-09-23 did. */
async function makeLegacy() {
  const config = await loadConfig();
  const { cliPath: _, ...legacy } = config.schedule;
  await writeFile(configPath(), JSON.stringify({ ...config, schedule: legacy }));
  assert.equal('cliPath' in (await loadConfig()).schedule, false);
}

/** A stand-in for each operating system's scheduler, holding what it was given. */
function standIn(platform) {
  const held = { crontab: null, task: null };
  const run = async (file, args, input) => {
    const ok = { code: 0, stdout: '', stderr: '' };
    if (file === 'systemctl') return platform === 'cron' ? { code: 127, stdout: '', stderr: '' } : ok;
    if (file === 'crontab') {
      if (args[0] === '-l') return held.crontab === null ? { code: 1, stdout: '', stderr: 'no crontab for alex' } : { ...ok, stdout: held.crontab };
      held.crontab = input;
      return ok;
    }
    if (file === 'schtasks') {
      if (args[0] === '/Create') {
        // The file exists only while schtasks runs: install() deletes it straight after.
        held.task = readFileSync(args[args.indexOf('/XML') + 1], 'utf16le').replace(/^﻿/, '');
        return ok;
      }
      if (args[0] === '/Query') {
        if (held.task === null) return { code: 1, stdout: '', stderr: 'ERROR: The system cannot find the file specified.' };
        return args.includes('/XML') ? { ...ok, stdout: held.task } : ok;
      }
      if (args[0] === '/Delete') {
        held.task = null;
        return ok;
      }
    }
    return ok;
  };
  return { run, held };
}

const PLATFORM = { launchd: 'darwin', systemd: 'linux', cron: 'linux', schtasks: 'win32' };

for (const mechanism of ['launchd', 'systemd', 'cron', 'schtasks']) {
  test(`§4.4 legacy owner, ${mechanism}: a record with no owner is owned by the copy its job runs`, async () => {
    await freshConfigDir();
    const home = await mkdtemp(join(tmpdir(), 'cas-owner-home-'));
    const os = standIn(mechanism);
    const env = (cliPath) => ({ platform: PLATFORM[mechanism], home, run: os.run, cliPath, nodePath: '/usr/bin/node', uid: 501 });
    const mine = await copyOfTheTool('mine');
    const stray = await copyOfTheTool('stray');

    await schedule.install('17:00', env(mine));
    assert.equal((await loadConfig()).schedule.mechanism, mechanism);
    await makeLegacy();

    await assert.rejects(schedule.install('19:00', env(stray)), (error) => {
      assert.ok(error instanceof schedule.ScheduleOwnedElsewhereError, String(error));
      assert.equal(error.owner, mine, 'read back from the job exactly, through its quoting');
      assert.equal(error.production, false);
      return true;
    });
    assert.equal((await loadConfig()).schedule.time, '17:00', 'nothing moved');

    // The copy that owns it changes it without being asked, as it always could.
    await schedule.install('18:00', env(mine));
    assert.equal((await loadConfig()).schedule.cliPath, mine, 'and the record names it from now on');

    await makeLegacy();
    await schedule.install('19:00', env(stray), { replace: true });
    assert.equal((await loadConfig()).schedule.cliPath, stray, 'taken over when told to');
  });
}

test('§4.4 legacy owner: a production copy\'s job, recorded without an owner, is not taken or turned off from a stray copy', async () => {
  await freshConfigDir();
  const home = await mkdtemp(join(tmpdir(), 'cas-owner-home-'));
  const os = standIn('launchd');
  const env = (cliPath) => ({ platform: 'darwin', home, run: os.run, cliPath, nodePath: '/usr/bin/node', uid: 501 });
  const production = await copyOfTheTool('production', { production: true });
  const stray = await copyOfTheTool('stray');

  await schedule.install('17:00', env(production));
  await makeLegacy();
  for (const attempt of [
    () => schedule.install('19:00', env(stray), { replace: true }),
    () => schedule.remove(env(stray), { replace: true }),
  ]) {
    await assert.rejects(attempt(), (error) => error instanceof schedule.ScheduleOwnedElsewhereError && error.production);
  }
  assert.ok((await loadConfig()).schedule, 'still set up');
});

test('§4.4 legacy owner: a job that names no copy of the tool, or a copy that is gone, owns nothing, as before', async () => {
  await freshConfigDir();
  const home = await mkdtemp(join(tmpdir(), 'cas-owner-home-'));
  const os = standIn('cron');
  const env = (cliPath) => ({ platform: 'linux', home, run: os.run, cliPath, nodePath: '/usr/bin/node', uid: 1000 });
  const gone = join(await mkdtemp(join(tmpdir(), 'cas-owner-gone-')), 'packages', 'care-album-saver', 'dist', 'cli.js');
  await schedule.install('17:00', env(gone));
  await makeLegacy();
  await schedule.install('18:00', env(await copyOfTheTool('here')));

  // A crontab someone emptied by hand: the record is all that is left, and it names no one.
  await makeLegacy();
  os.held.crontab = '0 6 * * * /usr/local/bin/backup\n';
  const other = await copyOfTheTool('other');
  await schedule.install('19:00', env(other));
  assert.equal((await loadConfig()).schedule.cliPath, other);
  assert.match(os.held.crontab, /\/usr\/local\/bin\/backup/, 'their own line is kept');
});
