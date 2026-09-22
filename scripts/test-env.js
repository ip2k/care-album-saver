/**
 * Preloaded into every test process by `pnpm test` (see the --import flag in package.json).
 *
 * Tests start the real setup UI and the real config code paths. Without this, they read and
 * write the developer's ACTUAL config directory — on a Mac,
 * ~/Library/Application Support/brightwheel-archive — and the test suite overwrites a real
 * Brightwheel session with the mock's "test-session-value". That is not hypothetical: it
 * happened on 2026-09-21. Pointing the whole process at a throwaway directory before any
 * test file loads makes the mistake impossible rather than merely unlikely.
 *
 * Tests may still override the variable themselves; this only fills it in when unset.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!process.env.BRIGHTWHEEL_ARCHIVE_CONFIG_DIR) {
  process.env.BRIGHTWHEEL_ARCHIVE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'bw-test-config-'));
}
