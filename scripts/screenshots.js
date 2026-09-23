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
import { mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockBrightwheel } from '../packages/care-album-saver/dist/mock/server.js';
import { startWebUi } from '../packages/care-album-saver/dist/web/server.js';

const OUT = join(fileURLToPath(new URL('../docs/images', import.meta.url)));
const SESSION = 'test-session-value';
const VIEWPORT = { width: 1340, height: 940 };

/**
 * Where the run's photos go. NOT a temporary directory: the tool refuses those, and when
 * it did, the run fell back to the stored default — the real photos folder on the
 * machine generating the docs. This folder is inside node_modules, which is gitignored
 * and must exist for the script to run at all, and it is deleted at the end.
 */
const PHOTOS = fileURLToPath(new URL('../node_modules/.cache/care-album-saver-screenshots', import.meta.url));
// The daily log names a child and the archive folder, and shot 4 shows its tail. Pointed at
// a throwaway directory so a committed picture can only ever contain this script's own
// synthetic run — never the real one sitting in ~/Library/Logs.
process.env.CARE_ALBUM_LOG_DIR = mkdtempSync(join(tmpdir(), 'cas-shot-logs-'));

/**
 * The path shown in the pictures. The real one contains the developer's username, which
 * has no business in a public image; the mock's parent is Alex Maple, so this is theirs.
 * Only the two places that display the path are touched, and only just before a shot.
 */
const SHOWN_PATH = '/Users/alex/Care Album Photos';
async function showPath(page, value) {
  await page.evaluate((v) => {
    document.querySelector('#archiveDir').value = v;
    document.querySelector('#p-dir').textContent = v;
  }, value);
}

/**
 * Replace anything belonging to whoever ran this, wherever the page prints it.
 *
 * A sweep over every text node and input value rather than a list of selectors, because
 * the page renders paths from several places and at several moments — the run summary
 * after a run, the schedule card after its state arrives — and a selector list is a list
 * of the places somebody remembered. One of them printed a home-folder path into a
 * committed image; another printed this script's own scratch folder, inside node_modules,
 * where the guide means to show a parent their photos folder.
 *
 * Two substitutions, longest first: the scratch archive lives inside the home folder, so
 * replacing the home folder first would leave a half-rewritten path behind.
 */
async function scrubPersonal(page) {
  await page.evaluate(
    (pairs) => {
      const apply = (s) => pairs.reduce((acc, [from, to]) => acc.split(from).join(to), s);
      const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walk.nextNode(); node; node = walk.nextNode()) {
        const next = apply(node.textContent);
        if (next !== node.textContent) node.textContent = next;
      }
      // Inputs hold their value as a property, which no text-node walk can reach.
      for (const el of document.querySelectorAll('input, textarea')) {
        const next = apply(el.value ?? '');
        if (next !== el.value) el.value = next;
      }
    },
    [
      [PHOTOS, SHOWN_PATH],
      [homedir(), '/Users/alex'],
    ],
  );
}

/**
 * Draw callouts into the page's left and right margins and point an arrow at the target.
 *
 * The UI column is 760px wide inside a 1340px viewport, which leaves ~290px of clear
 * space either side. Putting every label there means an annotation can never cover the
 * thing it is describing, and labels cannot collide with each other because each is given
 * its own vertical band.
 *
 * A label is set against the edge of the CARD, not of the element it points at. Measuring
 * from the element put the label wherever that element's own inset happened to fall, and
 * a control sitting near the card's padding — the paste box, the first tick — pushed its
 * label a few pixels over the card's border. Going by the card also lines the labels up
 * with each other, which is what makes the margin read as a margin.
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

      // The card the element lives in: the label is set against its edge, clear of it.
      const cr = (el.closest('.card, .privacy') ?? el).getBoundingClientRect();
      const GAP = 24;
      const bx = onRight ? cr.right + GAP : cr.left - GAP;

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
          ? `${bx}px`
          : `${document.documentElement.scrollWidth - bx}px`,
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

  // Labels belong in the margins; prove it rather than assume it. A callout that grows by
  // a line, or a card that gets wider, otherwise creeps over the very thing it describes,
  // and nobody notices until the picture is in the guide. The arrows are exempt: one
  // crossing a card's edge to touch its target is the point of it.
  const collisions = await page.evaluate(() => {
    const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    const short = (n) => JSON.stringify(n.textContent.slice(0, 34) + '…');
    const labels = [...document.querySelectorAll('.__ann > div')].filter((n) => n.textContent);
    // The drawn content, not `.wrap`: the column's own padding is clear space a label may
    // legitimately sit in, and judging by it would reject layouts that are perfectly fine.
    const content = [...document.querySelectorAll('.card, .privacy, h1')].map((n) => n.getBoundingClientRect());
    const bad = [];
    for (const [i, label] of labels.entries()) {
      const r = label.getBoundingClientRect();
      if (content.some((c) => overlaps(r, c))) bad.push(`${short(label)} reaches into the page column`);
      for (const other of labels.slice(i + 1)) {
        if (overlaps(r, other.getBoundingClientRect())) bad.push(`${short(label)} overlaps ${short(other)}`);
      }
    }
    return bad;
  });
  if (collisions.length > 0) throw new Error(`Callouts collide:\n  ${collisions.join('\n  ')}`);
}

/**
 * `endAt` names the element the picture should end just below, so no row and no card is
 * cut in half.
 *
 * The callouts are measured with it. A label sits in the margin beside the thing it
 * describes and, being four lines of text against a one-line row, routinely reaches
 * further down the page than its anchor — and half a callout looks as unfinished as half
 * a card. Rather than clamp to the viewport and quietly cut something anyway, a shot that
 * does not fit is an error naming the height it needed: the fix is that shot's viewport,
 * not a silently smaller picture.
 */
/**
 * No real person's name in a committed picture.
 *
 * Checked against the page's own text rather than the PNG, because a PNG's text is
 * compressed: a `strings` search over the file finds nothing and reads as a pass. The first
 * version of this guard did exactly that and missed a home-folder path that was in plain
 * sight in the image.
 */
async function assertNothingPersonal(page, name) {
  const real = [process.env.USER, process.env.LOGNAME, homedir()].filter(Boolean);
  const text = await page.evaluate(() => document.body.innerText);
  for (const needle of real) {
    if (text.includes(needle)) {
      const where = await page.evaluate((n) => {
        const hits = [];
        const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let t = walk.nextNode(); t; t = walk.nextNode()) {
          if (t.textContent.includes(n)) hits.push((t.parentElement?.id || t.parentElement?.className || t.parentElement?.tagName) + ' :: ' + t.textContent.trim().slice(0, 120));
        }
        return hits;
      }, needle);
      throw new Error(`${name}: the page shows "${needle}", which belongs to whoever ran this. Substitute it before the shot.\n  ` + where.join('\n  '));
    }
  }
}

async function shot(page, name, endAt) {
  await mkdir(OUT, { recursive: true });
  await showPath(page, SHOWN_PATH);
  // Settle first: a card that re-renders from its own fetch would otherwise put the real
  // path back between the sweep and the shutter.
  await page.waitForTimeout(150);
  await scrubPersonal(page);
  await assertNothingPersonal(page, name);
  let clip;
  if (endAt) {
    const box = await page.evaluate((sel) => {
      const bottoms = [document.querySelector(sel).getBoundingClientRect().bottom];
      // Every callout and ring. The arrows live in an SVG sized to the whole document,
      // so measuring that would ask for a picture the height of the page.
      for (const n of document.querySelectorAll('.__ann > div')) bottoms.push(n.getBoundingClientRect().bottom);
      return { needed: Math.ceil(Math.max(...bottoms)) + 8, viewport: window.innerHeight, width: window.innerWidth };
    }, endAt);
    if (box.needed > box.viewport) {
      throw new Error(`${name}: needs ${box.needed}px of viewport and has ${box.viewport}px. Raise the height for this shot.`);
    }
    clip = { x: 0, y: 0, width: box.width, height: box.needed };
  }
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: false, clip });
  process.stdout.write(`  docs/images/${name}.png\n`);
}

const main = async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'bw-shots-'));
  process.env.CARE_ALBUM_CONFIG_DIR = configDir;
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
  // Ends with step 1's card, whole. Letting the viewport decide sliced the step-2 card
  // below it in half and left its last line of text hard against the edge.
  await shot(page, '01-connect', '#card-connect');

  // 2 — connected, children listed. Connecting moves focus to Start saving, which scrolls
  // step 2 off the top; bring the tick and the children back into view first.
  await page.fill('#cookie', SESSION);
  await page.click('#btn-connect');
  // Once an archive exists the steps move into Settings, so a shot OF the steps opens it.
  await page.waitForSelector('.kid', { timeout: 10000, state: 'attached' });
  // ...but only when they are actually in there. Opening it otherwise puts an empty modal
  // over the very controls the next step is about to click.
  await page.evaluate(() => {
    const flow = document.getElementById('setup-flow');
    const body = document.getElementById('settings-body');
    const d = document.getElementById('dlg-settings');
    if (flow && body && flow.parentElement === body && d && !d.open) document.getElementById('btn-settings').click();
  });
  await page.waitForTimeout(200);
  await page.waitForTimeout(400);
  // Taller than the default, for two reasons that stack: step 1's first instruction is now
  // a link long enough to wrap, and the cookie-help disclosure sits under it. Everything
  // below starts lower than it used to.
  await page.setViewportSize({ width: VIEWPORT.width, height: 1280 });
  await page.evaluate(() => document.querySelector('#card-connect').scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(300);
  await annotate(page, [
    { selector: '#num-1', text: 'A green tick means this step is done.', offset: 0, side: 'left' },
    { selector: '#kids', text: 'Your children, read from your own account. Each one is a tick box — untick a child to leave their photos out.', offset: 0 },
  ]);
  // Ends just below the first option row rather than wherever the viewport happens to
  // fall: without this the picture sliced through "Keep the teacher's note".
  await shot(page, '02-connected', '#card-children .body > .opt');
  await page.setViewportSize(VIEWPORT);

  // 3 — the choices that matter, with one child unticked and the advanced drawer open.
  // Every change saves itself, so the shot also shows the quiet "Saved" confirmation.
  // The open drawer makes this card taller than the usual viewport.
  const saved = page.waitForResponse((r) => r.url().includes('/api/config'));
  await page.uncheck('#kid-1');
  await saved;
  await page.waitForFunction(() => document.querySelector('#config-msg')?.textContent === 'Saved', { timeout: 5000 });
  // Taller for the same reason as shot 2.
  await page.setViewportSize({ width: VIEWPORT.width, height: 1400 });
  // Opened for the picture so the whole of step 2 is visible at once. The folder field
  // itself is no longer in here — it sits in the open above this — so what the disclosure
  // still holds is the layout choice and the two rarely-changed switches.
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
  // Back to the shown path now that the run is over: the summary prints the folder a third
  // time beside its own button, and it is written only once a run finishes.
  await showPath(page, SHOWN_PATH);
  // The page is a different thing now, and this is the picture of that: once an archive
  // exists the four steps move into Settings and what is left is the answer to "is it
  // still working" — the photographs that arrived. So the shot reloads to pick up the new
  // view rather than screenshotting the form the run was started from.
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('#gallery a img', { timeout: 15000 });
  await page.waitForTimeout(400);
  await page.setViewportSize(VIEWPORT);
  await annotate(page, [
    // Both anchored in the body: a callout on the header row covered the second button,
    // which the overlap guard does not catch because it only compares callouts.
    { selector: '#dash-stats', text: 'How much is in the archive, and when it was last added to. Everything there is to change or check on is behind Settings, above.', offset: 0 },
    { selector: '#gallery', text: 'What the last run brought in. Each one opens the full picture from your own disk.', offset: 0, side: 'left' },
  ]);
  await shot(page, '04-done');
  // Belt and braces: the run must have written here and nowhere else.
  await access(join(PHOTOS, 'archive.json'));

  // 5 — dark mode, on the view a parent actually comes back to. Both schemes are
  // first-class, and this is also where the one-screen budget is spent.
  const dark = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 2, colorScheme: 'dark' });
  await dark.goto(ui.url, { waitUntil: 'networkidle' });
  await dark.waitForSelector('#gallery a img', { timeout: 15000 });
  await dark.waitForTimeout(700);
  await scrubPersonal(dark);
  await shot(dark, '05-dark');
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
