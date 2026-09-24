// First, before anything that can read the config directory.
import { assertIsolatedConfigDir } from '../../../scripts/test-env.js';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../dist/config.js';
import { startWebUi } from '../dist/index.js';

/**
 * How the page shows where the daily run is written down, and how the demo labels itself.
 *
 * The scheduler's file lives under the home folder, and the page used to print it in full —
 * /Users/<account>/Library/LaunchAgents/… — which put the account name into every
 * screenshot, and in the demo showed a temporary folder no parent would ever see. It is now
 * written from the home folder, as `~/…`, while the file itself is still written in full.
 */

before(assertIsolatedConfigDir);

async function freshConfigDir() {
  process.env.CARE_ALBUM_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'cas-paths-'));
  return assertIsolatedConfigDir();
}

const pretendLaunchd = () => {
  let registered = false;
  return async (file, args) => {
    if (file === 'launchctl' && args[0] === 'bootstrap') registered = true;
    if (file === 'launchctl' && args[0] === 'bootout') registered = false;
    return { code: file === 'launchctl' && args[0] === 'print' && !registered ? 113 : 0, stdout: '', stderr: '' };
  };
};

async function call(handle, path, body) {
  const res = await fetch(`http://127.0.0.1:${handle.port}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-setup-token': handle.token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test('the page shows the daily run\'s file from the home folder, and the file is still written in full', async () => {
  await freshConfigDir();
  const home = await mkdtemp(join(tmpdir(), 'cas-paths-home-'));
  const handle = await startWebUi({ schedule: { home, run: pretendLaunchd(), platform: 'darwin' } });
  try {
    const on = await call(handle, '/api/schedule', { time: '19:00' });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    assert.equal(on.body.schedule.location, '~/Library/LaunchAgents/com.care-album-saver.daily.plist');

    const asked = await call(handle, '/api/schedule');
    assert.equal(asked.body.schedule.location, '~/Library/LaunchAgents/com.care-album-saver.daily.plist');
    assert.match(asked.body.proposed.location, /^~\/Library\/LaunchAgents\//, 'the proposal too');

    // The record the tool keeps, and the file itself, are the real thing.
    const stored = (await loadConfig()).schedule.location;
    assert.equal(stored, join(home, 'Library/LaunchAgents/com.care-album-saver.daily.plist'));
    assert.match(await readFile(stored, 'utf8'), /<key>StartCalendarInterval<\/key>/);
  } finally {
    await handle.close();
  }
});

test('the demo banner appears only when asked for, and is text rather than markup', async () => {
  await freshConfigDir();
  const plain = await startWebUi({});
  const demo = await startWebUi({ banner: 'Demo <b>only</b> & pretend' });
  try {
    const page = async (h) => (await fetch(`http://127.0.0.1:${h.port}/?token=${h.token}`)).text();
    const without = await page(plain);
    assert.ok(!without.includes('demo-ribbon"'), 'no ribbon on the real page');
    const withIt = await page(demo);
    assert.ok(withIt.includes('<div class="demo-ribbon" role="note">Demo &lt;b&gt;only&lt;/b&gt; &amp; pretend</div>'));
  } finally {
    await plain.close();
    await demo.close();
  }
});

test('no font shorthand mixes `inherit` with other values, which drops the whole rule', async () => {
  // `font: 600 1.0625rem/1.3 inherit` looks right and is invalid CSS: a CSS-wide keyword
  // cannot share a shorthand. The browser discarded it, and every button, text box and the
  // cookie-help toggle rendered at the browser's built-in 13.3px through three rounds of
  // "make the button text bigger". Comments are stripped first; they may quote the mistake.
  const { PAGE } = await import('../dist/web/page.js');
  const css = PAGE.slice(PAGE.indexOf('<style>'), PAGE.indexOf('</style>')).replace(/\/\*[\s\S]*?\*\//g, '');
  const bad = [...css.matchAll(/\bfont\s*:\s*([^;}]*)/g)]
    .map((m) => m[1].trim())
    .filter((value) => /\b(inherit|initial|unset|revert)\b/.test(value) && !/^(inherit|initial|unset|revert)$/.test(value));
  assert.deepEqual(bad, []);
});
