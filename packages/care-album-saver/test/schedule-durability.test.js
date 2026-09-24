// First, before anything that can read the config directory: install() records the job there.
import { assertIsolatedConfigDir } from '../../../scripts/test-env.js';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as schedule from '../dist/schedule.js';
import { loadConfig, saveConfig } from '../dist/config.js';

/** What install() wrote down as the path that will not survive an upgrade, if any. */
const recordedFragile = async () => (await loadConfig()).schedule?.fragilePath;

/**
 * A daily run that survives `brew upgrade node`.
 *
 * `process.execPath` follows symlinks, so under Homebrew it names the versioned keg —
 * <prefix>/Cellar/node/26.9.0/bin/node — which the next upgrade deletes. A job that recorded
 * it stayed registered and never ran again. These tests build a real Homebrew-shaped tree in
 * a temporary folder, with real symlinks, and then do to it what `brew upgrade` does.
 */

before(assertIsolatedConfigDir);

/** A Homebrew prefix with one formula installed at one version, linked as Homebrew links it. */
async function brewPrefix(formula = 'node', version = '26.9.0') {
  const prefix = await mkdtemp(join(tmpdir(), 'cas-brew-'));
  await installKeg(prefix, formula, version);
  await mkdir(join(prefix, 'opt'), { recursive: true });
  await symlink(`../Cellar/${formula}/${version}`, join(prefix, 'opt', formula));
  return prefix;
}

async function installKeg(prefix, formula, version) {
  const bin = join(prefix, 'Cellar', formula, version, 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'node'), '#!/bin/sh\n');
  await chmod(join(bin, 'node'), 0o755);
}

/** What `brew upgrade` does: a new keg, the opt link moved to it, the old keg cleaned up. */
async function upgrade(prefix, formula, from, to) {
  await installKeg(prefix, formula, to);
  await rm(join(prefix, 'opt', formula));
  await symlink(`../Cellar/${formula}/${to}`, join(prefix, 'opt', formula));
  await rm(join(prefix, 'Cellar', formula, from), { recursive: true });
}

const exists = (path) => stat(path).then(() => true, () => false);

test('a Homebrew keg path is written as the opt link that follows upgrades', async () => {
  const prefix = await brewPrefix();
  const keg = join(prefix, 'Cellar/node/26.9.0/bin/node');
  assert.equal(schedule.durableNodePath(keg), join(prefix, 'opt/node/bin/node'));
});

test('a keg-only versioned formula, never linked into bin, still gets its opt link', async () => {
  const prefix = await brewPrefix('node@22', '22.11.0');
  const keg = join(prefix, 'Cellar/node@22/22.11.0/bin/node');
  assert.equal(schedule.durableNodePath(keg), join(prefix, 'opt/node@22/bin/node'));
});

test('without an opt link, or with one that leads elsewhere, the keg path is kept as it is', async () => {
  const bare = await mkdtemp(join(tmpdir(), 'cas-brew-'));
  await installKeg(bare, 'node', '26.9.0');
  const keg = join(bare, 'Cellar/node/26.9.0/bin/node');
  assert.equal(schedule.durableNodePath(keg), keg, 'no opt link at all');

  // An opt link for node that leads into a different formula's kegs is not trusted.
  const odd = await brewPrefix('node', '26.9.0');
  await installKeg(odd, 'something-else', '1.0.0');
  await rm(join(odd, 'opt/node'));
  await symlink('../Cellar/something-else/1.0.0', join(odd, 'opt/node'));
  const oddKeg = join(odd, 'Cellar/node/26.9.0/bin/node');
  assert.equal(schedule.durableNodePath(oddKeg), oddKeg);
});

test('a Node that is not Homebrew\'s is left alone', () => {
  for (const path of ['/usr/bin/node', '/usr/local/bin/node', '/opt/tools/bin/node', 'C:\\Program Files\\nodejs\\node.exe']) {
    assert.equal(schedule.durableNodePath(path), path);
  }
});

test('the job installed from a keg keeps working after `brew upgrade node`', async () => {
  process.env.CARE_ALBUM_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'cas-brew-config-'));
  assertIsolatedConfigDir();
  const prefix = await brewPrefix('node', '26.9.0');
  const home = await mkdtemp(join(tmpdir(), 'cas-brew-home-'));
  const run = async () => ({ code: 0, stdout: '', stderr: '' });
  const status = await schedule.install('19:00', {
    platform: 'darwin',
    home,
    run,
    nodePath: join(prefix, 'Cellar/node/26.9.0/bin/node'),
    cliPath: '/opt/tools/lib/care-album-saver/cli.js',
    uid: 501,
  });

  const plist = await readFile(status.location, 'utf8');
  const recorded = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1];
  assert.equal(recorded, join(prefix, 'opt/node/bin/node'), 'the job names the opt link, not the keg');
  assert.ok(!plist.includes('/Cellar/'), 'and the keg appears nowhere in it');
  assert.equal(await recordedFragile(), null, 'so it is not recorded as fragile');

  await upgrade(prefix, 'node', '26.9.0', '26.10.0');
  assert.equal(await exists(join(prefix, 'Cellar/node/26.9.0')), false, 'the old keg is gone');
  assert.equal(await exists(recorded), true, 'and the path in the job still leads to a Node');
});

test('a Node the tool cannot make durable is named as the fragile path, for every kind it knows', async () => {
  process.env.CARE_ALBUM_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'cas-brew-config-'));
  assertIsolatedConfigDir();
  const bare = await mkdtemp(join(tmpdir(), 'cas-brew-'));
  await installKeg(bare, 'node', '26.9.0');
  const run = async () => ({ code: 0, stdout: '', stderr: '' });
  for (const nodePath of [
    join(bare, 'Cellar/node/26.9.0/bin/node'),
    '/Users/alex/.asdf/installs/nodejs/22.11.0/bin/node',
    '/Users/alex/.local/share/mise/installs/node/22.11.0/bin/node',
    '/Users/alex/.nodenv/versions/22.11.0/bin/node',
    '/Users/alex/.nvm/versions/node/v22.11.0/bin/node',
  ]) {
    const home = await mkdtemp(join(tmpdir(), 'cas-brew-home-'));
    await schedule.install('19:00', {
      platform: 'darwin',
      home,
      run,
      nodePath,
      cliPath: '/opt/tools/lib/care-album-saver/cli.js',
      uid: 501,
    });
    assert.equal(await recordedFragile(), nodePath, nodePath);
  }
});

// ---------------------------------------------------------------- the review's cases (2026-09-23)

test('the older Intel layout, with the Cellar inside the repository, finds opt one level up', async () => {
  // /usr/local/Homebrew/Cellar/node/26.9.0/bin/node, with opt at /usr/local/opt/node.
  const root = await mkdtemp(join(tmpdir(), 'cas-brew-'));
  const repo = join(root, 'Homebrew');
  await installKeg(repo, 'node', '26.9.0');
  await mkdir(join(root, 'opt'), { recursive: true });
  await symlink('../Homebrew/Cellar/node/26.9.0', join(root, 'opt/node'));
  assert.equal(schedule.durableNodePath(join(repo, 'Cellar/node/26.9.0/bin/node')), join(root, 'opt/node/bin/node'));
});

test('a Cellar symlinked onto another volume is found through HOMEBREW_PREFIX', async () => {
  const volume = await mkdtemp(join(tmpdir(), 'cas-brew-volume-'));
  await installKeg(volume, 'node', '26.9.0');
  const prefix = await mkdtemp(join(tmpdir(), 'cas-brew-'));
  await symlink(join(volume, 'Cellar'), join(prefix, 'Cellar'));
  await mkdir(join(prefix, 'opt'));
  await symlink('../Cellar/node/26.9.0', join(prefix, 'opt/node'));
  // process.execPath is resolved, so it names the volume rather than the prefix.
  const keg = join(volume, 'Cellar/node/26.9.0/bin/node');
  const saved = process.env.HOMEBREW_PREFIX;
  try {
    delete process.env.HOMEBREW_PREFIX;
    assert.equal(schedule.durableNodePath(keg), keg, 'without the prefix there is nothing to find it by');
    process.env.HOMEBREW_PREFIX = prefix;
    assert.equal(schedule.durableNodePath(keg), join(prefix, 'opt/node/bin/node'));
  } finally {
    if (saved === undefined) delete process.env.HOMEBREW_PREFIX;
    else process.env.HOMEBREW_PREFIX = saved;
  }
});

test('with no Node given, the job gets the durable spelling of the Node running now', async () => {
  // The path every real install takes: nothing passes nodePath outside the tests.
  const home = await mkdtemp(join(tmpdir(), 'cas-brew-home-'));
  const described = await schedule.describe('19:00', { platform: 'darwin', home, run: async () => ({ code: 0, stdout: '', stderr: '' }) });
  assert.ok(described.command.startsWith(`"${schedule.durableNodePath(process.execPath)}"`), described.command);
});

test('a folder that merely happens to be called cellar is not fragile; fnm and XDG nvm are', async () => {
  process.env.CARE_ALBUM_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'cas-brew-config-'));
  assertIsolatedConfigDir();
  const run = async () => ({ code: 0, stdout: '', stderr: '' });
  const install = async (nodePath, cliPath = '/opt/tools/lib/care-album-saver/cli.js') => {
    const home = await mkdtemp(join(tmpdir(), 'cas-brew-home-'));
    await schedule.install('19:00', { platform: 'darwin', home, run, nodePath, cliPath, uid: 501 });
    return recordedFragile();
  };
  assert.equal(await install('/usr/bin/node', '/Users/cellar/Code/care-album-saver/dist/cli.js'), null);
  assert.equal(await install('/usr/bin/node', '/Users/alex/Code/Cellar/care-album-saver/dist/cli.js'), null);
  for (const fragile of [
    '/Users/alex/.local/share/fnm/node-versions/v22.11.0/installation/bin/node',
    '/Users/alex/Library/Application Support/fnm/node-versions/v22.11.0/installation/bin/node',
    '/Users/alex/.config/nvm/versions/node/v22.11.0/bin/node',
  ]) {
    assert.equal(await install(fragile), fragile, fragile);
  }
});

test('a job installed from a Node that will move says so when it has not run, in words', async () => {
  process.env.CARE_ALBUM_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'cas-brew-config-'));
  assertIsolatedConfigDir();
  const bare = await mkdtemp(join(tmpdir(), 'cas-brew-'));
  await installKeg(bare, 'node', '26.9.0');
  const home = await mkdtemp(join(tmpdir(), 'cas-brew-home-'));
  const env = {
    platform: 'darwin',
    home,
    run: async () => ({ code: 0, stdout: '', stderr: '' }),
    nodePath: join(bare, 'Cellar/node/26.9.0/bin/node'),
    cliPath: '/opt/tools/lib/care-album-saver/cli.js',
    uid: 501,
  };
  await schedule.install('19:00', env);
  // Installed three days ago, and never run since.
  const config = await loadConfig();
  config.schedule.installedAt = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
  await saveConfig(config);
  const status = await schedule.status(env);
  assert.equal(status.overdue, true);
  assert.match(status.summary, /the program it points at has moved, which happens when Node is upgraded/);
});

test('the daily run creates its log owner-only, and gets a minute to stop cleanly', async () => {
  process.env.CARE_ALBUM_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'cas-brew-config-'));
  assertIsolatedConfigDir();
  const home = await mkdtemp(join(tmpdir(), 'cas-brew-home-'));
  const run = async () => ({ code: 0, stdout: '', stderr: '' });
  const status = await schedule.install('19:00', { platform: 'darwin', home, run, nodePath: '/usr/bin/node', cliPath: '/opt/x/cli.js', uid: 501 });
  const plist = await readFile(status.location, 'utf8');
  assert.match(plist, /<key>Umask<\/key>\s*<integer>63<\/integer>/, 'umask 077, so launchd creates the log 0600');
  assert.match(plist, /<key>ExitTimeOut<\/key>\s*<integer>60<\/integer>/);
});

test('an existing world-readable log is made owner-only the next time a line is written', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX file modes do not exist on Windows');
  const dir = process.env.CARE_ALBUM_LOG_DIR;
  const file = schedule.logFile();
  await mkdir(dir, { recursive: true });
  await writeFile(file, 'written by launchd\n', { mode: 0o644 });
  await chmod(file, 0o644);
  await chmod(dir, 0o755);
  await schedule.appendLog('2026-09-23T19:00:00.000Z  START   scheduled run');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
});
