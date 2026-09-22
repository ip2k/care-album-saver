/**
 * Points the test run at a throwaway config directory, and proves it is pointed there.
 *
 * Tests start the real setup UI and the real config code paths. Without this, they read and
 * write the developer's ACTUAL config directory — on a Mac,
 * ~/Library/Application Support/brightwheel-archive — and the test suite overwrites a real
 * Brightwheel session with the mock's "test-session-value". That is not hypothetical: it
 * happened on 2026-09-21, and again on 2026-09-22 when a reviewer ran one file with
 * `node --test <file>`, which does not apply the --import in package.json.
 *
 * So this is not only preloaded by `pnpm test`: every test file that starts the UI or
 * touches config imports it FIRST, before the module under test, and calls
 * assertIsolatedConfigDir(). Importing twice is free — the preload and the import resolve
 * to the same module — and one file run on its own is then as safe as the whole suite.
 *
 * Tests may still override the variable themselves; the assignment below only fills it in
 * when unset.
 */
import { mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

if (!process.env.BRIGHTWHEEL_ARCHIVE_CONFIG_DIR) {
  process.env.BRIGHTWHEEL_ARCHIVE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'bw-test-config-'));
}

/**
 * Fail loudly rather than write a mock session over a real one.
 *
 * The import above cannot be the whole guard: it fills the variable in only when it is
 * unset, so a stray `BRIGHTWHEEL_ARCHIVE_CONFIG_DIR` already pointing at the real
 * directory would sail straight through it.
 */
export function assertIsolatedConfigDir() {
  const dir = process.env.BRIGHTWHEEL_ARCHIVE_CONFIG_DIR;
  if (!dir) {
    throw new Error('BRIGHTWHEEL_ARCHIVE_CONFIG_DIR is not set: import scripts/test-env.js before anything else.');
  }
  for (const real of [join(homedir(), 'Library'), join(homedir(), '.config'), join(homedir(), 'AppData')]) {
    if (dir === real || dir.startsWith(real + '/') || dir.startsWith(real + '\\')) {
      throw new Error(`BRIGHTWHEEL_ARCHIVE_CONFIG_DIR is ${dir}, which is a real config location.`);
    }
  }
  return dir;
}
