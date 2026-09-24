// First, like every test file: configDir() below must be the throwaway one.
import { assertIsolatedConfigDir } from '../../../scripts/test-env.js';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkArchiveDir, configDir } from '../dist/index.js';
import { safeStem, uniqueName } from '../dist/ferry/index.js';

/**
 * Where an archive may go, and what its folders are called — security review NOTEs fs-11,
 * fs-9 and the adversarial pass's `.app` (docs/SECURITY-REVIEW-2026-09-23.md §4.3, §4.4):
 *
 *  - fs-11: checkArchiveDir judged the path only as typed, so a link to a temporary or system
 *    folder passed, and it accepted the tool's own config folder — where the saved sign-in
 *    is — as an archive. It now judges where the path really is too, and refuses the config
 *    folder, anything inside it and anything holding it.
 *  - fs-9: Windows reserves CON.<anything>, not only CON, so "Con. Smith" made a folder
 *    Windows cannot create.
 *  - `.app`: a child called "Robin.app" made a folder macOS shows, and opens, as an app.
 */

before(assertIsolatedConfigDir);

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const posixOnly = process.platform === 'win32' ? 'symbolic links need a privilege on Windows' : false;

/** A folder outside the temp directory, which the rules would accept as it is. */
async function plainFolder() {
  const dir = join(REPO_ROOT, 'node_modules', '.cache', `cas-notes-paths-${process.pid}-${Math.random().toString(16).slice(2, 10)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------- fs-11: where it really is

test('fs-11: a link to a temporary folder is a temporary folder, and so is a folder not made yet beneath it', { skip: posixOnly }, async () => {
  const base = await plainFolder();
  const temp = await mkdtemp(join(tmpdir(), 'cas-notes-linked-temp-'));
  try {
    assert.equal(checkArchiveDir(join(base, 'Photos')).ok, true, 'the folder itself is acceptable');
    await symlink(temp, join(base, 'Photos'));
    for (const path of [join(base, 'Photos'), join(base, 'Photos', 'Kids', 'Robin')]) {
      const verdict = checkArchiveDir(path);
      assert.equal(verdict.ok, false, path);
      assert.match(verdict.error, /temporary folder/);
      assert.equal(verdict.resolved, path, 'the path is still reported as it was typed');
    }
  } finally {
    await rm(base, { recursive: true, force: true });
    await rm(temp, { recursive: true, force: true });
  }
});

test('fs-11: a link to a system folder, or to the whole home folder, is refused as what it points at', { skip: posixOnly }, async () => {
  const base = await plainFolder();
  try {
    await symlink('/etc', join(base, 'etc-link'));
    await symlink('/usr/share', join(base, 'usr-link'));
    await symlink(homedir(), join(base, 'home-link'));
    assert.match(checkArchiveDir(join(base, 'etc-link')).error ?? '', /belongs to your operating system/);
    assert.match(checkArchiveDir(join(base, 'usr-link', 'Photos')).error ?? '', /belongs to your operating system/);
    assert.match(checkArchiveDir(join(base, 'home-link')).error ?? '', /not your whole home folder/);
    // A link to an ordinary folder is as good as that folder.
    await mkdir(join(base, 'real'));
    await symlink(join(base, 'real'), join(base, 'fine-link'));
    assert.deepEqual(checkArchiveDir(join(base, 'fine-link')), { ok: true, resolved: join(base, 'fine-link') });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('fs-11: a link into a cloud-synced folder is warned about as that folder', { skip: posixOnly }, async () => {
  const base = await plainFolder();
  try {
    await mkdir(join(base, 'Dropbox', 'Kids'), { recursive: true });
    await symlink(join(base, 'Dropbox', 'Kids'), join(base, 'Photos'));
    const verdict = checkArchiveDir(join(base, 'Photos'));
    assert.equal(verdict.ok, true, 'allowed, as a cloud folder always is');
    assert.match(verdict.warning ?? '', /Dropbox/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('fs-11: the tool\'s own config folder is refused, and so is anything inside it or holding it', async () => {
  // The real rule, with this run's config folder (a throwaway one in the temp directory, so
  // the temporary-folder rule is set aside to reach it).
  const own = configDir();
  const opts = { allowTemporary: true };
  for (const path of [own, join(own, 'photos'), dirname(own)]) {
    const verdict = checkArchiveDir(path, opts);
    assert.equal(verdict.ok, false, path);
    assert.match(verdict.error, /keeps its settings and your saved sign-in/, path);
  }
  assert.equal(checkArchiveDir(join(dirname(own), 'cas-notes-a-sibling'), opts).ok, true, 'a folder beside it is fine');

  // Where it lives for a parent: ~/Library/Application Support/care-album-saver on a Mac.
  // Its parent was accepted as an archive before, and the check would then have listed the
  // saved sign-in as a photo missing from the list.
  const mac = join(homedir(), 'Library', 'Application Support', 'care-album-saver');
  for (const path of [mac, join(mac, 'x'), dirname(mac), join(homedir(), 'Library')]) {
    assert.equal(checkArchiveDir(path, { configDirs: [mac] }).ok, false, path);
  }
  assert.equal(checkArchiveDir(join(homedir(), 'Care Album Photos'), { configDirs: [mac] }).ok, true);
});

test('fs-11: a link to the config folder is refused too', { skip: posixOnly }, async () => {
  const base = await plainFolder();
  try {
    const own = join(base, 'config');
    await mkdir(own);
    await symlink(own, join(base, 'innocent'));
    assert.equal(checkArchiveDir(join(base, 'innocent'), { configDirs: [own] }).ok, false);
    assert.equal(checkArchiveDir(join(base, 'innocent', 'deeper'), { configDirs: [own] }).ok, false);
    assert.equal(checkArchiveDir(join(base, 'photos'), { configDirs: [own] }).ok, true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- fs-9: Windows reserved names

test('fs-9: a name Windows reserves before its first dot gets the same underscore as the bare name', () => {
  for (const [name, stem] of [
    ['Con. Smith', '_Con.-Smith'],
    ['CON.txt', '_CON.txt'],
    ['aux.photos.jpg', '_aux.photos.jpg'],
    ['Nul.', '_Nul'],
    ['com1.x', '_com1.x'],
    ['LPT9.anything', '_LPT9.anything'],
    ['COM0', '_COM0'],
    ['lpt0.x', '_lpt0.x'],
    ['CON', '_CON'],
    ['lpt1', '_lpt1'],
  ]) {
    assert.equal(safeStem(name), stem, name);
  }
  // Every name that was already safe comes out exactly as before.
  for (const [name, stem] of [
    ['Robin Maple', 'Robin-Maple'],
    ['Connor Smith', 'Connor-Smith'],
    ['Console', 'Console'],
    ['Aux-Lee', 'Aux-Lee'],
    ['Com. 10', 'Com.-10'],
    ['St. John', 'St.-John'],
    ['J.R. Maple', 'J.R.-Maple'],
    ['2026-09-22_101500_abc12345', '2026-09-22_101500_abc12345'],
  ]) {
    assert.equal(safeStem(name), stem, name);
  }
});

// ---------------------------------------------------------------- .app: macOS packages

test('.app: no folder or file stem ends in an extension that makes macOS show it as an app or package', () => {
  const packages = ['app', 'appex', 'bundle', 'framework', 'plugin', 'kext', 'pkg', 'mpkg', 'lproj', 'photoslibrary'];
  for (const ext of packages) {
    for (const spelling of [ext, ext.toUpperCase()]) {
      const stem = safeStem(`Robin.${spelling}`);
      assert.equal(stem, `Robin-${spelling}`, spelling);
      assert.doesNotMatch(stem, new RegExp(`\\.${ext}$`, 'i'));
    }
  }
  assert.equal(safeStem('Robin.app.'), 'Robin-app', 'a trailing dot stripped does not bring it back');
  assert.equal(safeStem('Sam.app.app'), 'Sam.app-app');
  assert.equal(safeStem('con.app'), '_con-app');
  assert.equal(uniqueName('Robin.app', 'jpg', new Set()), 'Robin-app.jpg');
  // Cut to length, a long name that then ends so is caught too.
  const long = safeStem(`${'a'.repeat(116)}.app and more after it`);
  assert.ok(long.length <= 120);
  assert.doesNotMatch(long, /\.app$/i);
  // A name that merely contains the letters, or ends in another extension, is unchanged.
  for (const name of ['Robin.Apple', 'Appleton', 'Sam.Pkgs', 'Robin App', 'Mary.Jo', 'Sam.Maple']) {
    assert.equal(safeStem(name), name.replace(/ /g, '-'), name);
  }
});
