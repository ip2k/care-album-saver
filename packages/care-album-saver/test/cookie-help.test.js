// First, before anything that can read the config directory: points this file at a
// throwaway one even when it is run on its own with `node --test` (see scripts/test-env.js).
// Nothing here touches config, but the rule is "every file", so that adding one line to
// this file later cannot quietly start writing over a real saved session.
import { assertIsolatedConfigDir } from '../../../scripts/test-env.js';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PAGE } from '../dist/web/page.js';
import {
  COOKIE_BROWSERS,
  COOKIE_FIGURES,
  EXAMPLE_COOKIE_VALUE,
  legendMarkdown,
} from '../dist/web/cookie-help.js';

/**
 * The picture guide for step 1 — the DevTools cookie hunt drawn out for somebody who has
 * never opened DevTools.
 *
 * Everything here is checked against the built page and the built figures, because the
 * page is a string: there is no component to render, and the mistakes worth catching (a
 * picture with no alt text, a marker with no sentence, a real-looking value, a document
 * that has drifted from the app) are all visible in that string.
 */

const repoFile = (path) => fileURLToPath(new URL(`../../../${path}`, import.meta.url));
const COOKIE_DOC = readFileSync(repoFile('docs/COOKIE.md'), 'utf8');

before(assertIsolatedConfigDir);

// ------------------------------------------------------------------ where it sits

test('the picture guide sits between the written steps and the paste box', () => {
  const steps = PAGE.indexOf('<ol class="howto" id="howto">');
  const guide = PAGE.indexOf('id="ck-toggle"');
  const box = PAGE.indexOf('<textarea id="cookie"');
  assert.ok(steps > 0, 'the written steps are still there');
  assert.ok(box > 0, 'the paste box is still there');
  assert.ok(guide > steps && guide < box, 'the pictures illustrate the steps and come before the box');
});

test('the pictures are collapsed until they are asked for', () => {
  assert.match(PAGE, /<button type="button" class="ck-toggle" id="ck-toggle" aria-expanded="false" aria-controls="ck-panel">/);
  assert.match(PAGE, /<div class="ck-panel" id="ck-panel" hidden>/);
  // A real button, so it is reachable by keyboard and announced as a control, and the
  // label says what pressing it will do rather than describing the state it is in.
  assert.match(PAGE, /Show me pictures of these steps/);
  assert.match(PAGE, /Hide the pictures/);
});

/**
 * The obvious control here would have been `<details>`, and it is deliberately not used:
 * scripts/screenshots.js opens step 2's Advanced options with
 * `document.querySelector('details')` to capture 03-options.png. A `<details>` added to
 * step 1 becomes the one it finds, silently, and it would not fail loudly enough for anyone
 * to notice.
 */
test('no disclosure is added before step 2 Advanced options', () => {
  // The invariant is about document ORDER, not about the count: scripts/screenshots.js reaches for
  // `document.querySelector('details')` and must keep finding step 2's Advanced options.
  // A disclosure added later in the page is harmless;
  // one added in step 1 would silently steal both selections. The count was asserted here
  // first and is deliberately not any more — it failed the moment another step grew a
  // disclosure, which is a stricter rule than the thing it was protecting.
  const details = [...PAGE.matchAll(/<details[\s>]/g)].map((m) => m.index);
  assert.ok(details.length >= 1, 'step 2 Advanced options is still a disclosure');
  assert.ok(
    details[0] > PAGE.indexOf('id="card-children"'),
    'the first <details> is still step 2 Advanced options, which scripts/screenshots.js selects by that assumption',
  );
  assert.ok(
    details[0] < PAGE.indexOf('id="card-run"'),
    'and it is still inside step 2, not something further down the page',
  );
});

// ------------------------------------------------------------------ the pictures

test('all three browsers are covered, with the right number of steps each', () => {
  assert.deepEqual(COOKIE_BROWSERS.map((b) => b.key), ['chrome', 'safari', 'firefox']);
  const perBrowser = Object.fromEntries(
    COOKIE_BROWSERS.map((b) => [b.key, COOKIE_FIGURES.filter((f) => f.browser === b.key).length]),
  );
  // Safari has three because it hides the developer tools until they are switched on,
  // which is a step the other two do not have and the one people get stuck on.
  assert.deepEqual(perBrowser, { chrome: 2, safari: 3, firefox: 2 });
  for (const browser of COOKIE_BROWSERS) {
    assert.ok(PAGE.includes(`id="ck-${browser.key}"`), `${browser.key} has a section in the page`);
    assert.ok(PAGE.includes(`>${browser.name}</h3>`), `${browser.name} is named in the page`);
  }
});

test('every picture says in words what it shows', () => {
  for (const figure of COOKIE_FIGURES) {
    assert.ok(figure.alt.length > 80, `${figure.id} has alt text that describes the step, not a title`);
    // The markers are what the sentences refer to, so the description has to mention them.
    for (const item of figure.legend.filter((l) => l.n !== undefined)) {
      assert.ok(
        figure.alt.includes(`marked ${item.n}`),
        `${figure.id} alt text accounts for marker ${item.n}`,
      );
    }
    assert.ok(figure.caption.length > 0, `${figure.id} has a caption`);
    assert.match(figure.svg, /role="img" aria-label="/, `${figure.id} is exposed as an image with a label`);
    assert.ok(PAGE.includes(figure.svg), `${figure.id} is in the page`);
  }
});

test('every marker drawn on a picture has a sentence, and every sentence a marker', () => {
  for (const figure of COOKIE_FIGURES) {
    const drawn = [...figure.svg.matchAll(/r="9\.5"/g)].length;
    const numbered = figure.legend.filter((l) => l.n !== undefined).map((l) => l.n);
    assert.equal(drawn, numbered.length, `${figure.id} draws one marker per numbered step`);
    assert.deepEqual(
      numbered,
      numbered.map((_, i) => i + 1),
      `${figure.id} numbers its steps 1, 2, 3 in order`,
    );
  }
});

test('the drawings reach for nothing outside the page', () => {
  // The page is served under `default-src 'none'`. A drawing that pulled in a bitmap or a
  // font would simply not render, and would have got past review as "it looks fine here".
  for (const figure of COOKIE_FIGURES) {
    const links = [...figure.svg.matchAll(/https?:\/\/[^"' ]+/g)].map((m) => m[0]);
    assert.deepEqual(links, ['http://www.w3.org/2000/svg'], `${figure.id} names only the SVG namespace`);
    assert.doesNotMatch(figure.svg, /<image|xlink:href|url\(/, `${figure.id} embeds nothing`);
  }
});

test('the value in the pictures is invented, and says so to anyone who decodes it', () => {
  const [encoded, signature] = EXAMPLE_COOKIE_VALUE.split('--');
  assert.equal(
    Buffer.from(decodeURIComponent(encoded), 'base64').toString('utf8'),
    'ExampleOnly-NotARealValue',
  );
  assert.match(signature, /^0+$/, 'no real signature is a row of zeros');
  const shown = COOKIE_FIGURES.find((f) => f.id === 'chrome-2-cookie').svg;
  assert.ok(shown.includes('_brightwheel_v2'), 'the row a parent is hunting for is named');
  assert.ok(shown.includes(encoded), 'and the invented value is the one in its Value column');
});

// ------------------------------------------------------------------ weight, and the doc

test('the pictures do not bloat the page', () => {
  // Drawn rather than photographed, the whole set is a few kilobytes. This is the guard
  // against somebody later inlining seven screenshots as base64 data: URIs, which is the
  // obvious thing to try and would put megabytes on a page served from a laptop.
  // The line is well above the page's own growth — text, styles and the drawings came to
  // about 150 KB by 23 September 2026 and about 200 KB by the 24th, with the Apple
  // Photos.app panel and its help — and far below one inlined screenshot, which is hundreds
  // of kilobytes on its own.
  const bytes = Buffer.byteLength(PAGE, 'utf8');
  assert.ok(bytes < 256 * 1024, `the setup page is ${Math.round(bytes / 1024)} KB, which is more than it should be`);
});

test('docs/COOKIE.md shows the same pictures and says the same words', () => {
  for (const figure of COOKIE_FIGURES) {
    const image = `images/cookie-${figure.id}.png`;
    assert.ok(COOKIE_DOC.includes(image), `${figure.id} is in the document`);
    assert.ok(existsSync(repoFile(`docs/${image}`)), `${image} has been rendered`);
    assert.ok(COOKIE_DOC.includes(figure.alt), `${figure.id} carries the same alt text as the page`);
    assert.ok(COOKIE_DOC.includes(figure.caption), `${figure.id} carries the same caption as the page`);
    for (const item of figure.legend) {
      assert.ok(
        COOKIE_DOC.includes(legendMarkdown(item.s)),
        `${figure.id}: the document still says "${item.s}"`,
      );
    }
  }
});

test('the document never prints a value that would read as a real session', () => {
  // The same shape gitleaks looks for: the cookie's name, then a long value. A document
  // teaching people where the value lives is exactly where somebody pastes their own.
  assert.doesNotMatch(COOKIE_DOC, /_brightwheel_v2\s*[=:]\s*["']?[A-Za-z0-9%._\-+/]{20,}/);
  assert.doesNotMatch(PAGE, /_brightwheel_v2\s*[=:]\s*["']?[A-Za-z0-9%._\-+/]{20,}/);
});
