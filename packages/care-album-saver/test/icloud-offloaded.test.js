import '../../../scripts/test-env.js';
import { assertIsolatedConfigDir } from '../../../scripts/test-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManifestUnusableError, offloadedByICloud, unreadableList } from '../dist/ferry/manifest.js';
import * as schedule from '../dist/schedule.js';

// What Node 26 hands back on a Mac when a launchd job without MaterializeDatalessFiles reads a
// file iCloud Drive has moved off the disk: taken from the owner's daily run, 2026-11-08, and
// from a throwaway LaunchAgent that read one of the archive's placeholders the same way.
// Built by hand, because no test can make iCloud move a file away, and because 11 is EDEADLK
// only on a Mac (Linux's is 35).
const offloaded = () =>
  Object.assign(new Error('Unknown system error -11: Unknown system error -11, read'), {
    errno: -11,
    code: 'Unknown system error -11',
    syscall: 'read',
  });

test('a read iCloud refused is told apart by its number, and only on a Mac', () => {
  assert.equal(offloadedByICloud(offloaded(), 'darwin'), true);
  assert.equal(offloadedByICloud(offloaded(), 'linux'), false, 'errno 11 is EAGAIN on Linux, not EDEADLK');
  assert.equal(offloadedByICloud(offloaded(), 'win32'), false);
  const denied = Object.assign(new Error('EACCES: permission denied, open'), { errno: -13, code: 'EACCES', syscall: 'open' });
  assert.equal(offloadedByICloud(denied, 'darwin'), false);
  const linuxDeadlock = Object.assign(new Error('EDEADLK'), { errno: -35, code: 'EDEADLK' });
  assert.equal(offloadedByICloud(linuxDeadlock, 'darwin'), false);
  assert.equal(offloadedByICloud(null, 'darwin'), false);
  assert.equal(offloadedByICloud('a string', 'darwin'), false);
});

test('a list iCloud moved away is not called broken, and rebuilding it is not suggested', (t) => {
  if (process.platform !== 'darwin') return t.skip('the error is only read as iCloud on a Mac');
  const file = '/Users/parent/Library/Mobile Documents/com~apple~CloudDocs/Brightwheel/archive.json';
  const error = unreadableList(file, offloaded());
  assert.ok(error instanceof ManifestUnusableError);
  assert.equal(error.path, file);
  assert.match(error.message, /moved it off this Mac to save space/);
  assert.match(error.message, /Turn the daily run off and on again on the setup page/);
  assert.match(error.message, /do not move or delete it/);
  assert.match(error.message, /Nothing has been changed and nothing has been downloaded/);
  assert.doesNotMatch(error.message, /Unknown system error/);
  assert.doesNotMatch(error.message, /rebuild|second time/);
});

test('any other unreadable list keeps the reason the system gave and the way to rebuild', () => {
  const denied = Object.assign(new Error('EACCES: permission denied, open'), { errno: -13, code: 'EACCES' });
  const error = unreadableList('/archive/archive.json', denied);
  assert.ok(error instanceof ManifestUnusableError);
  assert.match(error.message, /cannot be used: EACCES: permission denied, open\./);
  assert.match(error.message, /Move that file somewhere safe and run again to rebuild the archive/);
});

test('the daily run on a Mac may bring back files iCloud Drive moved away', async () => {
  process.env.CARE_ALBUM_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'cas-icloud-config-'));
  assertIsolatedConfigDir();
  const home = await mkdtemp(join(tmpdir(), 'cas-icloud-home-'));
  const run = async () => ({ code: 0, stdout: '', stderr: '' });
  const status = await schedule.install('17:00', { platform: 'darwin', home, run, nodePath: '/usr/bin/node', cliPath: '/opt/x/cli.js', uid: 501 });
  const plist = await readFile(status.location, 'utf8');
  assert.match(plist, /<key>MaterializeDatalessFiles<\/key>\s*<true\/>/);
  // Still a background job: being allowed to download is not being given priority.
  assert.match(plist, /<key>ProcessType<\/key>\s*<string>Background<\/string>/);
});
