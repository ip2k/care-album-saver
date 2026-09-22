// Imported first, as in every other file that names a config directory: it points this
// run at a throwaway one even under a bare `node --test` (see scripts/test-env.js).
import { assertIsolatedConfigDir } from '../../../scripts/test-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { checkArchiveDir } from '../dist/index.js';

/**
 * The archive-location rules for platforms this machine is not.
 *
 * checkArchiveDir takes the platform, home, temp folder and environment as options
 * precisely so that these cases run everywhere: a Windows regression must fail on the
 * Mac where it was written, not three continents away on a windows-latest runner. The
 * paths are synthetic; nothing here touches the disk.
 */

const windows = {
  platform: 'win32',
  homedir: 'C:\\Users\\Sam',
  tmpdir: 'C:\\Users\\Sam\\AppData\\Local\\Temp',
  env: {
    SystemRoot: 'C:\\Windows',
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    LOCALAPPDATA: 'C:\\Users\\Sam\\AppData\\Local',
  },
};

test('Windows: temporary folders are refused, whatever their capitalisation', () => {
  const bad = [
    'C:\\Users\\Sam\\AppData\\Local\\Temp\\pwned',
    'C:\\Windows\\Temp\\x',
    // NTFS ignores case; the check must too, or `c:\windows\temp` walks straight past it.
    'c:\\windows\\temp\\x',
    'C:/Users/Sam/AppData/Local/Temp/forward-slashes',
  ];
  for (const path of bad) {
    const v = checkArchiveDir(path, windows);
    assert.equal(v.ok, false, `${path} should be refused`);
    assert.match(v.error, /temporary folder/i);
    // The suggestion must be a Windows path, not a POSIX one on a Windows machine.
    assert.match(v.error, /C:\\Users\\Sam\\Brightwheel Photos/);
  }
});

test('Windows: the operating system and program folders are refused', () => {
  for (const path of ['C:\\Windows\\System32', 'C:\\Program Files\\Brightwheel', 'C:\\Program Files (x86)\\x', 'c:\\program files\\y']) {
    const v = checkArchiveDir(path, windows);
    assert.equal(v.ok, false, `${path} should be refused`);
    assert.match(v.error, /operating system/i);
  }
});

test('Windows: a bare drive, a bare share and the home folder are too broad', () => {
  for (const path of ['C:\\', 'D:\\', 'C:/', '\\\\nas\\share', 'C:\\Users\\Sam', 'c:\\users\\sam', '~']) {
    const v = checkArchiveDir(path, windows);
    assert.equal(v.ok, false, `${path} should be refused`);
    assert.match(v.error, /folder of its own/i);
  }
});

test('Windows: ~ expands to the profile folder with either slash', () => {
  for (const path of ['~\\Brightwheel Photos', '~/Brightwheel Photos']) {
    const v = checkArchiveDir(path, windows);
    assert.equal(v.ok, true, `${path} should be permitted`);
    assert.equal(v.resolved, 'C:\\Users\\Sam\\Brightwheel Photos');
    assert.equal(v.warning, undefined);
  }
});

test('Windows: a second drive and a plain folder are fine', () => {
  for (const path of ['D:\\Photos\\Kids', 'C:\\Users\\Sam\\Pictures\\Brightwheel', 'C:\\Users\\Sam\\Brightwheel Photos']) {
    const v = checkArchiveDir(path, windows);
    assert.equal(v.ok, true, `${path} should be permitted`);
    assert.equal(v.warning, undefined, `${path} should not warn`);
  }
});

test('Windows: cloud-synced folders warn despite the backslashes', () => {
  const cases = [
    ['C:\\Users\\Sam\\OneDrive\\Pictures', /OneDrive/],
    ['C:\\Users\\Sam\\OneDrive - Contoso\\Kids', /OneDrive/],
    ['C:\\Users\\Sam\\iCloudDrive\\Kids', /iCloud Drive/],
    ['C:\\Users\\Sam\\Dropbox\\Kids', /Dropbox/],
    ['G:\\My Drive\\Kids', /Google Drive/],
    ['C:\\Users\\Sam\\Documents\\Kids', /OneDrive/],
    ['C:\\Users\\Sam\\Desktop\\Kids', /OneDrive/],
  ];
  for (const [path, expected] of cases) {
    const v = checkArchiveDir(path, windows);
    assert.equal(v.ok, true, `${path} should be permitted`);
    assert.ok(v.warning, `${path} should warn`);
    assert.match(v.warning, expected);
  }
});

test('Windows: a scrubbed environment falls back to the conventional locations', () => {
  const bare = { ...windows, env: {} };
  assert.equal(checkArchiveDir('C:\\Windows\\Temp\\x', bare).ok, false);
  assert.equal(checkArchiveDir('C:\\Program Files\\x', bare).ok, false);
  assert.equal(checkArchiveDir('C:\\Program Files (x86)\\x', bare).ok, false);
  assert.equal(checkArchiveDir('D:\\Photos', bare).ok, true);
});

test('Windows: the system drive follows SystemRoot rather than assuming C:', () => {
  const onD = { ...windows, env: { SystemRoot: 'D:\\Windows' } };
  assert.equal(checkArchiveDir('D:\\Windows\\Temp\\x', onD).ok, false);
  assert.equal(checkArchiveDir('D:\\Program Files\\x', onD).ok, false);
  // C: is now just another drive.
  assert.equal(checkArchiveDir('C:\\Photos', onD).ok, true);
});

test('POSIX: ~ alone is the home folder and ~user is left alone', () => {
  const mac = { platform: 'darwin', homedir: '/Users/sam', tmpdir: '/var/folders/zz/T' };
  assert.equal(checkArchiveDir('~', mac).ok, false, 'the whole home folder');
  assert.equal(checkArchiveDir('~/', mac).ok, false, 'the whole home folder, trailing slash');
  const good = checkArchiveDir('~/Brightwheel Photos', mac);
  assert.equal(good.ok, true);
  assert.equal(good.resolved, '/Users/sam/Brightwheel Photos');
  // `~sam` names another account's home on POSIX. Guessing "$HOME/sam" would be wrong,
  // so it is treated as a literal folder name instead.
  assert.ok(!checkArchiveDir('~sam/x', mac).resolved.startsWith('/Users/sam/'));
});

test('POSIX: the Linux rules do not depend on the host being Linux', () => {
  const linux = { platform: 'linux', homedir: '/home/sam', tmpdir: '/tmp' };
  assert.equal(checkArchiveDir('/tmp/x', linux).ok, false);
  assert.equal(checkArchiveDir('/usr/local/x', linux).ok, false);
  assert.equal(checkArchiveDir('/', linux).ok, false);
  assert.equal(checkArchiveDir('/home/sam', linux).ok, false);
  const ok = checkArchiveDir('/home/sam/Brightwheel Photos', linux);
  assert.equal(ok.ok, true);
  assert.equal(ok.warning, undefined);
});

test('Docker: the documented /photos volume passes as the node user and as any --user', () => {
  // The Dockerfile runs `--dir /photos` with BRIGHTWHEEL_ARCHIVE_CONFIG_DIR=/config. When
  // `docker run --user` names a uid with no passwd entry, Docker sets HOME to `/`, so the
  // check must not mistake /photos for something inside the home folder in that case.
  for (const home of ['/home/node', '/']) {
    const v = checkArchiveDir('/photos', { platform: 'linux', homedir: home, tmpdir: '/tmp' });
    assert.equal(v.ok, true, `/photos should be permitted with HOME=${home}`);
    assert.equal(v.warning, undefined);
  }
  // HOME=/ must not make the drive root acceptable.
  assert.equal(checkArchiveDir('/', { platform: 'linux', homedir: '/', tmpdir: '/tmp' }).ok, false);
});

test('the file-mode tests skip on Windows with a printed reason, never silently', async (t) => {
  // Runs the integration file in a child that believes it is on Windows. The two tests
  // that assert 0600/0700 must be reported as skipped, with the reason in the output —
  // that is what turns "35 pass" on a Windows runner from a question into an answer.
  const file = fileURLToPath(new URL('./integration.test.js', import.meta.url));
  const configDir = await mkdtemp(join(tmpdir(), 'bw-test-config-child-'));
  // The child runs the real setup UI, so it gets a throwaway directory and the same guard
  // the child itself applies — checked here too, because the child's own failure would be
  // buried in its TAP output rather than reported as this test failing.
  // Restored afterwards: this is the process every other test file in this run shares, and
  // leaving it pointed somewhere else is how one test quietly decides another's fate.
  const previous = process.env.BRIGHTWHEEL_ARCHIVE_CONFIG_DIR;
  process.env.BRIGHTWHEEL_ARCHIVE_CONFIG_DIR = configDir;
  t.after(() => { process.env.BRIGHTWHEEL_ARCHIVE_CONFIG_DIR = previous; });
  assert.equal(assertIsolatedConfigDir(), configDir);
  // The runner marks its own children with NODE_TEST_CONTEXT, and a grandchild that
  // inherits it reports in the runner's internal protocol instead of TAP.
  const { NODE_TEST_CONTEXT: _, ...env } = process.env;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ['--test', '--test-reporter=tap', file],
    {
      env: { ...env, BRIGHTWHEEL_ARCHIVE_TEST_PLATFORM: 'win32', BRIGHTWHEEL_ARCHIVE_CONFIG_DIR: configDir },
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  const skipped = stdout.split('\n').filter((line) => /# SKIP/.test(line));
  assert.equal(skipped.length, 2, `expected exactly the two mode tests to skip, got:\n${skipped.join('\n')}`);
  for (const line of skipped) {
    assert.match(line, /owner-only/, 'only the mode tests may be skipped');
    assert.match(line, /POSIX file modes do not exist on Windows/, 'the reason must be printed');
  }
  assert.match(stdout, /^# fail 0$/m, 'everything else must still pass');
});
