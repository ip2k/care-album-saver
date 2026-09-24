// First, before anything that can read the config directory: the Photos list lives there.
import { assertIsolatedConfigDir } from '../../../scripts/test-env.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, parse as parsePath, join, sep } from 'node:path';
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
  checkPhotosAccess,
  parseActivities,
  parseMe,
  parseStudents,
  photosStatus,
  startMockBrightwheel,
  sync,
  verify,
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
 *  - outbound-4: an empty post id collapsed every post into the first one.
 *  - processes-5, the rest: the Photos step trusted the list for what it handed over.
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

test('outbound-7: the verify command reads an endless answer only up to the limit, too', async () => {
  const { stream, seen } = endless();
  const fetchImpl = async () => new Response(stream, { headers: { 'content-type': 'application/json' } });
  await assert.rejects(
    () => verify(new Secret('test-session-value'), { baseUrl: 'http://127.0.0.1:9/api/v1', fetchImpl }),
    /larger than 16 MB, far more than it ever sends, so it was not read/,
  );
  assert.ok(seen.cancelled, 'the other end is told to stop sending');
  assert.ok(seen.pulled <= 16 * 1024 * 1024 + 3 * 64 * 1024, `read ${seen.pulled} bytes`);
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

// ------------------------------------------------------------------ outbound-4

/** One photo post, as the feed carries it, with whatever id fields `over` gives. */
const post = (url, over = {}) => ({ action_type: 'ac_photo', event_date: '2026-09-18T15:30:00Z', media: { image_url: url }, ...over });
const idsOf = (activities) => parseActivities({ activities }, 'stu-1').items.map((i) => i.id);

test('outbound-4: posts with an empty or unusable id are not all taken for the first one', () => {
  const ids = idsOf([
    post('https://cdn.example/p/a.jpg?Expires=1&Signature=x', { object_id: '' }),
    post('https://cdn.example/p/b.jpg?Expires=1&Signature=y', { object_id: '' }),
    post('https://cdn.example/p/c.jpg', { object_id: '   ' }),
    post('https://cdn.example/p/d.jpg', { object_id: {} }),
    post('https://cdn.example/p/e.jpg', { object_id: true }),
    post('https://cdn.example/p/f.jpg', { object_id: Number.NaN }),
    post('https://cdn.example/p/g.jpg'),
  ]);
  assert.equal(ids.length, 7, 'none refused: one bad post must not stop the page');
  assert.equal(new Set(ids).size, 7, 'and every one its own');
  for (const id of ids) assert.match(id, /^media-[0-9a-f]{32}$/);
});

test('outbound-4: an id made from the media is the same on every listing, whatever the signature says', () => {
  const [first] = idsOf([post('https://cdn.example/p/a.jpg?Expires=1&Signature=x&Key-Pair-Id=k', { object_id: '' })]);
  const [again] = idsOf([post('https://cdn.example/p/a.jpg?Expires=2&Signature=z&Key-Pair-Id=k', { object_id: '' })]);
  const [other] = idsOf([post('https://cdn.example/p/b.jpg?Expires=1&Signature=x&Key-Pair-Id=k', { object_id: '' })]);
  assert.equal(first, again, 'a fresh signature is the same photo');
  assert.notEqual(first, other, 'a different file is a different photo');
});

test('outbound-4: every id that worked before comes out exactly as before, so no archive fetches anything again', () => {
  const url = 'https://cdn.example/p/a.jpg';
  const cases = [
    [{ object_id: 'act-1' }, 'act-1'],
    [{ object_id: '3f2a9c1e-0b1d-4c6a-9e2f-7a1b2c3d4e5f' }, '3f2a9c1e-0b1d-4c6a-9e2f-7a1b2c3d4e5f'],
    [{ object_id: 12345 }, '12345'],
    [{ object_id: 0 }, '0'],
    [{ object_id: ' padded ' }, ' padded '],
    [{ id: 'x-9' }, 'x-9'],
    [{ object_id: 'act-1', id: 'x-9' }, 'act-1'],
    // Newly readable: a good `id` beside an empty `object_id`, which used to be "".
    [{ object_id: '', id: 'x-9' }, 'x-9'],
  ];
  for (const [fields, expected] of cases) assert.deepEqual(idsOf([post(url, fields)]), [expected], JSON.stringify(fields));
});

test('outbound-4: a child or an account with an unusable id is still refused, as a missing one was', () => {
  assert.throws(() => parseStudents({ students: [{ object_id: '', first_name: 'Robin' }] }), ApiShapeError);
  assert.throws(() => parseStudents({ students: [{ object_id: {}, first_name: 'Robin' }] }), ApiShapeError);
  assert.throws(() => parseMe({ object_id: '' }), ApiShapeError);
  assert.equal(parseStudents({ students: [{ object_id: 'stu-1' }] })[0].id, 'stu-1');
  assert.equal(parseStudents({ students: [{ id: 7 }] })[0].id, '7');
  assert.equal(parseMe({ object_id: 42 }).id, '42');
});

test('outbound-4: a feed whose posts all carry an empty id is saved whole, and the next run fetches none of it again', async () => {
  const mock = await startMockBrightwheel({ validSession: SESSION, activitiesPerStudent: 4 });
  const dir = await mkdtemp(join(tmpdir(), 'cas-empty-ids-'));
  try {
    const client = new BrightwheelClient({
      session: new Secret(SESSION),
      baseUrl: `${mock.url}/api/v1`,
      delayMs: 0,
      // The mock's feed with every post's id emptied, as the review found would collapse it.
      fetchImpl: async (url, init) => {
        const response = await fetch(url, init);
        if (!String(url).includes('/activities')) return response;
        const body = await response.json();
        for (const activity of body.activities) activity.object_id = '';
        return json(body, response.status);
      },
    });
    const first = await sync(client, configFor(dir), () => {}, { allowTemporaryDir: true });
    assert.equal(first.saved, 4, 'four posts, four photos — not one photo and three "already had"');
    assert.equal(first.skipped, 0);
    const again = await sync(client, configFor(dir), () => {}, { allowTemporaryDir: true });
    assert.equal(again.saved, 0, 'the same ids on the next listing, fresh signatures and all');
    assert.equal(again.skipped, 4);
  } finally {
    await mock.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ processes-5
//
// No test drives the real Photos app: every call goes to a stand-in that records what it
// was asked to run (as in photos.test.js), and test-env.js sets CARE_ALBUM_NO_PHOTOS besides.

/** A stand-in for execFile that says yes and remembers every call. */
function recorder() {
  const calls = [];
  const spawn = async (file, args) => {
    // Photos is handed private copies, gone once it has them, so each is read now: which
    // file of the archive it is (the album's folders and its own name) and what is in it.
    const at = args.indexOf('--');
    const copies = [];
    for (const copy of args.slice(at + 1)) {
      copies.push({ copy, rel: [...args.slice(2, at), basename(copy)].join('/'), sha256: sha256(await readFile(copy)) });
    }
    calls.push({ file, args: [...args], copies });
    return { code: 0, stdout: '', stderr: '' };
  };
  return { calls, spawn };
}

/** A recorded call as the script sees it: names before `--`, files after. */
function parts(call) {
  assert.equal(call.file, '/usr/bin/osascript');
  assert.equal(call.args[0], PHOTOS_SCRIPT);
  const rest = call.args.slice(1);
  const at = rest.indexOf('--');
  return { names: rest.slice(0, at), files: rest.slice(at + 1) };
}
/** What was handed over, as the archive's own paths for the files the copies were made of. */
const handedOver = (photos) => photos.calls.flatMap((c) => (parts(c), c.copies.map((copy) => copy.rel)));
/** Whether a handed-over file is the one the list calls `path`. */
const isRecord = (rel, path) => rel === path;

const manifestOf = async (dir) => JSON.parse(await readFile(join(dir, 'archive.json'), 'utf8'));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** The mock's photos saved into `dir`, and the config that turns Photos on for all of them. */
async function savedForPhotos(dir) {
  const mock = await startMockBrightwheel({ validSession: SESSION, activitiesPerStudent: 4 });
  try {
    const client = new BrightwheelClient({ session: new Secret(SESSION), baseUrl: `${mock.url}/api/v1`, delayMs: 0 });
    await sync(client, configFor(dir), () => {}, { allowTemporaryDir: true });
  } finally {
    await mock.close();
  }
  return configFor(dir, { addToPhotos: true, addToPhotosFrom: null });
}

test('processes-5: a file that is no longer the one saved is not handed to Photos, not recorded, and is reported', async () => {
  await freshConfigDir();
  const dir = await mkdtemp(join(tmpdir(), 'cas-photos-changed-'));
  try {
    const config = await savedForPhotos(dir);
    const { files } = await manifestOf(dir);
    assert.ok(files.length >= 2, 'something to add besides the changed one');
    const target = files[0];
    const onDisk = join(dir, ...target.path.split('/'));
    const original = await readFile(onDisk);
    await writeFile(onDisk, Buffer.concat([original, Buffer.from('changed by somebody else')]));

    const photos = recorder();
    const result = await addToPhotos(config, { platform: 'darwin', spawn: photos.spawn });
    const handed = handedOver(photos);
    assert.ok(!handed.some((f) => isRecord(f, target.path)), 'the changed file is not handed over');
    assert.equal(handed.length, files.length - 1, 'everything else is');
    assert.equal(result.ok, false, 'reported everywhere a failure is');
    assert.equal(result.reason, 'changed');
    assert.equal(result.changed, 1);
    assert.equal(result.added, files.length - 1);
    assert.ok(result.error.includes(target.path), 'names the file, so the parent can find it');
    assert.match(result.error, /not a file this tool saved on this Mac, or not as it saved it/);
    assert.match(result.error, new RegExp(`The other ${files.length - 1} were added`));

    const status = await photosStatus(config, { platform: 'darwin' });
    assert.equal(status.lastAttempt.ok, false, 'the page shows it beside the switch');
    assert.equal(status.lastAttempt.error, result.error);
    assert.equal(status.pending, 1, 'not written down as added: it is looked at again next time');

    // Still changed: said again, and Photos is not even asked.
    const again = recorder();
    const second = await addToPhotos(config, { platform: 'darwin', spawn: again.spawn });
    assert.equal(second.reason, 'changed');
    assert.equal(again.calls.length, 0);

    // Put back: it goes in like any other.
    await writeFile(onDisk, original);
    const restored = recorder();
    const third = await addToPhotos(config, { platform: 'darwin', spawn: restored.spawn });
    assert.equal(third.ok, true);
    assert.equal(third.added, 1);
    assert.ok(isRecord(handedOver(restored)[0], target.path));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('processes-5: a photo replaced together with its line in the list is still not handed over', async () => {
  // The list is in the photos folder, so anything that can replace a photo can make its line
  // agree. The reference is the record kept outside that folder (fingerprints.ts).
  await freshConfigDir();
  const dir = await mkdtemp(join(tmpdir(), 'cas-photos-both-'));
  try {
    const config = await savedForPhotos(dir);
    const manifest = await manifestOf(dir);
    const target = manifest.files[0];
    const replacement = Buffer.from('a picture of somebody else\'s choosing');
    await writeFile(join(dir, ...target.path.split('/')), replacement);
    manifest.files[0] = { ...target, sha256: sha256(replacement), bytes: replacement.length };
    await writeFile(join(dir, 'archive.json'), JSON.stringify(manifest));

    const photos = recorder();
    const result = await addToPhotos(config, { platform: 'darwin', spawn: photos.spawn });
    assert.ok(!photos.calls.some((c) => c.copies.some((copy) => copy.sha256 === sha256(replacement))), 'those bytes never reach Photos');
    assert.equal(result.reason, 'changed');
    assert.equal(result.changed, 1);
    assert.equal(result.added, manifest.files.length - 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('processes-5: an archive saved before the record began goes in whole, however its list was hashed', async () => {
  // Until 2026-09-22 sync hashed each file before writing its tags in, so an older list's
  // hashes describe bytes that no longer exist. Such an archive has no record in the config
  // folder either. Its photos are taken as they are, once, not reported as tampered with.
  await freshConfigDir();
  const dir = await mkdtemp(join(tmpdir(), 'cas-photos-legacy-'));
  try {
    const config = await savedForPhotos(dir);
    const manifest = await manifestOf(dir);
    manifest.files = manifest.files.map((f, i) => ({ ...f, sha256: sha256(Buffer.from(`before the tags went in ${i}`)) }));
    await writeFile(join(dir, 'archive.json'), JSON.stringify(manifest));
    await rm(join(process.env.CARE_ALBUM_CONFIG_DIR, 'fingerprints.json'));

    const photos = recorder();
    const result = await addToPhotos(config, { platform: 'darwin', spawn: photos.spawn });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.changed, 0);
    assert.equal(result.added, manifest.files.length);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('processes-5: a copy of the tool that is not talking to Apple\'s Photos says so, and nothing is recorded', async () => {
  await freshConfigDir();
  const dir = await mkdtemp(join(tmpdir(), 'cas-photos-impostor-'));
  try {
    const config = await savedForPhotos(dir);
    const refusal = {
      code: 1,
      stdout: '',
      stderr: "add-to-photos.applescript:3120:3260: execution error: This is not Apple's Photos app: the Photos this Mac would open is at /Users/alex/Applications/Photos.app. (3)\n",
    };
    const result = await addToPhotos(config, { platform: 'darwin', spawn: async () => refusal });
    assert.equal(result.ok, false);
    assert.equal(result.added, 0);
    assert.match(result.error, /Nothing was added to Photos: the Photos this Mac would open is at \/Users\/alex\/Applications\/Photos\.app\./);
    assert.match(result.error, /only to Apple's own Photos app, the one in \/System\/Applications/);
    const access = await checkPhotosAccess({ platform: 'darwin', spawn: async () => refusal });
    assert.equal(access.ok, false);
    assert.match(access.error, /\/Users\/alex\/Applications\/Photos\.app/);
    const status = await photosStatus(config, { platform: 'darwin' });
    assert.equal(status.pending, (await manifestOf(dir)).files.length, 'nothing written down as added');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('processes-5: the script talks only to Apple\'s Photos, by its identifier, after checking where it is', async () => {
  const script = await readFile(PHOTOS_SCRIPT, 'utf8');
  const code = script.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
  assert.ok(!/tell application "Photos"/.test(code), 'never by name, which any app can take');
  assert.equal((code.match(/tell application id "com\.apple\.Photos"/g) ?? []).length, 2, 'both places it talks to Photos');
  assert.match(code, /URLForApplicationWithBundleIdentifier:photosID/);
  assert.match(code, /runningApplicationsWithBundleIdentifier:photosID/);
  assert.match(code, /property photosPath : "\/System\/Applications\/Photos\.app"/);
  assert.ok(code.indexOf('checkItIsApplesPhotos()') < code.indexOf('tell application id'), 'checked before anything is asked of it');
});

test('processes-5: an album is named after the folder a file is really in, not the list\'s words for it', posixOnly, async () => {
  await freshConfigDir();
  const dir = await mkdtemp(join(tmpdir(), 'cas-photos-album-'));
  try {
    const config = await savedForPhotos(dir);
    const manifest = await manifestOf(dir);
    const [child] = manifest.files[0].path.split('/');
    // A link inside the archive to the child's folder, and an entry reaching a real photo
    // through it — first, so it is the one of the two entries for that photo considered.
    await symlink(join(dir, child), join(dir, 'Chosen By Someone Else'));
    const forged = { ...manifest.files[0], path: manifest.files[0].path.replace(child, 'Chosen By Someone Else') };
    manifest.files.unshift(forged);
    await writeFile(join(dir, 'archive.json'), JSON.stringify(manifest));

    const photos = recorder();
    const result = await addToPhotos(config, { platform: 'darwin', spawn: photos.spawn });
    assert.equal(result.ok, true);
    for (const call of photos.calls) {
      const { names } = parts(call);
      assert.equal(names[0], PHOTOS_FOLDER);
      assert.ok(!names.includes('Chosen By Someone Else'), `no album named by the list: ${names.join(' › ')}`);
    }
    assert.ok(handedOver(photos).some((f) => isRecord(f, manifest.files[1].path)), 'the photo still goes in, under its real album');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('processes-5: a file in a hidden folder is not one this tool saved, and is not handed over', async () => {
  await freshConfigDir();
  const dir = await mkdtemp(join(tmpdir(), 'cas-photos-hidden-'));
  try {
    const config = await savedForPhotos(dir);
    const manifest = await manifestOf(dir);
    // A photo of somebody else's choosing, with a list entry whose hash matches it exactly.
    const planted = Buffer.from('planted, with a matching entry');
    await mkdir(join(dir, '.saving-planted'));
    await writeFile(join(dir, '.saving-planted', 'x.jpg'), planted);
    manifest.files.push({ ...manifest.files[0], path: '.saving-planted/x.jpg', sha256: sha256(planted) });
    await writeFile(join(dir, 'archive.json'), JSON.stringify(manifest));

    const photos = recorder();
    const result = await addToPhotos(config, { platform: 'darwin', spawn: photos.spawn });
    assert.equal(result.ok, true);
    assert.ok(!handedOver(photos).some((f) => f.includes('.saving-planted')));
    assert.equal(result.added, manifest.files.length - 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('processes-5: a list entry of the wrong shape is passed over rather than taking the step down', async () => {
  await freshConfigDir();
  const dir = await mkdtemp(join(tmpdir(), 'cas-photos-shape-'));
  try {
    const config = await savedForPhotos(dir);
    const manifest = await manifestOf(dir);
    manifest.files.push(null, { ...manifest.files[0], sha256: 12345 }, { ...manifest.files[0], path: ['a'] });
    await writeFile(join(dir, 'archive.json'), JSON.stringify(manifest));
    const photos = recorder();
    const result = await addToPhotos(config, { platform: 'darwin', spawn: photos.spawn });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.added, manifest.files.length - 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('processes-5: a photos folder that looks cloud-synced is warned about where the switch is, and still works', async () => {
  await freshConfigDir();
  // Outside the temporary folder, which the folder check refuses before it would warn; the
  // repository's own cache, as photos.test.js uses.
  const base = join(REPO_ROOT, 'node_modules', '.cache', `cas-cloud-${Math.random().toString(16).slice(2, 10)}`);
  const dir = join(base, 'Dropbox', 'Care Album Photos');
  await mkdir(dir, { recursive: true });
  try {
    const config = await savedForPhotos(dir);
    const status = await photosStatus(config, { platform: 'darwin' });
    assert.match(status.warning ?? '', /synced to a cloud service/);
    assert.match(status.warning, /does not decide what goes into Photos/);
    assert.equal(status.problem, null, 'a warning, not a stop');

    const photos = recorder();
    const result = await addToPhotos(config, { platform: 'darwin', spawn: photos.spawn });
    assert.equal(result.ok, true, 'a setup that works keeps working');
    assert.equal(result.added, (await manifestOf(dir)).files.length);

    // Said before it is turned on too, when the choice is being made; never off a Mac.
    assert.match((await photosStatus({ ...config, addToPhotos: false }, { platform: 'darwin' })).warning ?? '', /cloud/);
    assert.equal((await photosStatus(config, { platform: 'linux' })).warning, null);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('processes-5: a folder that does not look synced carries no warning', async () => {
  await freshConfigDir();
  // A path that is neither temporary nor synced, and need not exist for the answer.
  const plain = join(parsePath(tmpdir()).root, `cas-nowhere-${Date.now()}`, 'Care Album Photos');
  const status = await photosStatus(configFor(plain, { addToPhotos: true }), { platform: 'darwin' });
  assert.equal(status.warning, null);
});
