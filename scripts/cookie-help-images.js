/**
 * Render the step-1 cookie drawings to docs/images/cookie-*.png for docs/COOKIE.md.
 *
 * The pictures themselves are not made here: they are the very SVGs the setup page shows,
 * exported from src/web/cookie-help.ts. This script only paints them, so the document and
 * the app can never show a reader two different things.
 *
 * Nothing real is drawn and nothing real is touched. There is no server, no session, no
 * config directory and no network: a drawing of a cookie panel with an invented value in
 * it is the whole point (see the header of src/web/cookie-help.ts).
 *
 *   node scripts/cookie-help-images.js
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COOKIE_FIGURES, COOKIE_FIGURE_CSS } from '../packages/care-album-saver/dist/web/cookie-help.js';

const OUT = fileURLToPath(new URL('../docs/images', import.meta.url));

/** One viewBox unit is one CSS pixel, which is what makes the checks below comparable. */
const WIDTH = 640;

/**
 * The few page variables the figure palette is written in terms of. The drawings are shown
 * inside the setup page's own card, so their colours are expressed relative to it; here
 * there is no page, so the light-mode values are restated. Light only: the guide images
 * beside these are light, and one look for the document is better than two.
 */
const host = (svg) => `<!doctype html>
<html><head><meta charset="utf-8"><style>
  :root { color-scheme: light; --surface-sunken: #f2e9e1; --radius-sm: 8px; }
  body {
    margin: 0; background: var(--surface-sunken);
    font: 1rem/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  }
  ${COOKIE_FIGURE_CSS}
  .ck-panel { width: ${WIDTH}px; }
  .ck-svg { display: block; width: ${WIDTH}px; height: auto; }
</style></head>
<body><div class="ck-panel">${svg}</div></body></html>`;

/**
 * Prove the labels behave, rather than assume it — the same bargain scripts/screenshots.js
 * strikes with its callouts, made for drawings instead of callouts in a margin.
 *
 * Three ways a figure can be wrong and nobody notice until it is in the guide: a label can
 * grow past the space it was budgeted (`data-max`, which is how every table cell, tab and
 * sidebar row declares its column), a marker can land on a label rather than beside it, or
 * something can be cut off by the edge. All three are failures here, not warnings, because
 * a picture is checked by looking at it and nobody looks at the seventh one.
 */
const check = (page) => page.evaluate(() => {
  const svg = document.querySelector('svg');
  const frame = svg.getBoundingClientRect();
  const texts = [...svg.querySelectorAll('text')];
  const rects = texts.map((t) => t.getBoundingClientRect());
  const name = (t) => JSON.stringify(t.textContent.slice(0, 30));
  const hits = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  const bad = [];
  texts.forEach((text, i) => {
    const r = rects[i];
    if (r.left < frame.left - 0.5 || r.right > frame.right + 0.5
      || r.top < frame.top - 0.5 || r.bottom > frame.bottom + 0.5) {
      bad.push(`${name(text)} is cut off by the edge of the figure`);
    }
    const max = text.getAttribute('data-max');
    const width = text.getBBox().width;
    if (max && width > Number(max) + 0.5) {
      bad.push(`${name(text)} is ${width.toFixed(1)} wide in a space of ${max}`);
    }
    for (let j = i + 1; j < texts.length; j += 1) {
      if (hits(r, rects[j])) bad.push(`${name(text)} overlaps ${name(texts[j])}`);
    }
  });
  return bad;
});

const main = async () => {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch();
  // Twice the size, so the picture stays sharp on the screens people read documents on.
  const page = await browser.newPage({ viewport: { width: 900, height: 900 }, deviceScaleFactor: 2 });

  process.stdout.write('Drawing the cookie guide (nothing real is rendered):\n');
  const failures = [];
  for (const figure of COOKIE_FIGURES) {
    await page.setContent(host(figure.svg), { waitUntil: 'load' });
    const problems = await check(page);
    if (problems.length > 0) failures.push(`cookie-${figure.id}:\n    ${problems.join('\n    ')}`);
    await page.locator('svg').screenshot({ path: join(OUT, `cookie-${figure.id}.png`) });
    process.stdout.write(`  docs/images/cookie-${figure.id}.png\n`);
  }

  await browser.close();
  if (failures.length > 0) {
    throw new Error(`Labels do not fit:\n  ${failures.join('\n  ')}`);
  }
  process.stdout.write('\nDone. Every label fits its space and nothing overlaps.\n');
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
