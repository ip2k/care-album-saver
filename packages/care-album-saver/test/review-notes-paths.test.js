// First, before anything that can read the config directory.
import { assertIsolatedConfigDir } from '../../../scripts/test-env.js';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configPath, writeSecureFile } from '../dist/paths.js';

/**
 * The supply-docs review's F25 (docs/SECURITY-REVIEW-2026-09-23.md §4.6): the config folder is
 * narrowed to its owner, but never the home folder, and that guard compared spellings, so a
 * config folder that was a link to the home folder narrowed the home folder itself. The home
 * here is a stand-in in the temporary folder; the real one is never touched.
 */

before(assertIsolatedConfigDir);

const posixOnly = process.platform === 'win32' ? 'Windows has no POSIX modes' : false;
const mode = async (p) => (await stat(p)).mode & 0o7777;

async function withStandInHome(work) {
  const root = await mkdtemp(join(tmpdir(), 'cas-notes-paths-'));
  const saved = { HOME: process.env.HOME, CONFIG: process.env.CARE_ALBUM_CONFIG_DIR };
  try {
    process.env.HOME = join(root, 'home');
    await mkdir(process.env.HOME);
    await chmod(process.env.HOME, 0o755);
    return await work(root);
  } finally {
    process.env.HOME = saved.HOME;
    process.env.CARE_ALBUM_CONFIG_DIR = saved.CONFIG;
    await rm(root, { recursive: true, force: true });
  }
}

test('F25: a config folder that is a link to the home folder does not narrow the home folder', { skip: posixOnly }, async () => {
  await withStandInHome(async (root) => {
    process.env.CARE_ALBUM_CONFIG_DIR = join(root, 'cfg');
    await symlink(process.env.HOME, process.env.CARE_ALBUM_CONFIG_DIR);
    assertIsolatedConfigDir();
    await writeSecureFile(configPath(), '{}');
    assert.equal(await mode(process.env.HOME), 0o755, 'the home folder is left as it was');
  });
});

test('F25: an ordinary config folder is narrowed, through a link too, and keeps its sticky bit', { skip: posixOnly }, async () => {
  await withStandInHome(async (root) => {
    const real = join(root, 'real-cfg');
    await mkdir(real);
    await chmod(real, 0o1777);
    process.env.CARE_ALBUM_CONFIG_DIR = join(root, 'cfg');
    await symlink(real, process.env.CARE_ALBUM_CONFIG_DIR);
    assertIsolatedConfigDir();
    await writeSecureFile(configPath(), '{}');
    assert.equal(await mode(real), 0o1700, "the others' bits go; the owner's and the sticky bit stay");
  });
});
