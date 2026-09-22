// First, before anything that can read the config directory: points this file at a
// throwaway one even when it is run on its own with `node --test`, which applies no
// --import (see scripts/test-env.js).
import { assertIsolatedConfigDir } from '../../../scripts/test-env.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { startMockBrightwheel, startWebUi } from '../dist/index.js';

/**
 * What the setup page calls itself, and the one link that leaves it.
 *
 * Both are things a parent sees within two seconds of the page opening, and both are easy
 * to break by accident: a heading and a tab title drift apart, and a hyperlink loses its
 * rel or its "new tab" wording in a reflow of the sentence around it. The page's own
 * script cannot be run here — it is a browser script and this suite has no browser — so
 * the instruction list is compiled out of the served HTML and called, the way
 * web-ui-stop-and-errors.test.js reads the rest of that script.
 */

let mock;
const SESSION = 'test-session-value';

before(assertIsolatedConfigDir);
before(async () => { mock = await startMockBrightwheel({ validSession: SESSION, activitiesPerStudent: 2 }); });
after(async () => { await mock?.close(); });

/** The page exactly as a browser receives it, with the headers it arrives under. */
async function servedPage() {
  const ui = await startWebUi({ baseUrl: `${mock.url}/api/v1` });
  try {
    const res = await fetch(`http://127.0.0.1:${ui.port}/?token=${ui.token}`);
    assert.equal(res.status, 200);
    return { headers: res.headers, html: await res.text() };
  } finally {
    await ui.close();
  }
}

/**
 * The step-1 instructions as that browser would render them. They are built in the page's
 * script from the user agent, so the only honest way to check them is to run the function
 * with each browser's string rather than to grep the source for a URL.
 */
function howToStepsFor(html, userAgent) {
  const from = html.indexOf('function howToSteps()');
  const to = html.indexOf("$('howto').innerHTML", from);
  assert.ok(from > 0 && to > from, 'the instruction list is still where this test looks for it');
  const source = html.slice(from, to);
  return new Script(`${source}\nhowToSteps();`).runInNewContext({ navigator: { userAgent } });
}

const BROWSERS = {
  Chrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  Firefox: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0',
  Safari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
};

test('the page calls itself Care Album Saver, and does not put Brightwheel in its own name', async () => {
  const { html } = await servedPage();

  assert.match(html, /<title>Care Album Saver<\/title>/, 'the browser tab carries the name');
  assert.match(html, /<h1>Care Album Saver<\/h1>/, 'and so does the heading, word for word');
  assert.equal((html.match(/<h1/g) || []).length, 1, 'exactly one h1');

  // The name is deliberately not the package's, and this is the assertion that says so.
  // This page is the face of the tool, and a tool that put somebody else's trade mark in
  // its OWN name is the one a lawyer's letter closes. Every appearance of "Brightwheel"
  // on this page names the service a parent signs in to — nominative use — and none of
  // them is the tool's name.
  const title = html.slice(html.indexOf('<title>'), html.indexOf('</title>'));
  const heading = html.slice(html.indexOf('<h1>'), html.indexOf('</h1>'));
  assert.ok(!/brightwheel/i.test(title), 'the tab name is not somebody else\'s mark');
  assert.ok(!/brightwheel/i.test(heading), 'nor is the heading');

  // The subtitle was removed, not reworded. A page carrying two explanations of itself is
  // how the old one and a new one end up contradicting each other later.
  assert.ok(
    !html.includes('This copies photos from your own Brightwheel account'),
    'the old subtitle is gone',
  );
  assert.ok(!html.includes('class="lede"'), 'and nothing is left styling an element that no longer exists');
});

test('the Brightwheel address in step one is a link, and says that it opens a new tab', async () => {
  const { html } = await servedPage();

  for (const [name, ua] of Object.entries(BROWSERS)) {
    const steps = howToStepsFor(html, ua);
    const first = steps[0];

    // The exact href, closing quote included: a prefix match would still pass if a query
    // string, a fragment or an interpolated value were ever appended to the one URL that
    // leaves this page, and this page's own address carries the setup token.
    assert.match(first, /href="https:\/\/schools\.mybrightwheel\.com\/"/, `${name}: a real link, to exactly that address`);
    assert.match(first, /target="_blank"/, `${name}: opens beside the page, which keeps the paste box in place`);
    // As a set, not as a string: the two are order-independent to a browser, so a reorder
    // is not a regression and must not read as one.
    const rel = new Set((first.match(/rel="([^"]*)"/)?.[1] ?? '').split(/\s+/).filter(Boolean));
    assert.ok(rel.has('noopener') && rel.has('noreferrer'), `${name}: the new tab gets no handle on this one and no referrer`);

    // An arrow alone is announced as nothing at all, so the words are inside the link text
    // and therefore part of the name a screen reader reads out (WCAG 3.2.5).
    assert.ok(first.includes('(opens in a new tab)'), `${name}: the warning is words, not only an icon`);
    const linkText = first.slice(first.indexOf('>', first.indexOf('<a ')) + 1, first.indexOf('</a>'));
    assert.ok(linkText.includes('(opens in a new tab)'), `${name}: and those words are inside the link`);

    // Every mention, not just the first one: an address left as plain text is one a parent
    // retypes, and a typo lands them on somebody else's sign-in page.
    const outsideLinks = steps.join(' ').replace(/<a\b[^>]*>[\s\S]*?<\/a>/g, '');
    assert.ok(!outsideLinks.includes('mybrightwheel.com'), `${name}: no bare mention left over`);
  }
});

test('following that link cannot carry the setup token to Brightwheel', async () => {
  const { headers, html } = await servedPage();

  // The page's own address holds the setup token, so a referrer would hand it to another
  // origin. Two independent guards, because either one alone is a single edit from gone.
  assert.equal(headers.get('referrer-policy'), 'no-referrer');
  assert.match(html, /rel="noopener noreferrer"/);

  // A link is a navigation, not a load, so default-src 'none' never stood in its way and
  // no origin had to be allowed for it. If this ever fails, something widened the policy.
  const csp = headers.get('content-security-policy');
  assert.match(csp, /default-src 'none'/);
  assert.ok(!csp.includes('mybrightwheel.com'), 'a plain hyperlink needs no CSP allowance');
});
