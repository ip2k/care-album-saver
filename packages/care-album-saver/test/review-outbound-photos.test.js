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
import { MAX_RETRY_AFTER_SECONDS, retryAfterSeconds } from '../dist/api/client.js';
import { BodyTooLargeError, readBodyText } from '../dist/http-body.js';
import { checkForUpdate } from '../dist/updates.js';
import { closeMetadata } from '../dist/metadata.js';

/**
 * The security review's remaining outbound and Photos WARNINGs
 * (docs/SECURITY-REVIEW-2026-09-23.md §4.2), a section each:
 *
 *  - outbound-7: an answer's size was capped, if at all, only after all of it was read.
 *  - outbound-2: a Retry-After was obeyed however long it asked for.
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

// ------------------------------------------------------------------ outbound-2

test('outbound-2: Retry-After is read in both its forms, and nothing else is taken for one', () => {
  const now = Date.parse('2026-09-23T12:00:00Z');
  assert.equal(retryAfterSeconds('120', now), 120);
  assert.equal(retryAfterSeconds(' 0 ', now), 0);
  assert.equal(retryAfterSeconds('Wed, 23 Sep 2026 13:00:00 GMT', now), 3600);
  assert.equal(retryAfterSeconds('Wed, 23 Sep 2026 11:00:00 GMT', now), 0, 'a date already past asks for no wait');
  // `Number()` used to accept every one of these, "1e6" as eleven days.
  for (const junk of [null, '', '1.5', '-3', '1e6', '0x10', 'soon']) {
    assert.equal(retryAfterSeconds(junk, now), null, String(junk));
  }
  assert.equal(MAX_RETRY_AFTER_SECONDS, 5 * 60, 'a few minutes, not a day');
});

test('outbound-2: a Retry-After longer than a run waits ends it at once, says so, and asks nothing more', async () => {
  const cases = [
    ['86400', /wait 24 hours/],
    [new Date(Date.now() + 3 * 3600 * 1000).toUTCString(), /wait 3 hours/],
    // The review's example: the largest wait setTimeout can hold, 24.8 days.
    ['2147483', /wait 25 days/],
    [String(MAX_RETRY_AFTER_SECONDS + 1), /wait 6 minutes/],
  ];
  for (const [header, said] of cases) {
    let calls = 0;
    const client = new BrightwheelClient({
      session: new Secret(SESSION),
      delayMs: 0,
      fetchImpl: async () => {
        calls += 1;
        return new Response('slow down', { status: 429, headers: { 'retry-after': header } });
      },
    });
    const started = Date.now();
    await assert.rejects(client.me(), (error) => {
      assert.equal(error.name, 'ApiShapeError', 'so sync ends the run rather than moving on to the next photo');
      assert.match(error.message, said, header);
      assert.match(error.message, /next run/);
      return true;
    });
    assert.equal(calls, 1, `${header}: one request, and no retry into the wait it was asked to keep`);
    assert.ok(Date.now() - started < 5000, 'without sitting any of it out');
  }
});

test('outbound-2: a short Retry-After is still honoured, then the request goes through', async () => {
  const at = [];
  const client = new BrightwheelClient({
    session: new Secret(SESSION),
    delayMs: 0,
    fetchImpl: async () => {
      at.push(Date.now());
      return at.length === 1
        ? new Response('', { status: 503, headers: { 'retry-after': '1' } })
        : json({ object_id: 'usr-1' });
    },
  });
  assert.equal((await client.me()).id, 'usr-1');
  assert.equal(at.length, 2);
  assert.ok(at[1] - at[0] >= 1950, `the second second is the ordinary backoff (waited ${at[1] - at[0]} ms)`);
});

test('outbound-2: the run that is told to wait ends saying why, keeps what it saved, and the next one carries on', async () => {
  const mock = await startMockBrightwheel({ validSession: SESSION, activitiesPerStudent: 4, maxPageSize: 2 });
  const dir = await mkdtemp(join(tmpdir(), 'cas-retry-after-'));
  try {
    let refuse = true;
    const client = new BrightwheelClient({
      session: new Secret(SESSION),
      baseUrl: `${mock.url}/api/v1`,
      delayMs: 0,
      // The second page of the feed is refused for an hour; everything else is the mock.
      fetchImpl: async (url, init) =>
        refuse && String(url).includes('/activities') && /[?&]page=1(&|$)/.test(String(url))
          ? new Response('', { status: 429, headers: { 'retry-after': '3600' } })
          : fetch(url, init),
    });
    const events = [];
    await assert.rejects(sync(client, configFor(dir), (p) => events.push(p), { allowTemporaryDir: true }), /wait 60 minutes/);
    const last = events.at(-1);
    assert.equal(last.phase, 'error');
    assert.equal(last.saved, 2, 'the first page was saved before the refusal');
    assert.match(last.message, /next run/);

    refuse = false;
    const second = await sync(client, configFor(dir), () => {}, { allowTemporaryDir: true });
    assert.equal(second.skipped, 2, 'what the first run saved is not fetched again');
    assert.equal(second.saved, 2, 'and the rest of the feed is');
    assert.equal(second.failed, 0);
  } finally {
    await mock.close();
    await rm(dir, { recursive: true, force: true });
  }
});
