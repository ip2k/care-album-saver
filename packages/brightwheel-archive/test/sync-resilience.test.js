import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrightwheelClient, startMockBrightwheel, sync, Secret, DEFAULT_CONFIG } from '../dist/index.js';
import { signedUrlExpiry } from '../../media-ferry/dist/index.js';

/**
 * What an interrupted or expiring run must never do: lose a download it already made, skip
 * part of the feed on the next run, or keep hammering a session or a URL that is dead.
 *
 * Every mock here is per-test because the failure modes are stateful — a session that has
 * expired stays expired, and signatures age with the request counter.
 */

const SESSION = 'test-session-value';
const ROBIN = 'stu-aaa-111';

const clientFor = (mock) =>
  new BrightwheelClient({ session: new Secret(SESSION), baseUrl: `${mock.url}/api/v1`, delayMs: 0 });

// One child keeps the request sequences short enough to reason about by hand.
const configFor = (dir, extra = {}) =>
  ({ ...DEFAULT_CONFIG, archiveDir: dir, incremental: false, delayMs: 0, includeStudents: [ROBIN], ...extra });

const run = (mock, dir, extra = {}, onProgress = () => {}) =>
  sync(clientFor(mock), configFor(dir, extra), onProgress, { allowTemporaryDir: true });

const listings = (mock, page) =>
  mock.requests.filter(
    (r) => r.path.endsWith('/activities') && (page === undefined || new URLSearchParams(r.search).get('page') === String(page)),
  ).length;
const apiRequests = (mock) => mock.requests.filter((r) => !r.path.startsWith('/media/')).length;
const mediaRequests = (mock) => mock.requests.filter((r) => r.path.startsWith('/media/')).length;
const manifestOf = async (dir) => JSON.parse(await readFile(join(dir, 'archive.json'), 'utf8'));

// ---------------------------------------------------------------- session expiry

test('a session that expires mid-run ends the run cleanly and keeps what it saved', async () => {
  // Four API requests succeed — me, students, pages 0 and 1 — then page 2 gets the sign-in page.
  const mock = await startMockBrightwheel({ activitiesPerStudent: 23, maxPageSize: 10, expireSessionAfterRequests: 4 });
  try {
    const dir = await mkdtemp(join(tmpdir(), 'bw-expire-'));
    const progress = [];
    await assert.rejects(
      () => run(mock, dir, {}, (p) => progress.push(p)),
      (e) => e.name === 'SessionExpiredError',
    );

    // The progress stream says what happened, in words a parent can act on, with the counts intact.
    const last = progress.at(-1);
    assert.equal(last.phase, 'error');
    assert.match(last.message, /session has expired/i);
    assert.match(last.message, /sign in again/i);
    assert.equal(last.saved, 20);
    assert.equal(last.failed, 0);
    assert.match(last.message, /20 items saved before this are kept/);

    // Twenty is under the periodic save threshold of 25, so only the finally block could have
    // written these. Before it existed, this run lost all twenty and the next run re-downloaded them.
    assert.equal((await manifestOf(dir)).files.length, 20);

    // Exactly one request met the dead session; a dead session is never retried.
    assert.equal(apiRequests(mock), 5);
  } finally {
    await mock.close();
  }
});

test('the run after an interruption picks up everything the interrupted one missed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bw-resume-'));

  // Nightly runs are incremental. Page 0 is saved, then the session dies on page 1.
  const dying = await startMockBrightwheel({ activitiesPerStudent: 23, maxPageSize: 10, expireSessionAfterRequests: 3 });
  try {
    await assert.rejects(() => run(dying, dir, { incremental: true }));
  } finally {
    await dying.close();
  }
  assert.equal((await manifestOf(dir)).files.length, 10, 'page 0 was kept');

  const healthy = await startMockBrightwheel({ activitiesPerStudent: 23, maxPageSize: 10 });
  try {
    // "Stop at the newest thing we hold" would stop after page 1 here and never see page 2,
    // because the interrupted run left the newest posts and nothing older. The cut-off must
    // only come from a walk that finished.
    const second = await run(healthy, dir, { incremental: true });
    assert.equal(second.saved, 13, 'pages 1 and 2');
    assert.equal(second.skipped, 10, 'page 0, already held');
    assert.equal(listings(healthy), 4, 'pages 0 to 2 plus the empty page that ends the feed');

    // That walk finished, so the next incremental run may stop early — and does, once it
    // has looked PAGES_PAST_THE_CUT_OFF pages past the cut-off. It does not stop at the
    // first page that is entirely older, because the feed is ordered by upload time and a
    // batch of back-dated uploads sits above the posts it pre-dates; see
    // fix-correctness.test.js, "an incremental walk does not stop at a back-dated batch".
    // Here that means the walk reaches the end of this 23-post feed rather than stopping
    // after page 1, so everything is recognised rather than only the first twenty.
    const third = await run(healthy, dir, { incremental: true });
    assert.equal(third.saved, 0);
    assert.equal(third.skipped, 23);
    assert.equal(listings(healthy), 4 + 4, 'pages 0 to 2, then the empty page that ends the feed');
  } finally {
    await healthy.close();
  }
});

// ---------------------------------------------------------------- expired signed URLs

test('a signed URL that expired mid-page is refreshed from its listing page and retried', async () => {
  // Page 0's signatures die three requests after they were issued, so the fourth download
  // is refused. The page is fetched again, once, and its fresh signatures serve the rest.
  const mock = await startMockBrightwheel({ activitiesPerStudent: 6, mediaUrlExpiresAfterRequests: 3 });
  try {
    const dir = await mkdtemp(join(tmpdir(), 'bw-sig-'));
    const result = await run(mock, dir);
    assert.equal(result.failed, 0, result.warnings.join('; '));
    assert.equal(result.saved, 6);
    assert.equal(listings(mock, 0), 2, 'once for the walk, once for fresh signatures');
    assert.equal(mediaRequests(mock), 7, 'six downloads and the single refusal');

    // The manifest keys on the media id, so the fresh URL changes nothing about identity.
    const manifest = await manifestOf(dir);
    assert.equal(manifest.files.length, 6);
    assert.ok(manifest.files.every((f) => !f.transferId.includes('signature=')));
  } finally {
    await mock.close();
  }
});

test('a refusal that a fresh signature does not cure is reported, not hammered', async () => {
  // Every signature is dead on arrival. Each item gets one page re-fetch and one retry, and
  // the run still completes: failures are this run's honest count, not a crash.
  const mock = await startMockBrightwheel({ activitiesPerStudent: 3, mediaUrlExpiresAfterRequests: 0 });
  try {
    const dir = await mkdtemp(join(tmpdir(), 'bw-refused-'));
    const progress = [];
    const result = await run(mock, dir, {}, (p) => progress.push(p));
    assert.equal(result.saved, 0);
    assert.equal(result.failed, 3);
    assert.equal(progress.at(-1).phase, 'done');
    assert.match(result.warnings[0], /HTTP 403/);
    assert.ok(!result.warnings.join(' ').includes('signature='), 'a signed URL is a credential and must not reach a message');

    assert.equal(listings(mock, 0), 1 + 3, 'one re-fetch per item, never more');
    assert.equal(mediaRequests(mock), 6, 'two attempts per item, never more');

    // A walk with failures sets no cut-off, so the next incremental run really does retry them.
    const manifest = await manifestOf(dir);
    assert.equal(manifest.files.length, 0);
    assert.deepEqual(manifest.state.walkedThrough, {});
  } finally {
    await mock.close();
  }
});

test('a URL that says it has already expired is refreshed before it is ever requested', async () => {
  // The CDN honours expires= here, so a wasted attempt would show up as a refusal.
  const mock = await startMockBrightwheel({ activitiesPerStudent: 4, enforceMediaUrlExpiry: true });
  try {
    // What a run sees when it reaches page 0's items long after listing them: signatures
    // minted an hour ago. Only the walk is aged; the single-page re-fetch is the real thing.
    class StaleListing extends BrightwheelClient {
      async *activityPages(studentId, opts) {
        for await (const page of super.activityPages(studentId, opts)) {
          const anHourAgo = Date.now() - 3600_000;
          yield { ...page, items: page.items.map((i) => ({ ...i, url: i.url.replace(/expires=\d+/, `expires=${anHourAgo}`) })) };
        }
      }
    }
    const client = new StaleListing({ session: new Secret(SESSION), baseUrl: `${mock.url}/api/v1`, delayMs: 0 });
    const dir = await mkdtemp(join(tmpdir(), 'bw-stale-'));
    const result = await sync(client, configFor(dir), () => {}, { allowTemporaryDir: true });
    assert.equal(result.failed, 0, result.warnings.join('; '));
    assert.equal(result.saved, 4);
    assert.equal(listings(mock, 0), 2);
    assert.equal(mediaRequests(mock), 4, 'no request was spent on a URL known to be dead');
  } finally {
    await mock.close();
  }
});

test('signedUrlExpiry reads the expiry styles CDNs actually use, and nothing else', () => {
  const at = (url) => signedUrlExpiry(url)?.getTime();
  // CloudFront: seconds. The mock, and some CDNs: milliseconds.
  assert.equal(at('https://cdn.example/a.jpg?Expires=1700000000&Signature=x'), 1700000000 * 1000);
  assert.equal(at('https://cdn.example/a.jpg?expires=1700000000000'), 1700000000000);
  // S3 / GCS presigned: a lifetime counted from the signing date.
  assert.equal(
    signedUrlExpiry('https://cdn.example/a.jpg?X-Amz-Date=20260918T120000Z&X-Amz-Expires=900')?.toISOString(),
    '2026-09-18T12:15:00.000Z',
  );
  assert.equal(signedUrlExpiry('https://cdn.example/a.jpg?X-Amz-Expires=900'), null, 'a lifetime with no start is unreadable');
  assert.equal(signedUrlExpiry('https://cdn.example/a.jpg?expires=soon'), null);
  assert.equal(signedUrlExpiry('https://cdn.example/a.jpg'), null);
  assert.equal(signedUrlExpiry('not a url'), null);
});

// ---------------------------------------------------------------- honest progress

test('progress counts posts looked through against the feed, and never invents a total', async () => {
  const mock = await startMockBrightwheel({ activitiesPerStudent: 23, maxPageSize: 10 });
  try {
    const dir = await mkdtemp(join(tmpdir(), 'bw-progress-'));
    const progress = [];
    await run(mock, dir, {}, (p) => progress.push(p));

    // Brightwheel's count is posts of every kind, not photos, and the UI would turn a total
    // into a percentage. Undefined keeps its bar honest (indeterminate).
    assert.ok(progress.every((p) => p.total === undefined));

    // The page size the server actually used is read from the envelope, not assumed.
    const pages = progress.filter((p) => p.phase === 'listing' && p.examined !== undefined);
    assert.deepEqual(pages.map((p) => [p.examined, p.posts]), [[10, 23], [20, 23], [23, 23]]);
    assert.match(pages[0].message, /10 of 23/);
    const saving = progress.filter((p) => p.phase === 'downloading');
    assert.equal(saving.length, 23);
    assert.ok(saving.every((p) => p.posts === 23 && p.examined >= 10));
  } finally {
    await mock.close();
  }
});

test('a page of nothing but check-ins is not the end of the feed', async () => {
  // Ten check-ins fill page 0; the photos are on page 1. The walk used to stop at the first
  // page with no media on it, which here would have saved nothing and reported success.
  const mock = await startMockBrightwheel({ activitiesPerStudent: 5, maxPageSize: 10, leadingCheckIns: 10 });
  try {
    const dir = await mkdtemp(join(tmpdir(), 'bw-checkins-'));
    const progress = [];
    const first = await run(mock, dir, {}, (p) => progress.push(p));
    assert.equal(first.saved, 5);
    const pages = progress.filter((p) => p.phase === 'listing' && p.examined !== undefined);
    assert.deepEqual(pages.map((p) => [p.examined, p.posts]), [[10, 15], [15, 15]]);

    // Incrementally, a media-less page says nothing about age, so it must not stop the walk
    // either: the photos on page 1 are still found and recognised.
    const second = await run(mock, dir, { incremental: true });
    assert.equal(second.saved, 0);
    assert.equal(second.skipped, 5);
  } finally {
    await mock.close();
  }
});
