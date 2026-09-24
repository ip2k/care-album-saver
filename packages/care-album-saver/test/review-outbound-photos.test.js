// First, before anything that can read the config directory: the Photos list lives there.
import { assertIsolatedConfigDir } from '../../../scripts/test-env.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { parse as parsePath, join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  ApiShapeError,
  BrightwheelClient,
  DEFAULT_CONFIG,
  PHOTOS_FOLDER,
  PHOTOS_SCRIPT,
  Secret,
  addToPhotos,
  parseActivities,
  parseMe,
  parseStudents,
  photosStatus,
  startMockBrightwheel,
  sync,
} from '../dist/index.js';
import { BodyTooLargeError, readBodyText } from '../dist/http-body.js';
import { checkForUpdate } from '../dist/updates.js';
import { closeMetadata } from '../dist/metadata.js';

/**
 * The security review's remaining outbound and Photos WARNINGs
 * (docs/SECURITY-REVIEW-2026-09-23.md §4.2), a section each:
 *
 *  - outbound-7: an answer's size was capped, if at all, only after all of it was read.
 */

before(assertIsolatedConfigDir);
after(() => closeMetadata());

const SESSION = 'test-session-value';
const ROBIN = 'stu-aaa-111';
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const posixOnly = { skip: process.platform === 'win32' ? 'symbolic links, and names Windows does not allow' : false };

const configFor = (dir, extra = {}) => ({ ...DEFAULT_CONFIG, archiveDir: dir, incremental: false, delayMs: 0, includeStudents: [ROBIN], ...extra });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function freshConfigDir() {
  process.env.CARE_ALBUM_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'cas-outbound-'));
  delete process.env.CARE_ALBUM_SESSION;
  return assertIsolatedConfigDir();
}

/** A body that never ends, and how much of it was asked for. */
function endless(chunk = 64 * 1024) {
  const seen = { pulled: 0, cancelled: false };
  const stream = new ReadableStream({
    pull(controller) {
      seen.pulled += chunk;
      controller.enqueue(new Uint8Array(chunk).fill(0x20));
    },
    cancel() {
      seen.cancelled = true;
    },
  });
  return { stream, seen };
}

// ------------------------------------------------------------------ outbound-7

test('outbound-7: a body is read only up to its limit, and the rest is never asked for', async () => {
  const { stream, seen } = endless();
  await assert.rejects(readBodyText(new Response(stream), 1024 * 1024), BodyTooLargeError);
  assert.ok(seen.cancelled, 'the other end is told to stop sending');
  assert.ok(seen.pulled <= 1024 * 1024 + 3 * 64 * 1024, `read ${seen.pulled} bytes of an endless body`);
});

test('outbound-7: a body that says in advance it is too long is refused before it is read', async () => {
  const { stream, seen } = endless();
  const response = new Response(stream, { headers: { 'content-length': String(50 * 1024 * 1024) } });
  await assert.rejects(readBodyText(response, 1024 * 1024), BodyTooLargeError);
  assert.ok(seen.cancelled);
  assert.ok(seen.pulled <= 64 * 1024, 'at most the one chunk a stream fetches ahead of its reader');
});

test('outbound-7: under the limit the text is what text() gives — BOM dropped, characters whole across chunks', async () => {
  const bytes = new TextEncoder().encode('﻿{"name":"Zoë 🌱","note":"naïve"}');
  // One byte to a chunk, so every character of more than one byte straddles chunks.
  const trickle = new ReadableStream({
    start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    },
  });
  assert.equal(await readBodyText(new Response(trickle), 1024), await new Response(bytes).text());
  assert.equal(await readBodyText(new Response(null), 10), '', 'no body is an empty one');
  assert.equal(await readBodyText(new Response('exactly'), 7), 'exactly', 'the limit itself is allowed');
});

test('outbound-7: Brightwheel\'s client stops reading an answer past 16 MB, and does not ask again', async () => {
  let calls = 0;
  let tail;
  const client = new BrightwheelClient({
    session: new Secret(SESSION),
    delayMs: 0,
    fetchImpl: async () => {
      calls += 1;
      tail = endless();
      return new Response(tail.stream, { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  await assert.rejects(client.me(), (error) => {
    assert.ok(error instanceof ApiShapeError);
    assert.equal(error.name, 'ApiShapeError', 'so a run ends on it rather than moving on to the next photo');
    assert.match(error.message, /larger than 16 MB/);
    return true;
  });
  assert.equal(calls, 1, 'one request, not five: asking again brings the same answer');
  assert.ok(tail.seen.cancelled);
  assert.ok(tail.seen.pulled <= 16 * 1024 * 1024 + 3 * 64 * 1024, `read ${tail.seen.pulled} bytes`);
});

test('outbound-7: the update check reads no more than 1 MB of GitHub\'s answer, and says what it was', async () => {
  await freshConfigDir();
  const tail = endless();
  const now = Date.now();
  const huge = await checkForUpdate({ force: true, now: new Date(now), fetch: async () => new Response(tail.stream, { status: 200 }) });
  assert.equal(huge.latest, null);
  assert.match(huge.error, /not a release this tool recognises/);
  assert.ok(tail.seen.cancelled);
  assert.ok(tail.seen.pulled <= 1_000_000 + 3 * 64 * 1024, `read ${tail.seen.pulled} bytes`);

  // Not JSON at all is the same answer, not "GitHub could not be reached" — it plainly was.
  const garbled = await checkForUpdate({
    force: true,
    now: new Date(now + 2 * 60 * 1000),
    fetch: async () => new Response('<html>rate limited</html>', { status: 200 }),
  });
  assert.match(garbled.error, /not a release this tool recognises/);
});
