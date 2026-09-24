// First: the last test saves photos, and must not be able to reach a real config.
import { assertIsolatedConfigDir } from '../../../scripts/test-env.js';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatBytes } from '../dist/units.js';
import { BrightwheelClient, DEFAULT_CONFIG, Secret, startMockBrightwheel, sync } from '../dist/index.js';
import { auditArchive, humanBytes } from '../dist/maintenance.js';
import { summarise } from '../dist/gallery.js';

before(assertIsolatedConfigDir);

/**
 * Sizes, as each platform's own file manager writes them — so the number on the page is the
 * number a parent sees when they check in Finder, Files or Explorer.
 *
 *   macOS   Finder (NSByteCountFormatter): 1 MB = 1,000,000 bytes; KB whole, MB one decimal,
 *           GB two; no trailing zeros.
 *   Ubuntu  Files (GLib g_format_size): 1 MB = 1,000,000 bytes; always one decimal; "kB";
 *           the unit chosen from the byte count, so 999,999 bytes is "1000.0 kB".
 *   Windows Explorer (StrFormatByteSize): 1 MB = 1,048,576 bytes, still called MB; three
 *           significant figures, truncated.
 */
const CASES = [
  // bytes,          macOS,       Ubuntu,       Windows
  [0, '0 bytes', '0 bytes', '0 bytes'],
  [1, '1 byte', '1 byte', '1 byte'],
  [999, '999 bytes', '999 bytes', '999 bytes'],
  [1023, '1 KB', '1.0 kB', '1023 bytes'],
  [1500, '2 KB', '1.5 kB', '1.46 KB'],
  [12_345, '12 KB', '12.3 kB', '12.0 KB'],
  [999_999, '1 MB', '1000.0 kB', '976 KB'],
  [123_456_789, '123.5 MB', '123.5 MB', '117 MB'],
  [228_118_000, '228.1 MB', '228.1 MB', '217 MB'],
  [1_000_000_000, '1 GB', '1.0 GB', '953 MB'],
  [1_234_567_890, '1.23 GB', '1.2 GB', '1.14 GB'],
];

for (const [bytes, mac, ubuntu, windows] of CASES) {
  test(`${bytes} bytes is written as each file manager writes it`, () => {
    assert.equal(formatBytes(bytes, 'darwin'), mac, 'Finder');
    assert.equal(formatBytes(bytes, 'linux'), ubuntu, 'GNOME Files');
    assert.equal(formatBytes(bytes, 'win32'), windows, 'Windows Explorer');
  });
}

test('the same archive reads the same on every screen of one computer', () => {
  // The bug this replaced: 218 "MB" on the dashboard (bytes / 1,048,576) and 231 MB in the
  // folder check (bytes / 1,000,000), for one folder, on one Mac.
  const folder = 228_118_000;
  assert.equal(formatBytes(folder, 'darwin'), '228.1 MB');
  assert.notEqual(formatBytes(folder, 'darwin'), formatBytes(folder, 'win32'), 'Explorer really does say something else');
});

test('the dashboard and the folder check measure the same thing and write it the same way', async () => {
  const mock = await startMockBrightwheel({ activitiesPerStudent: 5 });
  const dir = await mkdtemp(join(tmpdir(), 'cas-units-'));
  try {
    const config = { ...DEFAULT_CONFIG, archiveDir: dir, delayMs: 0, incremental: false };
    const client = new BrightwheelClient({ session: new Secret('test-session-value'), baseUrl: `${mock.url}/api/v1`, delayMs: 0 });
    await sync(client, config, () => {}, { allowTemporaryDir: true });
    const audit = await auditArchive(config);
    const summary = await summarise(config);
    assert.ok(audit.bytesOnDisk > 0);
    assert.equal(summary.totalBytes, audit.bytesOnDisk, 'the whole folder, on both screens');
    assert.equal(summary.totalSize, humanBytes(audit.bytesOnDisk));
  } finally {
    await rm(dir, { recursive: true, force: true });
    await mock.close();
  }
});
