// First, before anything that can read the config directory.
import { assertIsolatedConfigDir } from '../../../scripts/test-env.js';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { verify } from '../dist/verify.js';
import { Secret } from '../dist/secrets.js';

/**
 * The outbound review's F3 (WARNING, docs/SECURITY-REVIEW-2026-09-23.md §4.6): `verify`, with or
 * without --deep, asked whatever media address the feed named, following redirects, so a feed
 * could make it probe the parent's own network and print the answer in a report they are told
 * is safe to share. It now holds media addresses, and every redirect, to the rule downloads
 * keep. A stand-in fetch answers everything, so nothing here reaches a network.
 */

before(assertIsolatedConfigDir);

const API = 'https://api.example.invalid/api/v1';
const json = (body) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

/** A stand-in Brightwheel whose one photo lives at `mediaUrl`; `media` answers media requests. */
function standIn(mediaUrl, media = () => new Response(null, { status: 200 })) {
  const requested = [];
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    requested.push({ method: init.method ?? 'GET', url, redirect: init.redirect });
    if (url.startsWith(`${API}/users/me`)) return json({ object_id: 'g-1' });
    // Activities first: their address is /students/{id}/activities.
    if (url.startsWith(`${API}/`) && url.includes('/activities')) {
      return json({
        activities: [{
          object_id: 'a1', action_type: 'ac_photo',
          event_date: '2026-09-18T09:00:00Z', created_at: '2026-09-18T09:00:00Z',
          media: { image_url: mediaUrl },
        }],
      });
    }
    if (url.startsWith(`${API}/`) && url.includes('/students')) return json({ students: [{ student: { object_id: 's-1' } }] });
    return media(url, init);
  };
  const outside = () => requested.filter((r) => !r.url.startsWith(`${API}/`));
  return { fetchImpl, outside };
}

for (const deep of [false, true]) {
  const how = deep ? 'verify --deep' : 'verify';

  test(`F3: ${how} asks nothing of a media address on the local network or over http`, async () => {
    for (const address of ['http://192.168.1.1/cgi-bin/admin?x=1', 'https://10.0.0.7/photo.jpg', 'https://user:pw@cdn.example.com/p.jpg']) {
      const { fetchImpl, outside } = standIn(address);
      const report = await verify(new Secret('test-session-value'), { baseUrl: API, fetchImpl, deep });
      assert.deepEqual(outside(), [], `${how} made no request outside the API for ${address}`);
      const said = [...report.findings, ...report.warnings].join('\n');
      assert.match(said, /not attempted, because the feed's media address was not asked/);
      assert.doesNotMatch(said, /Media fetch WITHOUT the session cookie: HTTP/);
      assert.doesNotMatch(said, /192\.168|10\.0\.0\.7|user:pw/, 'the refused address is not printed');
      // --deep's own download of the photo is refused too (or never reached without ExifTool).
      if (deep) assert.match(said, /--deep did not fetch a photo to examine: the feed's media address was not asked|--deep needs ExifTool/);
    }
  });

  test(`F3: ${how} does not follow a redirect from a public media host into the local network`, async () => {
    const { fetchImpl, outside } = standIn('https://cdn.example.com/p.jpg?Signature=S', (url) =>
      url.startsWith('https://cdn.example.com/')
        ? new Response(null, { status: 302, headers: { location: 'http://192.168.1.1/admin' } })
        : new Response(null, { status: 200 }));
    const report = await verify(new Secret('test-session-value'), { baseUrl: API, fetchImpl, deep });
    const asked = outside().map((r) => r.url);
    assert.ok(asked.every((u) => u.startsWith('https://cdn.example.com/')), `only the public host was asked: ${asked.join(', ')}`);
    assert.ok(outside().every((r) => r.redirect === 'manual'), 'redirects are followed by hand, never by fetch');
    assert.match([...report.findings, ...report.warnings].join('\n'), /redirected to an address this tool does not fetch from/);
  });
}

test('F3: a public https media address is still asked, once, without the session', async () => {
  const { fetchImpl, outside } = standIn('https://cdn.example.com/p.jpg?Signature=S');
  const report = await verify(new Secret('test-session-value'), { baseUrl: API, fetchImpl });
  assert.deepEqual(outside().map((r) => `${r.method} ${r.url}`), ['HEAD https://cdn.example.com/p.jpg?Signature=S']);
  assert.ok(report.findings.some((f) => /Media fetch WITHOUT the session cookie: HTTP 200\. CONFIRMED/.test(f)));
});
