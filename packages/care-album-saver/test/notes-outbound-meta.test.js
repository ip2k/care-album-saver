// First, before anything that can read the config directory or the archive folder.
import { assertIsolatedConfigDir } from '../../../scripts/test-env.js';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ApiShapeError,
  BrightwheelClient,
  DEFAULT_BASE_URL,
  Secret,
  SessionExpiredError,
  parseActivities,
  parseMe,
  parseStudents,
  scrub,
  validateExtraction,
} from '../dist/index.js';
import { assertJsonResponse } from '../dist/api/schema.js';
import { download } from '../dist/ferry/index.js';
import { failureReason, retryAfterSeconds } from '../dist/api/client.js';
import { SIGNATURE_PARAMS, loopbackOrigin, mediaUrlRefusal, signedUrlExpiry } from '../dist/ferry/url.js';
import { compareVersions, parseRelease } from '../dist/updates.js';

/**
 * The security review's NOTE-level findings for the outbound requests, the API parser and
 * the update check (docs/SECURITY-REVIEW-2026-09-23.md §4.3 and §4.4), a section each:
 *
 *  - outbound-8: scrub() and the URL module disagreed about which parameters are signatures,
 *    and an unparseable media address reached error text whole.
 *  - outbound-9: every 4xx was asked again four times.
 *  - outbound-11: a failure to connect said only "fetch failed".
 *  - outbound-12: an oversized expiry was an Invalid Date; pre-releases compared as text.
 *  - media URL anywhere: the API could point downloads at any address the computer reaches.
 *  - sign-in heuristic: any non-JSON page mentioning "log in" read as an expired session.
 *  - processes-8: names kept their control characters.
 *  - page-5, page-6: the release link and its date.
 *  - Retry-After: V8's lenient dates, and a number too long to say.
 */

before(assertIsolatedConfigDir);

const SESSION = 'test-session-value';
const ROBIN = 'stu-aaa-111';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const post = (url, extra = {}) => ({ object_id: `act-${Math.random().toString(36).slice(2, 8)}`, event_date: '2026-09-18T09:00:00Z', media: { image_url: url }, ...extra });

/** A body that records whether it was let go. */
function trackedBody(text = 'x') {
  const seen = { cancelled: false };
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      // Ends by itself a little later, so code that reads the body instead of letting it go
      // finishes, and the `cancelled` assertion fails, rather than the test hanging until CI's
      // six-hour limit (§4.6, F17). Letting it go first still counts as cancelled.
      setTimeout(() => { try { controller.close(); } catch {} }, 200).unref();
    },
    cancel() {
      seen.cancelled = true;
    },
  });
  return { body, seen };
}

async function listen(handler, host = '127.0.0.1') {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, host, resolve));
  return { server, port: server.address().port, close: () => new Promise((r) => server.close(() => r())) };
}

// ------------------------------------------------------------------ outbound-8

test('outbound-8: scrub() redacts every signature parameter the URL module knows, and nothing it keeps', () => {
  assert.ok(SIGNATURE_PARAMS.size >= 22, 'the one list, shared');
  for (const name of SIGNATURE_PARAMS) {
    for (const spelled of [name, name.toUpperCase()]) {
      const text = `HTTP 500 for https://cdn.example/a.jpg?keep=1&${spelled}=SECRETVALUE123&size=large`;
      const out = scrub(text);
      assert.ok(!out.includes('SECRETVALUE123'), `${spelled} is redacted: ${out}`);
      assert.match(out, /keep=1/, `${spelled}: an ordinary parameter is left alone`);
      assert.match(out, /size=large/, `${spelled}: and so is the one after it`);
    }
  }
  // The ones the old private list of seven missed, spelled as the CDNs spell them.
  const amz = scrub('?X-Amz-Signature=abc123&X-Amz-Credential=AKIA%2Fx&X-Goog-Signature=def456');
  assert.ok(!/abc123|AKIA|def456/.test(amz), amz);
});

test('outbound-8: an unparseable media address is refused before fetch can quote it', async () => {
  const signature = 'SIGNATUREVALUE987';
  await assert.rejects(
    download({ url: `ht tp://cdn example/a.jpg?Signature=${signature}`, destination: join(await mkdtemp(join(tmpdir(), 'cas-nom8-')), 'a.jpg') }),
    (error) => {
      assert.equal(error.name, 'DownloadError');
      assert.ok(!error.message.includes(signature), error.message);
      assert.ok(!/Failed to parse URL/.test(error.message), 'not undici\'s wording, which quotes the address');
      return true;
    },
  );
});

// ------------------------------------------------------------------ outbound-9

test('outbound-9: a 4xx other than 429 is asked once, its body let go, and the run told why', { timeout: 30_000 }, async () => {
  for (const status of [400, 404, 407, 410]) {
    let calls = 0;
    const tracked = trackedBody('<html>Please log in to the proxy</html>');
    const client = new BrightwheelClient({
      session: new Secret(SESSION),
      delayMs: 0,
      fetchImpl: async () => {
        calls += 1;
        return new Response(tracked.body, { status, headers: { 'content-type': 'text/html' } });
      },
    });
    const started = Date.now();
    await assert.rejects(client.me(), (error) => {
      assert.equal(error.name, 'ApiShapeError', `${status}: ends the run, as a changed API does`);
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      assert.match(error.message, /text\/html/, 'with what the body said it was');
      return true;
    });
    assert.equal(calls, 1, `${status}: one request, not five`);
    assert.ok(Date.now() - started < 900, `${status}: and no backoff sat through`);
    assert.equal(tracked.seen.cancelled, true, `${status}: the unread body was let go`);
  }
});

test('outbound-9: 401 and 403 still mean the session, and 5xx is still retried with its body let go', { timeout: 30_000 }, async () => {
  for (const status of [401, 403]) {
    const client = new BrightwheelClient({ session: new Secret(SESSION), delayMs: 0, fetchImpl: async () => json({}, status) });
    await assert.rejects(client.me(), (e) => e.name === 'SessionExpiredError');
  }
  let calls = 0;
  const first = trackedBody('busy');
  const client = new BrightwheelClient({
    session: new Secret(SESSION),
    delayMs: 0,
    fetchImpl: async () => {
      calls += 1;
      return calls === 1 ? new Response(first.body, { status: 503 }) : json({ object_id: 'g-1', email: null });
    },
  });
  assert.deepEqual(await client.me(), { id: 'g-1', email: null });
  assert.equal(calls, 2, 'a 503 is asked again');
  assert.equal(first.seen.cancelled, true, 'and the refusal\'s body was let go first');
});

// ------------------------------------------------------------------ outbound-11

test('outbound-11: a failure to connect says what failed, not only "fetch failed"', async () => {
  // A real one: a port that was just closed, on this computer, so no network is touched.
  const { port, close } = await listen((req, res) => res.end());
  await close();
  const real = await fetch(`http://127.0.0.1:${port}/`).then(() => null, (e) => e);
  assert.equal(real?.message, 'fetch failed', 'the premise: undici says only this');
  assert.match(failureReason(real), /^fetch failed \(.*ECONNREFUSED/);

  const notFound = new TypeError('fetch failed', {
    cause: Object.assign(new Error('getaddrinfo ENOTFOUND schools.example.invalid'), { code: 'ENOTFOUND' }),
  });
  assert.equal(failureReason(notFound), 'fetch failed (getaddrinfo ENOTFOUND schools.example.invalid)');

  // Both address families refused: an AggregateError with no message of its own.
  const both = new TypeError('fetch failed', {
    cause: Object.assign(new AggregateError([new Error('connect ECONNREFUSED 127.0.0.1:1'), new Error('connect ECONNREFUSED ::1:1')], ''), { code: 'ECONNREFUSED' }),
  });
  assert.equal(failureReason(both), 'fetch failed (connect ECONNREFUSED 127.0.0.1:1)');

  const codeOnly = new TypeError('fetch failed', { cause: Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) });
  assert.equal(failureReason(codeOnly), 'fetch failed (UND_ERR_CONNECT_TIMEOUT: Connect Timeout Error)');

  // Scrubbed, whatever the cause says.
  const leaky = new Error('failed', { cause: new Error('sent Cookie: _brightwheel_v2=abcdef123') });
  assert.ok(!failureReason(leaky).includes('abcdef123'));
  assert.equal(failureReason(new Error('plain')), 'plain');
});

// ------------------------------------------------------------------ outbound-12

test('outbound-12: an expiry too large to be a date is unreadable, not an Invalid Date', () => {
  for (const url of [
    `https://cdn.example/a.jpg?Expires=${'9'.repeat(30)}`,
    `https://cdn.example/a.jpg?expires=${'9'.repeat(400)}`,
    `https://cdn.example/a.jpg?X-Amz-Date=20260918T120000Z&X-Amz-Expires=${'9'.repeat(40)}`,
  ]) {
    assert.equal(signedUrlExpiry(url), null, url.slice(0, 60));
  }
  // Still read where it is a date.
  assert.equal(signedUrlExpiry('https://cdn.example/a.jpg?Expires=1790000000')?.getTime(), 1790000000 * 1000);
});

test('outbound-12: pre-releases compare field by field, as semver §11 says', () => {
  // The specification's own example, in order.
  const ordered = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0'];
  for (let i = 0; i < ordered.length; i++) {
    for (let j = 0; j < ordered.length; j++) {
      assert.equal(Math.sign(compareVersions(ordered[i], ordered[j])), Math.sign(i - j), `${ordered[i]} vs ${ordered[j]}`);
    }
  }
  assert.ok(compareVersions('0.2.0-rc.10', '0.2.0-rc.9') > 0, 'not "rc.10" before "rc.9" as text would have it');
  assert.equal(compareVersions('1.0.0+build.5', '1.0.0'), 0, 'build metadata takes no part');
  assert.ok(compareVersions('1.0.0-rc.99999999999999999999', '1.0.0-rc.99999999999999999998') > 0, 'numbers of any length');
});

// ------------------------------------------------------------------ media URL anywhere

test('media URL anywhere: only a public https address is fetched from', () => {
  const allowed = [
    'https://cdn.example/media/a.jpg?Expires=1&Signature=x',
    'https://d1abc.cloudfront.net/a.jpg',
    'https://8.8.8.8/a.jpg',
    'https://172.32.0.1/a.jpg',
    'https://[2606:4700::1111]/a.jpg',
    'https://example.invalid/a.jpg',
  ];
  for (const url of allowed) assert.equal(mediaUrlRefusal(url), null, url);

  const refused = {
    'not https': ['http://cdn.example/a.jpg', 'ftp://cdn.example/a.jpg', 'file:///etc/passwd', 'data:image/jpeg;base64,AAAA'],
    unreadable: ['', 'not a url', 'https://'],
    credentials: ['https://user:pw@cdn.example/a.jpg'],
    local: [
      'https://127.0.0.1/a.jpg',
      'https://0x7f.1/a.jpg',
      'https://2130706433/a.jpg',
      'https://0.0.0.0/a.jpg',
      'https://10.1.2.3/a.jpg',
      'https://100.64.0.1/a.jpg',
      'https://169.254.169.254/latest/meta-data/',
      'https://172.16.0.1/a.jpg',
      'https://172.31.255.255/a.jpg',
      'https://192.168.1.1/a.jpg',
      'https://224.0.0.1/a.jpg',
      'https://255.255.255.255/a.jpg',
      'https://[::1]/a.jpg',
      'https://[::]/a.jpg',
      'https://[::ffff:127.0.0.1]/a.jpg',
      'https://[::ffff:192.168.1.1]/a.jpg',
      'https://[64:ff9b::10.0.0.1]/a.jpg',
      'https://[2002:c0a8:101::1]/a.jpg',
      'https://[fe80::1]/a.jpg',
      'https://[fc00::1]/a.jpg',
      'https://[fd12:3456::1]/a.jpg',
      'https://[ff02::1]/a.jpg',
      'https://localhost/a.jpg',
      'https://LOCALHOST./a.jpg',
      'https://photos.localhost/a.jpg',
      'https://router/a.jpg',
      'https://nas.local/a.jpg',
      'https://printer.home.arpa/a.jpg',
      'https://plane.lan/a.jpg',
      'https://metadata.internal/a.jpg',
    ],
  };
  for (const [why, urls] of Object.entries(refused)) {
    for (const url of urls) assert.ok(mediaUrlRefusal(url), `${why}: ${url}`);
  }
  assert.match(mediaUrlRefusal('http://cdn.example/a.jpg'), /not an https address/);
  assert.match(mediaUrlRefusal('https://192.168.1.1/a.jpg'), /this computer or the local network/);
});

test('media URL anywhere: the one exception is the API\'s own origin, and only when that is this computer', () => {
  assert.equal(loopbackOrigin(DEFAULT_BASE_URL), null, 'never for Brightwheel\'s own address');
  assert.equal(loopbackOrigin('https://schools.example/api/v1'), null);
  assert.equal(loopbackOrigin('http://192.168.1.25:8080/api/v1'), null, 'the local network is not this computer');
  assert.equal(loopbackOrigin('http://127.0.0.1:4321/api/v1'), 'http://127.0.0.1:4321');
  assert.equal(loopbackOrigin('http://localhost:4321/api/v1'), 'http://localhost:4321');
  assert.equal(loopbackOrigin('http://[::1]:4321/api/v1'), 'http://[::1]:4321');

  const trusted = 'http://127.0.0.1:4321';
  assert.equal(mediaUrlRefusal('http://127.0.0.1:4321/media/a.jpg?signature=1', trusted), null);
  assert.ok(mediaUrlRefusal('http://127.0.0.1:4322/media/a.jpg', trusted), 'another port is another origin');
  assert.ok(mediaUrlRefusal('http://192.168.1.1/a.jpg', trusted), 'and the local network is still refused');
});

test('media URL anywhere: a refused address is counted and stops the page, like an undated post', async () => {
  const page = {
    activities: [
      post('https://cdn.example/a.jpg'),
      post('http://192.168.1.1/admin.jpg'),
      post('https://169.254.169.254/latest/meta-data/iam'),
      { object_id: 'checkin', event_date: '2026-09-18T09:00:00Z' },
    ],
  };
  const parsed = parseActivities(page, ROBIN);
  assert.deepEqual(parsed.items.map((i) => i.url), ['https://cdn.example/a.jpg'], 'the refused are not items');
  assert.equal(parsed.refused, 2);
  assert.equal(parsed.refusedBecause, 'it is not an https address');
  assert.equal(parsed.undated, 0);

  const check = validateExtraction(parsed.items, 3, parsed.undated, parsed.refused, parsed.refusedBecause);
  assert.equal(check.status, 'suspicious', 'not "ok": two photos would be missing with nothing said');
  assert.match(check.message, /2 posts on page 3/);
  assert.match(check.message, /because it is not an https address/);
  assert.ok(!check.message.includes('192.168.1.1/admin'), 'the address itself is not quoted');

  // Through the client, as a run meets it.
  let calls = 0;
  const client = new BrightwheelClient({
    session: new Secret(SESSION),
    delayMs: 0,
    fetchImpl: async () => {
      calls += 1;
      return json(page);
    },
  });
  await assert.rejects(client.activitiesPage(ROBIN, 0), (error) => {
    assert.ok(error instanceof ApiShapeError);
    assert.match(error.message, /does not fetch from/);
    return true;
  });
  assert.equal(calls, 1);
});

test('media URL anywhere: a client pointed at this computer accepts media from that server and no other', async () => {
  const base = 'http://127.0.0.1:4321/api/v1';
  const client = new BrightwheelClient({
    session: new Secret(SESSION),
    baseUrl: base,
    delayMs: 0,
    fetchImpl: async () => json({ activities: [post('http://127.0.0.1:4321/media/a.jpg?signature=1')] }),
  });
  const ok = await client.activitiesPage(ROBIN, 0);
  assert.equal(ok.items.length, 1, 'the mock and the demo keep working');

  const elsewhere = new BrightwheelClient({
    session: new Secret(SESSION),
    baseUrl: base,
    delayMs: 0,
    fetchImpl: async () => json({ activities: [post('http://127.0.0.1:9999/secret.jpg')] }),
  });
  await assert.rejects(elsewhere.activitiesPage(ROBIN, 0), /does not fetch from/);

  const production = new BrightwheelClient({
    session: new Secret(SESSION),
    delayMs: 0,
    fetchImpl: async () => json({ activities: [post('http://127.0.0.1:4321/media/a.jpg')] }),
  });
  await assert.rejects(production.activitiesPage(ROBIN, 0), /does not fetch from/, 'the default address trusts no local origin');
});

test('media URL anywhere: a redirect may stay where it was, but not leave for this computer or the network', async () => {
  const hits = [];
  const target = await listen((req, res) => {
    hits.push(req.url);
    res.end('SHOULD-NOT-BE-FETCHED');
  });
  const origin = await listen((req, res) => {
    if (req.url === '/same') res.writeHead(302, { location: '/photo.jpg' }).end();
    else if (req.url === '/away') res.writeHead(302, { location: `http://localhost:${target.port}/p.jpg?Signature=SIGVALUE` }).end();
    else if (req.url === '/nowhere') res.writeHead(307).end();
    else if (req.url === '/loop') res.writeHead(301, { location: '/loop' }).end();
    else res.end('PHOTO-BYTES');
  });
  const dir = await mkdtemp(join(tmpdir(), 'cas-nom-redirect-'));
  const at = (path) => `http://127.0.0.1:${origin.port}${path}`;
  try {
    const same = await download({ url: at('/same'), destination: join(dir, 'same.jpg') });
    assert.equal(same.bytes, 'PHOTO-BYTES'.length, 'a redirect on the same origin is followed as before');

    await assert.rejects(download({ url: at('/away'), destination: join(dir, 'away.jpg') }), (error) => {
      assert.equal(error.name, 'DownloadError');
      assert.match(error.message, /redirected to an address this tool does not fetch from/);
      assert.match(error.message, /not an https address/);
      assert.ok(!error.message.includes('SIGVALUE'), 'the signature is not quoted');
      assert.notEqual(error.status, 404, 'not written off as gone: the next run tries again');
      return true;
    });
    assert.deepEqual(hits, [], 'nothing was asked of the address it was sent to');

    await assert.rejects(download({ url: at('/nowhere'), destination: join(dir, 'nowhere.jpg') }), /led nowhere/);
    await assert.rejects(download({ url: at('/loop'), destination: join(dir, 'loop.jpg') }), /redirected more than 20 times/);
    const left = (await readdir(dir)).sort();
    assert.deepEqual(left, ['same.jpg'], 'nothing half-written is left behind');
  } finally {
    await origin.close();
    await target.close();
  }
});

// ------------------------------------------------------------------ sign-in heuristic

test('sign-in heuristic: only a successful answer is read as a sign-in page', () => {
  const page = '<html><body>Please log in. Password:</body></html>';
  const html = (status, type = 'text/html; charset=utf-8') => new Response(page, { status, headers: { 'content-type': type } });

  assert.throws(() => assertJsonResponse(html(200), page, 'users/me'), SessionExpiredError, 'Brightwheel\'s own sign-in page still is');
  for (const status of [404, 407, 451, 502, 511]) {
    assert.throws(
      () => assertJsonResponse(html(status), page, 'users/me'),
      (error) => {
        assert.equal(error.name, 'ApiShapeError', `${status} is not an expired session`);
        assert.match(error.message, new RegExp(`HTTP ${status} from users/me`));
        assert.match(error.message, /text\/html; charset=utf-8/, 'with the content type');
        return true;
      },
    );
  }
  assert.throws(() => assertJsonResponse(html(401), page, 'x'), SessionExpiredError);
  // A content type is the server's to fill: it is shown short and printable.
  const odd = new Response('', { status: 500, headers: { 'content-type': `text/${'x'.repeat(500)}` } });
  assert.throws(() => assertJsonResponse(odd, '', 'x'), (e) => e.message.length < 200);
});

// ------------------------------------------------------------------ processes-8

test('processes-8: every name and note from Brightwheel arrives without control characters', () => {
  const [kid] = parseStudents({
    students: [{ student: { object_id: 's1', first_name: 'Ro\u0000b\u001bin\u0085', last_name: 'Ma\nple\r', school: { name: 'Example\u0007 Care\tProvider' } } }],
  });
  assert.equal(kid.firstName, 'Robin');
  // Without its ESC, a terminal sequence is inert text.
  assert.equal(parseStudents({ students: [{ object_id: 's0', first_name: '\u001b[2JSam' }] })[0].firstName, '[2JSam');
  assert.equal(kid.lastName, 'Ma ple ', 'a line break in a one-line field becomes a space');
  assert.equal(kid.fullName, 'Robin Ma ple ');
  assert.equal(kid.schoolName, 'Example Care Provider');

  // Composed, so one name is one string whichever keyboard typed it.
  const [composed] = parseStudents({ students: [{ object_id: 's2', first_name: 'José', last_name: 'Maple' }] });
  assert.equal(composed.firstName, 'José');

  // Nothing left but controls is no name, as an empty one never was.
  const [blank] = parseStudents({ students: [{ object_id: 's3', first_name: '\u0000\u0001', last_name: '' }] });
  assert.equal(blank.fullName, 'Student 1');

  assert.equal(parseMe({ object_id: 'g', email: 'parent@example.invalid\u001b[0m' }).email, 'parent@example.invalid[0m');

  const url = 'https://cdn.example/a.jpg?Expires=1&Signature=a%2Bb~c';
  const { items } = parseActivities(
    {
      activities: [
        post(url, {
          note: 'Nap time.\nThen\tpainting.\u0000\u009b',
          actor: { first_name: 'Ms.\u0008', last_name: 'Alva\u001frez' },
        }),
      ],
    },
    ROBIN,
  );
  assert.equal(items[0].note, 'Nap time.\nThen\tpainting.', 'a note keeps its lines and tabs, and nothing else');
  assert.equal(items[0].author, 'Ms. Alvarez');
  assert.equal(items[0].url, url, 'a media address is never rewritten: every byte of a signature counts');
});

// ------------------------------------------------------------------ page-5, page-6

test('page-5: the release link is this repository\'s release page however it is spelled, and stored normalised', () => {
  const release = (html_url) => parseRelease({ tag_name: 'v0.2.0', html_url, body: '', published_at: '2026-09-24T10:00:00Z' });
  for (const url of [
    'https://github.com/ip2k/care-album-saver/releases/../../evil',
    'https://github.com/ip2k/care-album-saver/releases/%2e%2E/%2e%2e/evil',
    'https://github.com/ip2k/care-album-saver/releases\\..\\..\\evil',
    'http://github.com/ip2k/care-album-saver/releases/tag/v0.2.0',
    'https://github.com.evil.example/ip2k/care-album-saver/releases/tag/v0.2.0',
    'https://github.com@evil.example/ip2k/care-album-saver/releases/tag/v0.2.0',
    'https://github.com:8443/ip2k/care-album-saver/releases/tag/v0.2.0',
    'https://github.com/ip2k/care-album-saver/releases/tag/v0.2.0?go=https://evil.example',
    'javascript:alert(1)//github.com/ip2k/care-album-saver/releases/',
  ]) {
    assert.equal(release(url), null, url);
  }
  assert.equal(
    release('https://GITHUB.com:443/ip2k/care-album-saver/releases/tag/./v0.2.0')?.url,
    'https://github.com/ip2k/care-album-saver/releases/tag/v0.2.0',
    'kept as the address it resolves to',
  );
});

test('page-6: a published date is kept only when it is a date', () => {
  const release = (published_at) =>
    parseRelease({ tag_name: 'v0.2.0', html_url: 'https://github.com/ip2k/care-album-saver/releases/tag/v0.2.0', body: '', published_at });
  assert.equal(release('2026-09-24T10:00:00Z')?.publishedAt, '2026-09-24T10:00:00Z');
  for (const junk of ['soon 1', 'not a date', '2026-13-45T99:99:99Z', '', 42, null, '<img src=x>']) {
    const r = release(junk);
    assert.ok(r, 'the release itself is still read');
    assert.equal(r.publishedAt, null, String(junk));
  }
});

// ------------------------------------------------------------------ Retry-After

test('Retry-After: a date is read only as an IMF-fixdate, and a number only as far as a year', () => {
  const now = Date.parse('2026-09-23T12:00:00Z');
  assert.equal(retryAfterSeconds('Wed, 23 Sep 2026 13:00:00 GMT', now), 3600);
  assert.equal(retryAfterSeconds('120', now), 120);
  // V8 reads every one of these as a date.
  assert.ok(Number.isFinite(Date.parse('soon 1')), 'the premise: Date.parse is no judge');
  for (const junk of ['soon 1', 'in 5 minutes 2026', 'Wednesday, 23-Sep-26 13:00:00 GMT', 'Wed Sep 23 13:00:00 2026', 'wed, 23 sep 2026 13:00:00 gmt', 'Wed, 23 Sep 2026 13:00:00 UTC', 'Wed, 31 Feb 2026 13:00:00 GMT', 'Wed, 23 Sep 2026 25:00:00 GMT', 'Wed, 23 Sep 0026 13:00:00 GMT']) {
    assert.equal(retryAfterSeconds(junk, now), null, junk);
  }
  const year = 365 * 86_400;
  assert.equal(retryAfterSeconds('9'.repeat(300), now), year, 'hundreds of digits are a year, not Infinity');
  assert.equal(retryAfterSeconds('99999999999', now), year);
  assert.equal(retryAfterSeconds('Fri, 31 Dec 9999 23:59:59 GMT', now), year);
  assert.equal(retryAfterSeconds(String(year - 1), now), year - 1);
});

test('Retry-After: an absurd wait ends the run in words a person can read', async () => {
  for (const header of ['9'.repeat(300), 'Fri, 31 Dec 9999 23:59:59 GMT']) {
    const client = new BrightwheelClient({
      session: new Secret(SESSION),
      delayMs: 0,
      fetchImpl: async () => new Response('slow down', { status: 429, headers: { 'retry-after': header } }),
    });
    await assert.rejects(client.me(), (error) => {
      assert.match(error.message, /wait a year or more before/);
      assert.ok(!/Infinity|NaN|e\+/.test(error.message), error.message);
      return true;
    });
  }
});
