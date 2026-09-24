// First, before anything that can read the config directory.
import { assertIsolatedConfigDir } from '../../../scripts/test-env.js';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrightwheelClient, apiHeaders, refuseLiveApiUnderTest, retryAfterSeconds } from '../dist/api/client.js';
import { refuseLiveApiUnderTest as viaConfig } from '../dist/config.js';
import { download, DownloadError } from '../dist/ferry/download.js';
import { mediaUrlRefusal } from '../dist/ferry/url.js';
import { Secret } from '../dist/secrets.js';

/**
 * The outbound review's NOTEs (docs/SECURITY-REVIEW-2026-09-23.md §4.6): the test guard against
 * the live API (F8), a same-origin redirect carrying a user name (F15), Retry-After with
 * leading zeros (F16), IPv6 ranges the media rule missed (F20), and the one place the session
 * cookie is written (outbound-13).
 */

before(assertIsolatedConfigDir);

test('F8: under test, no client can be made for Brightwheel itself, however its name is written', () => {
  assert.equal(process.env.CARE_ALBUM_NO_LIVE_API, '1', 'test-env.js sets it');
  const session = new Secret('test-session-value');
  for (const baseUrl of [
    undefined,
    'https://schools.mybrightwheel.com/api/v1',
    'https://schools.mybrightwheel.com./api/v1',
    'https://SCHOOLS.MyBrightwheel.com/api/v1',
    'https://api.mybrightwheel.com/v1',
    'https://mybrightwheel.com/api/v1',
  ]) {
    assert.throws(() => new BrightwheelClient({ session, baseUrl }), /CARE_ALBUM_NO_LIVE_API is set/, String(baseUrl));
    assert.throws(() => refuseLiveApiUnderTest(baseUrl), /CARE_ALBUM_NO_LIVE_API is set/);
  }
  // The mock, another address, and a client that brings its own fetch are all allowed.
  new BrightwheelClient({ session, baseUrl: 'http://127.0.0.1:4321/api/v1' });
  new BrightwheelClient({ session, baseUrl: 'https://notmybrightwheel.com/api/v1' });
  new BrightwheelClient({ session, fetchImpl: async () => new Response('{}') });
  assert.equal(viaConfig, refuseLiveApiUnderTest, 'config.js re-exports the same guard for its callers');
});

test('F16: Retry-After with leading zeros is the number it spells', () => {
  assert.equal(retryAfterSeconds('00000000005'), 5);
  assert.equal(retryAfterSeconds('0000000000000000000000001'), 1);
  assert.equal(retryAfterSeconds('0'), 0);
  assert.equal(retryAfterSeconds('000'), 0);
  assert.equal(retryAfterSeconds('99999999999'), 365 * 24 * 60 * 60, 'eleven real digits is still the ceiling');
});

test('F20: the IPv6 ranges that name no public server are refused as media addresses', () => {
  for (const host of ['[::ffff:0:c0a8:101]', '[64:ff9b:1::a00:1]', '[64:ff9b:1:ffff::1]', '[100::1]', '[2001:db8::1]']) {
    assert.match(mediaUrlRefusal(`https://${host}/a.jpg`) ?? '', /local network/, host);
  }
  // Still public: the NAT64 well-known prefix in front of a public address, and ordinary v6.
  assert.equal(mediaUrlRefusal('https://[64:ff9b::808:808]/a.jpg'), null);
  assert.equal(mediaUrlRefusal('https://[2606:4700::1111]/a.jpg'), null);
});

test('F15: a same-origin redirect to an address with a user name is refused, and nothing quotes it', async () => {
  const server = createServer((req, res) => {
    const port = server.address().port;
    res.writeHead(302, { location: `http://user:pw@127.0.0.1:${port}/photo.jpg?Signature=SAMEORIGINSIG` }).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const dir = await mkdtemp(join(tmpdir(), 'cas-notes-outbound-'));
  try {
    const url = `http://127.0.0.1:${server.address().port}/start.jpg?Signature=FIRSTSIG`;
    await assert.rejects(download({ url, destination: join(dir, 'a.jpg') }), (error) => {
      assert.ok(error instanceof DownloadError, `a DownloadError, not ${error.name}: ${error.message}`);
      assert.match(error.message, /user name or password/);
      assert.doesNotMatch(error.message, /user:pw|SAMEORIGINSIG|FIRSTSIG/);
      return true;
    });
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('outbound-13: the session cookie is written in one place, which verify and the client share', () => {
  const headers = apiHeaders(new Secret('the-session'), 'UA/1');
  assert.deepEqual(headers, {
    Cookie: '_brightwheel_v2=the-session',
    Accept: 'application/json',
    'X-Client-Name': 'web',
    'User-Agent': 'UA/1',
  });
  assert.equal('User-Agent' in apiHeaders(new Secret('s')), false, 'no identity unless one is given');
});
