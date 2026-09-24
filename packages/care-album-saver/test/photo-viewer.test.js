// First, before anything that can read the config directory.
import { assertIsolatedConfigDir } from '../../../scripts/test-env.js';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, configPath, startWebUi, writeSecureFile } from '../dist/index.js';
import { GALLERY_PAGE_SIZE, summarise } from '../dist/gallery.js';
import { parseRange } from '../dist/web/server.js';
import { PAGE } from '../dist/web/page.js';

/**
 * The dashboard shows every photo the last run saved, twenty-four to a page, and opens each
 * in a viewer over the page — arrow keys and edge buttons to step, Escape, the close button
 * or a click on the dark area around the photo to close (2026-09-23).
 *
 * What a browser does with the viewer was driven in Chromium against the demo; what is
 * pinned here is everything the server decides: which files are "the last run", how they
 * are paged, and the byte ranges without which Safari will not play a video at all.
 */

before(assertIsolatedConfigDir);

const MINUTE = 60 * 1000;
const RUN_END = Date.parse('2026-09-23T17:40:00Z');

/**
 * An archive list with an older run and a long last one: thirty files five minutes apart,
 * so the last run spans 145 minutes — longer than the ninety-minute window that used to
 * decide which files were the last run, which would have cut off its first eleven.
 */
function manifest() {
  const files = [];
  for (let i = 0; i < 5; i++) {
    files.push({
      path: `Robin/2026-W38/old-${i}.jpg`,
      bytes: 10,
      sha256: '0'.repeat(64),
      downloadedAt: new Date(RUN_END - 24 * 60 * MINUTE - i * MINUTE).toISOString(),
      provenance: { postedAt: '2026-09-15T10:00:00Z', studentName: 'Robin Maple' },
    });
  }
  for (let i = 0; i < 30; i++) {
    files.push({
      path: `Sam/2026-W39/new-${String(i).padStart(2, '0')}.${i === 3 ? 'mp4' : 'jpg'}`,
      bytes: 10,
      sha256: '0'.repeat(64),
      downloadedAt: new Date(RUN_END - (29 - i) * 5 * MINUTE).toISOString(),
      provenance: { postedAt: '2026-09-22T10:00:00Z', studentName: 'Sam Maple', kind: i === 3 ? 'video' : 'image' },
    });
  }
  return { files };
}

async function archive() {
  const dir = await mkdtemp(join(tmpdir(), 'cas-viewer-'));
  await writeFile(join(dir, 'archive.json'), JSON.stringify(manifest()));
  return dir;
}

test('the last run is every file saved without a half-hour pause, however long it took', async () => {
  const dir = await archive();
  try {
    const s = await summarise({ ...DEFAULT_CONFIG, archiveDir: dir });
    assert.equal(s.lastRunCount, 30, 'all of the long run, and none of the day before');
    assert.equal(s.totalFiles, 35);
    assert.equal(s.lastSavedAt, new Date(RUN_END).toISOString());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the last run is paged twenty-four at a time, newest first, and a page out of range is clamped', async () => {
  const dir = await archive();
  const config = { ...DEFAULT_CONFIG, archiveDir: dir };
  try {
    assert.equal(GALLERY_PAGE_SIZE, 24);
    const first = await summarise(config);
    assert.equal(first.page, 0);
    assert.equal(first.pages, 2);
    assert.equal(first.pageSize, 24);
    assert.equal(first.recent.length, 24);
    assert.equal(first.recent[0].label, 'new-29.jpg', 'the newest first');

    const second = await summarise(config, { page: 1 });
    assert.equal(second.recent.length, 6);
    assert.deepEqual(second.recent.map((r) => r.label), ['new-05.jpg', 'new-04.jpg', 'new-03.mp4', 'new-02.jpg', 'new-01.jpg', 'new-00.jpg']);
    assert.equal(second.recent[2].kind, 'video');
    // The handle the page is given is the file's place in the archive list, which is what
    // /photo resolves — so it must be the manifest index, not the place in the run.
    assert.equal(second.recent[5].id, 5, 'new-00 is the sixth file in the list');

    assert.equal((await summarise(config, { page: 99 })).page, 1);
    assert.equal((await summarise(config, { page: -3 })).page, 0);
    assert.equal((await summarise(config, { page: Number('not a number') })).page, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an archive with nothing in it is one empty page, not zero pages', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cas-viewer-empty-'));
  try {
    const s = await summarise({ ...DEFAULT_CONFIG, archiveDir: dir });
    assert.deepEqual([s.lastRunCount, s.page, s.pages, s.recent.length], [0, 0, 1, 0]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('byte ranges: the single-range forms a video player sends, and nothing cleverer', () => {
  const size = 1000;
  assert.deepEqual(parseRange('bytes=0-99', size), { start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=0-', size), { start: 0, end: 999 }, 'Safari and Chrome both open with this');
  assert.deepEqual(parseRange('bytes=900-5000', size), { start: 900, end: 999 }, 'an end past the file is the file end');
  assert.deepEqual(parseRange('bytes=-100', size), { start: 900, end: 999 }, 'the last hundred');
  assert.deepEqual(parseRange('bytes=-5000', size), { start: 0, end: 999 });
  assert.equal(parseRange('bytes=1000-', size), 'unsatisfiable');
  assert.equal(parseRange('bytes=-0', size), 'unsatisfiable');
  // Everything else is answered with the whole file, which is always a correct answer.
  assert.equal(parseRange(undefined, size), null);
  assert.equal(parseRange('bytes=0-1,5-9', size), null, 'multiple ranges');
  assert.equal(parseRange('bytes=50-10', size), null, 'backwards');
  assert.equal(parseRange('bytes=-', size), null);
  assert.equal(parseRange('items=0-9', size), null);
});

test('over HTTP: the next page of the run, and a photo in parts, both behind the setup token', async () => {
  process.env.CARE_ALBUM_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'cas-viewer-cfg-'));
  assertIsolatedConfigDir();
  const dir = await archive();
  const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  await mkdir(join(dir, 'Sam', '2026-W39'), { recursive: true });
  await writeFile(join(dir, 'Sam', '2026-W39', 'new-03.mp4'), bytes);
  await writeSecureFile(configPath(), JSON.stringify({ ...DEFAULT_CONFIG, archiveDir: dir }));

  const handle = await startWebUi({});
  const base = `http://127.0.0.1:${handle.port}`;
  const get = (path, headers = {}) => fetch(base + path, { headers: { 'x-setup-token': handle.token, ...headers } });
  try {
    const page = await get('/api/gallery?page=1');
    assert.equal(page.status, 200);
    const body = await page.json();
    assert.deepEqual([body.page, body.pages, body.lastRunCount, body.recent.length], [1, 2, 30, 6]);
    assert.match(page.headers.get('content-security-policy'), /media-src 'self'/, 'the viewer may play the page\'s own videos');
    assert.match(page.headers.get('content-security-policy'), /default-src 'none'/, 'and nothing else is opened up');

    const refused = await fetch(`${base}/api/gallery?page=1`);
    assert.equal(refused.status, 403, 'no token, no photographs');

    const video = body.recent.find((r) => r.kind === 'video');
    const whole = await get(`/photo?i=${video.id}`);
    assert.equal(whole.status, 200);
    assert.equal(whole.headers.get('accept-ranges'), 'bytes');
    assert.equal(whole.headers.get('content-type'), 'video/mp4');
    assert.deepEqual(Buffer.from(await whole.arrayBuffer()), bytes);

    const part = await get(`/photo?i=${video.id}`, { range: 'bytes=16-31' });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), 'bytes 16-31/256');
    assert.equal(part.headers.get('content-length'), '16');
    assert.deepEqual(Buffer.from(await part.arrayBuffer()), bytes.subarray(16, 32));
    assert.match(part.headers.get('cache-control'), /no-store/, 'a part of a photograph is not cached either');

    const tail = await get(`/photo?i=${video.id}`, { range: 'bytes=-8' });
    assert.deepEqual(Buffer.from(await tail.arrayBuffer()), bytes.subarray(248));

    const past = await get(`/photo?i=${video.id}`, { range: 'bytes=999-' });
    assert.equal(past.status, 416);
    assert.equal(past.headers.get('content-range'), 'bytes */256');
  } finally {
    await handle.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('the page has the viewer: a dialog with close, previous and next, each named for a screen reader', () => {
  assert.match(PAGE, /<dialog id="viewer" class="viewer" aria-label="Photo viewer">/);
  assert.match(PAGE, /id="viewer-close"[^>]*aria-label="Close the photo"/);
  assert.match(PAGE, /id="viewer-prev"[^>]*aria-label="Previous photo"/);
  assert.match(PAGE, /id="viewer-next"[^>]*aria-label="Next photo"/);
  // The three ways out and the two ways along, as the page wires them.
  assert.match(PAGE, /e\.key !== 'ArrowLeft' && e\.key !== 'ArrowRight'/);
  assert.match(PAGE, /pressedOutside && outsideThePhoto\(e\.target\)\) closeDialog\('viewer'\)/);
  // Escape is the dialog's own: nothing may swallow its cancel event.
  assert.doesNotMatch(PAGE, /\$\('viewer'\)\.addEventListener\('cancel'/);
  // And a page of thumbnails is not a live region: twenty-four labels read out at once helps nobody.
  assert.match(PAGE, /<div class="gallery" id="gallery"><\/div>/);
});
