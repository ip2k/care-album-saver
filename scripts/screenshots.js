/**
 * Capture the annotated screenshots used in docs/GUIDE.md.
 *
 * Everything shown is synthetic: the mock Brightwheel server invents two children called
 * Robin and Sam Maple and draws their "photos" as coloured placeholders. No real child,
 * name, note or session ever appears in these images, which is what makes them safe to
 * commit to a public repository.
 *
 *   node scripts/screenshots.js
 */
import { chromium } from 'playwright';
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockBrightwheel } from '../packages/brightwheel-archive/dist/mock/server.js';
import { startWebUi } from '../packages/brightwheel-archive/dist/web/server.js';

const OUT = join(fileURLToPath(new URL('../docs/images', import.meta.url)));
const SESSION = 'test-session-value';
const VIEWPORT = { width: 1340, height: 940 };

/**
 * Where the run's photos go. NOT a temporary directory: the tool refuses those, and when
 * it did, the run fell back to the stored default — the real ~/Brightwheel Photos on the
 * machine generating the docs. This folder is inside node_modules, which is gitignored
 * and must exist for the script to run at all, and it is deleted at the end.
 */
const PHOTOS = fileURLToPath(new URL('../node_modules/.cache/brightwheel-archive-screenshots', import.meta.url));

/**
 * The path shown in the pictures. The real one contains the developer's username, which
 * has no business in a public image; the mock's parent is Alex Maple, so this is theirs.
 * Only the two places that display the path are touched, and only just before a shot.
 */
const SHOWN_PATH = '/Users/alex/Brightwheel Photos';
async function showPath(page, value) {
  await page.evaluate((v) => {
    document.querySelector('#archiveDir').value = v;
    document.querySelector('#p-dir').textContent = v;
  }, value);
}

/**
 * Draw callouts into the page's left and right margins and point an arrow at the target.
 *
 * The UI column is 760px wide inside a 1340px viewport, which leaves ~290px of clear
 * space either side. Putting every label there means an annotation can never cover the
 * thing it is describing, and labels cannot collide with each other because each is given
 * its own vertical band.
 */
async function annotate(page, notes) {
  await page.evaluate((items) => {
    document.querySelectorAll('.__ann').forEach((n) => n.remove());
    const layer = document.createElement('div');
    layer.className = '__ann';
    Object.assign(layer.style, {
      position: 'absolute', inset: '0', pointerEvents: 'none', zIndex: '9999',
    });

    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    // Sized to the document, not the viewport: with 100% the arrows for anything below
    // the first screen were clipped, so no scrolled screenshot ever showed one.
    Object.assign(svg.style, {
      position: 'absolute', left: '0', top: '0',
      width: `${document.documentElement.scrollWidth}px`,
      height: `${document.documentElement.scrollHeight}px`,
    });
    svg.setAttribute('width', String(document.documentElement.scrollWidth));
    svg.setAttribute('height', String(document.documentElement.scrollHeight));
    const defs = document.createElementNS(svgNS, 'defs');
    defs.innerHTML =
      '<marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">' +
      '<path d="M 0 0 L 10 5 L 0 10 z" fill="#e0472c"/></marker>';
    svg.appendChild(defs);
    layer.appendChild(svg);

    for (const item of items) {
      const el = document.querySelector(item.selector);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      const top = r.top + window.scrollY;
      const onRight = item.side !== 'left';

      // Anchor on the element edge nearest the margin we are writing into.
      const ax = onRight ? r.right + 6 : r.left - 6;
      const ay = top + Math.min(r.height / 2, 28);

      const box = document.createElement('div');
      box.textContent = item.text;
      Object.assign(box.style, {
        position: 'absolute',
        width: '236px',
        top: `${ay + (item.offset ?? 0) - 20}px`,
        [onRight ? 'left' : 'right']: onRight
          ? `${r.right + 64}px`
          : `${document.documentElement.scrollWidth - r.left + 64}px`,
        background: '#e0472c',
        color: '#fff',
        font: '600 13.5px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        padding: '10px 14px',
        borderRadius: '9px',
        boxShadow: '0 4px 14px rgba(224,71,44,.28)',
      });
      layer.appendChild(box);

      // Arrow from the callout's inner edge to the element edge, drawn after layout
      // so the real label height is known.
      requestAnimationFrame(() => {});
      const bx = onRight ? r.right + 64 : r.left - 64;
      const line = document.createElementNS(svgNS, 'path');
      const startX = onRight ? bx - 6 : bx + 6;
      const startY = ay + (item.offset ?? 0) + 2;
      const midX = (ax + startX) / 2;
      line.setAttribute(
        'd',
        `M ${startX} ${startY} C ${midX} ${startY}, ${midX} ${ay}, ${ax} ${ay}`,
      );
      line.setAttribute('stroke', '#e0472c');
      line.setAttribute('stroke-width', '2.5');
      line.setAttribute('fill', 'none');
      line.setAttribute('marker-end', 'url(#ah)');
      svg.appendChild(line);

      // A soft outline on the element itself, so the reader sees exactly what is meant.
      const ring = document.createElement('div');
      Object.assign(ring.style, {
        position: 'absolute',
        left: `${r.left - 5}px`,
        top: `${top - 5}px`,
        width: `${r.width + 10}px`,
        height: `${r.height + 10}px`,
        border: '2.5px solid #e0472c',
        borderRadius: '11px',
        boxShadow: '0 0 0 4px rgba(224,71,44,.13)',
      });
      layer.appendChild(ring);
    }
    document.body.appendChild(layer);
  }, notes);
  await page.waitForTimeout(160);
}

/** `endAt` names the element the picture should end just below, so no card is cut in half. */
async function shot(page, name, endAt) {
  await mkdir(OUT, { recursive: true });
  await showPath(page, SHOWN_PATH);
  const clip = endAt
    ? await page.evaluate((sel) => {
        const r = document.querySelector(sel).getBoundingClientRect();
        return { x: 0, y: 0, width: window.innerWidth, height: Math.ceil(r.bottom) + 8 };
      }, endAt)
    : undefined;
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: false, clip });
  process.stdout.write(`  docs/images/${name}.png\n`);
}

const main = async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'bw-shots-'));
  process.env.BRIGHTWHEEL_ARCHIVE_CONFIG_DIR = configDir;
  await rm(PHOTOS, { recursive: true, force: true });
  await mkdir(PHOTOS, { recursive: true });
  // Stored before the UI starts, so there is never a moment when the default applies.
  await writeFile(join(configDir, 'config.json'), JSON.stringify({ archiveDir: PHOTOS }));

  const mock = await startMockBrightwheel({ validSession: SESSION, activitiesPerStudent: 14 });
  const ui = await startWebUi({ baseUrl: `${mock.url}/api/v1` });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 2, colorScheme: 'light' });

  process.stdout.write('Capturing screenshots (all data is synthetic):\n');
  await page.goto(ui.url, { waitUntil: 'networkidle' });

  // 1 — the first thing a parent sees.
  await annotate(page, [
    { selector: '#howto', text: 'Five steps, in plain language. You sign in on Brightwheel’s own site — this tool never sees your password.', offset: 0 },
    { selector: '#cookie', text: 'Paste the one value here. It is stored on your computer only.', offset: 0, side: 'left' },
  ]);
  await shot(page, '01-connect');

  // 2 — connected, children listed. Connecting moves focus to Start saving, which scrolls
  // step 2 off the top; bring the tick and the children back into view first.
  await page.fill('#cookie', SESSION);
  await page.click('#btn-connect');
  await page.waitForSelector('.kid', { timeout: 10000 });
  await page.waitForTimeout(400);
  await page.setViewportSize({ width: VIEWPORT.width, height: 1100 });
  await page.evaluate(() => document.querySelector('#card-connect').scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(300);
  await annotate(page, [
    { selector: '#num-1', text: 'A green tick means this step is done.', offset: 0, side: 'left' },
    { selector: '#kids', text: 'Your children, read from your own account. Each one is a tick box — untick a child to leave their photos out.', offset: 0 },
  ]);
  await shot(page, '02-connected');
  await page.setViewportSize(VIEWPORT);

  // 3 — the choices that matter, with one child unticked and the advanced drawer open.
  // Every change saves itself, so the shot also shows the quiet "Saved" confirmation.
  // The open drawer makes this card taller than the usual viewport.
  const saved = page.waitForResponse((r) => r.url().includes('/api/config'));
  await page.uncheck('#kid-1');
  await saved;
  await page.waitForFunction(() => document.querySelector('#config-msg')?.textContent === 'Saved', { timeout: 5000 });
  await page.setViewportSize({ width: VIEWPORT.width, height: 1200 });
  await page.evaluate(() => document.querySelector('details').setAttribute('open', ''));
  await page.evaluate(() => document.querySelector('#card-children').scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(300);
  await annotate(page, [
    { selector: '#kids-status', text: 'It says, in words, whose photos will be saved.', offset: 0 },
    { selector: '#tagChildName', text: 'Writes your child’s name into the photo so Photos and Immich can find them by name.', offset: -10, side: 'left' },
    { selector: '#stripLocation', text: 'On by default: removes GPS coordinates so a shared file cannot reveal a location.', offset: 0, side: 'left' },
    { selector: 'details summary', text: 'Sensible defaults up front. Everything adjustable is tucked in here.', offset: 0 },
    { selector: '#config-msg', text: 'Nothing to remember to press: each setting is saved the moment you change it.', offset: -24 },
  ]);
  await shot(page, '03-options', '#card-children');
  await page.setViewportSize(VIEWPORT);
  const restored = page.waitForResponse((r) => r.url().includes('/api/config'));
  await page.check('#kid-1');
  await restored;

  // 4 — a completed run. Start saving sends the form as shown, so the real folder must be
  // back in the field before it is pressed.
  await showPath(page, PHOTOS);
  await page.click('#btn-run');
  // Wait for the completion banner, not merely for the first file to land — otherwise the
  // "finished" screenshot shows a run still in progress.
  await page.waitForFunction(
    () => document.querySelector('#run-result')?.textContent?.trim().length > 0,
    { timeout: 120000 },
  );
  await page.waitForTimeout(600);
  await page.setViewportSize({ width: VIEWPORT.width, height: 1100 });
  await page.evaluate(() => document.querySelector('#card-run').scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(300);
  await annotate(page, [
    { selector: '.stats', text: 'Saved, already-had, and failed. A second run saves nothing new — it recognises what it already has.', offset: 0 },
    { selector: '.privacy', text: 'The privacy summary is on the page itself, not buried in a document nobody reads.', offset: 0, side: 'left' },
  ]);
  await shot(page, '04-done');
  // Belt and braces: the run must have written here and nowhere else.
  await access(join(PHOTOS, 'archive.json'));

  // 5 — dark mode, on the step with the most controls. Both schemes are first-class.
  const dark = await browser.newPage({ viewport: { width: VIEWPORT.width, height: 1160 }, deviceScaleFactor: 2, colorScheme: 'dark' });
  await dark.goto(ui.url, { waitUntil: 'networkidle' });
  await dark.waitForSelector('.kid', { timeout: 10000 });
  await dark.waitForTimeout(700);
  await dark.evaluate(() => document.querySelector('#card-children').scrollIntoView({ block: 'start' }));
  await dark.waitForTimeout(300);
  await shot(dark, '05-dark', '#card-run');
  await dark.close();

  await browser.close();
  await ui.close();
  await mock.close();
  await rm(PHOTOS, { recursive: true, force: true });
  process.stdout.write('\nDone. The run\u2019s photos went to a scratch folder inside node_modules and were deleted.\n');
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
