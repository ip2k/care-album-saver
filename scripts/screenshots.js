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
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockBrightwheel } from '../packages/brightwheel-archive/dist/mock/server.js';
import { startWebUi } from '../packages/brightwheel-archive/dist/web/server.js';

const OUT = join(fileURLToPath(new URL('../docs/images', import.meta.url)));
const SESSION = 'test-session-value';
const VIEWPORT = { width: 1340, height: 940 };

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
    Object.assign(svg.style, { position: 'absolute', inset: '0', width: '100%', height: '100%' });
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
        top: `${(item.labelTop ?? ay) - 20}px`,
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
      const bx = onRight ? r.right + 64 : document.documentElement.scrollWidth - (document.documentElement.scrollWidth - r.left + 64);
      const line = document.createElementNS(svgNS, 'path');
      const startX = onRight ? bx - 6 : r.left + 6 + 0;
      const startY = (item.labelTop ?? ay) + 2;
      const midX = onRight ? (ax + startX) / 2 : (ax + startX) / 2;
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

async function shot(page, name) {
  await mkdir(OUT, { recursive: true });
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: false });
  process.stdout.write(`  docs/images/${name}.png\n`);
}

const main = async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'bw-shots-'));
  process.env.BRIGHTWHEEL_ARCHIVE_CONFIG_DIR = configDir;
  const photoDir = await mkdtemp(join(tmpdir(), 'bw-photos-'));

  const mock = await startMockBrightwheel({ validSession: SESSION, activitiesPerStudent: 14 });
  const ui = await startWebUi({ baseUrl: `${mock.url}/api/v1` });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 2 });

  process.stdout.write('Capturing screenshots (all data is synthetic):\n');
  await page.goto(ui.url, { waitUntil: 'networkidle' });

  // 1 — the first thing a parent sees.
  await annotate(page, [
    { selector: '#card-connect .steps', text: 'Four steps, in plain language. You sign in on Brightwheel’s own site — this tool never sees your password.', labelTop: 250 },
    { selector: '#cookie', text: 'Paste the one value here. It is stored on your computer only.', labelTop: 430, side: 'left' },
  ]);
  await shot(page, '01-connect');

  // 2 — connected, children listed.
  await page.fill('#cookie', SESSION);
  await page.click('#btn-connect');
  await page.waitForSelector('.kid', { timeout: 10000 });
  await page.waitForTimeout(400);
  await annotate(page, [
    { selector: '#num-1', text: 'A green tick means this step is done.', labelTop: 150, side: 'left' },
    { selector: '#kids', text: 'Your children, read from your own account. Brightwheel never shows this tool anybody else’s child.', labelTop: 470 },
  ]);
  await shot(page, '02-connected');

  // 3 — the choices that matter, with the advanced drawer open.
  await page.evaluate(() => document.querySelector('details').setAttribute('open', ''));
  await page.evaluate(() => document.querySelector('#card-children').scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(300);
  await annotate(page, [
    { selector: '#tagChildName', text: 'Writes your child’s name into the photo so Photos and Immich can find them by name.', labelTop: 120, side: 'left' },
    { selector: '#stripLocation', text: 'On by default: removes GPS coordinates so a shared file cannot reveal a location.', labelTop: 300, side: 'left' },
    { selector: 'details summary', text: 'Sensible defaults up front. Everything adjustable is tucked in here.', labelTop: 430 },
  ]);
  await shot(page, '03-options');

  // 4 — a completed run.
  await page.evaluate((dir) => {
    document.querySelector('#archiveDir').value = dir;
    document.querySelector('#btn-save-config').click();
  }, photoDir);
  await page.waitForTimeout(500);
  await page.click('#btn-run');
  await page.waitForFunction(() => document.querySelector('#s-saved').textContent !== '0', { timeout: 60000 });
  await page.waitForTimeout(3500);
  await page.evaluate(() => document.querySelector('#card-run').scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(300);
  await annotate(page, [
    { selector: '.stats', text: 'Saved, already-had, and failed. A second run saves nothing new — it recognises what it already has.', labelTop: 250 },
    { selector: '.privacy', text: 'The privacy summary is on the page itself, not buried in a document nobody reads.', labelTop: 470, side: 'left' },
  ]);
  await shot(page, '04-done');

  await browser.close();
  await ui.close();
  await mock.close();
  process.stdout.write('\nDone. Photos written to a temporary folder and discarded.\n');
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
