/**
 * The pictures for step 1 — finding the session value in a browser's developer tools.
 *
 * This is the hardest thing the tool asks of a parent, and the one place where written
 * instructions alone lose people: "press F12" means nothing to somebody who has never
 * seen a developer tools panel, and nothing in it says which of its six tabs is the one.
 *
 * Three decisions worth not relitigating:
 *
 *  - **Drawn, never captured.** A screenshot of a real cookie panel is a screenshot of
 *    somebody's real session, and this repository may never hold one (CLAUDE.md). So the
 *    panel is drawn, with an invented value in it — the same rule the guide screenshots
 *    follow by driving the mock server rather than a real account.
 *
 *  - **Inline SVG rather than images.** The page's Content-Security-Policy is
 *    `default-src 'none'; img-src 'self' data:`, so a picture in the page would have to be
 *    a `data:` URI, and seven screenshots as base64 is megabytes on a page that is 45 KB
 *    today. Drawn as SVG the whole set is a few kilobytes, stays sharp at any zoom,
 *    follows the page into dark mode and costs no second request.
 *    scripts/cookie-help-images.js renders these same drawings to docs/images/cookie-*.png
 *    for docs/COOKIE.md, so the page and the document cannot drift apart.
 *
 *  - **Labels in a keyed legend, not in the margins, and the legend is real text.** The
 *    guide screenshots put each callout in the page's own ~290px margin
 *    (scripts/screenshots.js explains why). These figures are 640 units wide inside a
 *    ~660px card: there is no margin to write into, so a numbered marker sits beside each
 *    target and the sentence for it goes in a legend underneath. Same rule, different
 *    geometry — a label never covers what it describes. The legend is HTML rather than
 *    more SVG because a drawing scales with its container and text drawn inside one
 *    scales with it: in a narrow window the sentences came out at five pixels. As text it
 *    reflows, obeys the reader's own font size, can be selected and translated, and says
 *    the same thing in docs/COOKIE.md, where it is a numbered list under the picture.
 */

/**
 * The value shown in the drawings. Deliberately not merely fake but *legibly* fake: the
 * first half decodes to "ExampleOnly-NotARealValue" and the second is all zeros, which no
 * real signature ever is. It keeps the real shape and roughly the real length, because
 * recognising "a long jumble of letters and numbers" is what the picture has to teach.
 */
export const EXAMPLE_COOKIE_VALUE = 'RXhhbXBsZU9ubHktTm90QVJlYWxWYWx1ZQ%3D%3D--0000000000000000';

/** As it appears in the Value column, cut off the way a real cookie panel cuts it off. */
const EXAMPLE_VALUE_SHOWN = 'RXhhbXBsZU9ubHktTm90QVJlYWxWYWx1ZQ%3D%3D--…';

/** The school in every drawing is Brightwheel's own address, so no nursery is named. */
const SITE = 'schools.mybrightwheel.com';

const W = 640;
const WIN = { x: 8, y: 8, w: 624, h: 292 };
/** The drawing ends a whisker below the window it draws; the legend lives outside it. */
const H = WIN.y + WIN.h + 8;

const xml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Legend sentences carry `*emphasis*` and `` `code` ``, because "click Application" with
 * nothing marked is a sentence a reader has to parse rather than scan. Escaped first and
 * marked up after, so a stray angle bracket in a sentence can never become an element.
 */
const richHtml = (s: string): string =>
  xml(s)
    .replace(/\*([^*]+)\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');

/** The same sentence as Markdown, for docs/COOKIE.md. */
export const legendMarkdown = (s: string): string =>
  s.replace(/\*([^*]+)\*/g, '**$1**');

interface TextOptions {
  x: number;
  y: number;
  s: string;
  size?: number;
  weight?: number;
  fill?: string;
  mono?: boolean;
  anchor?: 'start' | 'middle' | 'end';
  /** The width this text has to live in. The render script fails a figure that exceeds it. */
  max?: number;
}

const text = (o: TextOptions): string =>
  `<text x="${o.x}" y="${o.y}" font-size="${o.size ?? 11.5}"`
  + (o.weight ? ` font-weight="${o.weight}"` : '')
  + ` fill="${o.fill ?? 'var(--f-ink)'}"`
  + (o.mono ? ' font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"' : '')
  + (o.anchor ? ` text-anchor="${o.anchor}"` : '')
  + (o.max ? ` data-max="${o.max}"` : '')
  + `>${xml(o.s)}</text>`;

interface RectOptions {
  x: number; y: number; w: number; h: number;
  r?: number; fill?: string; stroke?: string;
}

const rect = (o: RectOptions): string =>
  `<rect x="${o.x}" y="${o.y}" width="${o.w}" height="${o.h}" rx="${o.r ?? 0}"`
  + ` fill="${o.fill ?? 'none'}"`
  + (o.stroke ? ` stroke="${o.stroke}" stroke-width="1"` : '')
  + '/>';

const line = (x1: number, y1: number, x2: number, y2: number): string =>
  `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="var(--f-line)" stroke-width="1"/>`;

/** The red outline that says "this thing". Same colour family as the guide screenshots. */
const ring = (x: number, y: number, w: number, h: number): string =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="7" fill="none" stroke="var(--f-mark)" stroke-width="2.5"/>`;

/**
 * The numbered marker that ties a ring to its legend line. Every one is placed by hand
 * into clear space beside its target rather than on top of it, and the render script
 * proves no marker's digit has landed on another label.
 */
const badge = (n: number, cx: number, cy: number): string =>
  `<circle cx="${cx}" cy="${cy}" r="9.5" fill="var(--f-mark)"/>`
  + text({ x: cx, y: cy + 4.2, s: String(n), size: 12, weight: 700, fill: 'var(--f-mark-ink)', anchor: 'middle' });

/** A legend line. `n` numbers it and matches a marker; without one it reads as an aside. */
export interface Legend { n?: number; s: string }

/** The legend as a list beside the drawing, with the markers repeated as badges. */
const legendHtml = (items: readonly Legend[]): string =>
  '<ul class="ck-legend">'
  + items.map((item) => `<li${item.n === undefined ? ' class="ck-aside"' : ''}>`
    + `<span class="ck-n">${item.n ?? '&mdash;'}</span><span>${richHtml(item.s)}</span></li>`).join('')
  + '</ul>';

export interface CookieFigure {
  /** File stem: the drawing is written to docs/images/cookie-<id>.png. */
  id: string;
  /** Which browser's section it belongs to. */
  browser: 'chrome' | 'safari' | 'firefox';
  /** The sentence under the picture, in the page and in docs/COOKIE.md alike. */
  caption: string;
  /** What somebody who cannot see the picture is told instead. Must stand on its own. */
  alt: string;
  /** The numbered steps the markers in the drawing point at. */
  legend: readonly Legend[];
  svg: string;
}

/** Everything about a figure except the drawing and the legend, which are built here. */
type FigureMeta = Omit<CookieFigure, 'svg' | 'legend'>;

const figure = (
  meta: FigureMeta,
  body: string,
  legend: readonly Legend[],
): CookieFigure => ({
  ...meta,
  legend,
  svg: `<svg class="ck-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${xml(meta.alt)}"`
    + ' xmlns="http://www.w3.org/2000/svg">'
    // Its own opaque background, so the drawing is self-contained: it keeps its palette
    // under forced colours, exactly as .num does, instead of flattening to two colours.
    + rect({ x: 0, y: 0, w: W, h: H, fill: 'var(--f-canvas)' })
    + `<g class="ck-ui">${body}</g></svg>`,
});

// ------------------------------------------------------------------ the panel drawing

/** Roughly how wide a string is at a given size in the page's sans stack. Layout only. */
const wide = (s: string, size = 11.5): number => s.length * size * 0.575;

/**
 * The tab strip along the top of a developer tools panel.
 *
 * The gap before the active tab is wider than the others on purpose: that gap is where
 * marker 1 goes, and a marker dropped into an ordinary 22px gap would sit on the
 * neighbouring tab's name. Leaving room for the annotation in the drawing is cheaper than
 * routing the annotation around the drawing.
 */
function tabStrip(
  tabs: readonly string[],
  active: string,
): { svg: string; ringAt: [number, number, number, number] } {
  let x = 22;
  let out = rect({ x: WIN.x + 1, y: WIN.y + 1, w: WIN.w - 2, h: 33, r: 9, fill: 'var(--f-chrome)' })
    + rect({ x: WIN.x + 1, y: WIN.y + 26, w: WIN.w - 2, h: 16, fill: 'var(--f-chrome)' })
    + line(WIN.x + 1, 42, WIN.x + WIN.w - 1, 42);
  let ringAt: [number, number, number, number] = [0, 0, 0, 0];
  for (const tab of tabs) {
    const isActive = tab === active;
    if (isActive) x += 8;
    const w = 14 + wide(tab);
    if (isActive) {
      out += rect({ x, y: 14, w, h: 24, r: 6, fill: 'var(--f-sel)' })
        + rect({ x: x + 4, y: 37.5, w: w - 8, h: 2.5, fill: 'var(--f-active)' });
      ringAt = [x - 4, 11, w + 8, 30];
    }
    out += text({
      x: x + w / 2, y: 30, s: tab, size: 11.5, weight: isActive ? 650 : 400,
      fill: isActive ? 'var(--f-ink)' : 'var(--f-dim)', anchor: 'middle', max: w,
    });
    x += w + 22;
  }
  return { svg: out, ringAt };
}

interface PanelOptions {
  tabs: readonly string[];
  /** The tab that holds the cookies — Application in Chrome, Storage in the other two. */
  active: string;
  /** Sidebar rows above the Cookies entry, drawn exactly as written. */
  sidebarLead: readonly string[];
}

/**
 * The developer tools panel with the cookie table in it: one tab strip, one sidebar, one
 * three-row table whose middle row is the one that matters.
 */
function panelFigure(
  meta: FigureMeta,
  o: PanelOptions,
  legend: readonly Legend[],
): CookieFigure {
  const strip = tabStrip(o.tabs, o.active);
  const SIDE = { x: WIN.x + 1, y: 42, w: 196 };

  let body = rect({ x: WIN.x, y: WIN.y, w: WIN.w, h: WIN.h, r: 10, fill: 'var(--f-panel)', stroke: 'var(--f-line)' })
    + strip.svg
    + rect({ x: SIDE.x, y: SIDE.y, w: SIDE.w, h: WIN.y + WIN.h - SIDE.y - 1, fill: 'var(--f-sunken)' })
    + line(SIDE.x + SIDE.w, SIDE.y, SIDE.x + SIDE.w, WIN.y + WIN.h - 1);

  // The sidebar. The lead rows are scene-setting; the last two are what ring 2 encloses.
  const rows = [...o.sidebarLead, '▾ Cookies', SITE];
  rows.forEach((label, i) => {
    const top = 52 + i * 26;
    const isSite = i === rows.length - 1;
    // The site row is set a size smaller than the rest: it is the longest string in the
    // sidebar and the only one that does not fit the column at the common size.
    const indent = i === 0 ? 12 : isSite ? 30 : 16;
    if (isSite) body += rect({ x: SIDE.x + 4, y: top + 2, w: SIDE.w - 10, h: 22, r: 5, fill: 'var(--f-sel)' });
    body += text({
      x: SIDE.x + indent, y: top + 17, s: label, size: isSite ? 10.5 : 11.5,
      weight: i === 0 ? 650 : isSite ? 550 : 400,
      fill: i === 0 ? 'var(--f-dim)' : 'var(--f-ink)',
      max: SIDE.w - indent - 8,
    });
  });
  const cookiesTop = 52 + o.sidebarLead.length * 26;
  body += ring(SIDE.x + 4, cookiesTop - 3, SIDE.w - 10, 56) + badge(2, SIDE.x + 178, cookiesTop - 3);

  // The table. Two columns only: Name and Value are the two words the legend uses, and a
  // Domain column nobody is told anything about is one more thing to wonder about.
  const TAB = { x: SIDE.x + SIDE.w + 1, y: 42 };
  const right = WIN.x + WIN.w - 1;
  const nameX = TAB.x + 11;
  const valX = TAB.x + 135;
  body += rect({ x: TAB.x, y: TAB.y, w: right - TAB.x, h: 28, fill: 'var(--f-chrome)' })
    + line(TAB.x, TAB.y + 28, right, TAB.y + 28)
    + line(valX - 8, TAB.y, valX - 8, WIN.y + WIN.h - 1)
    + text({ x: nameX, y: TAB.y + 19, s: 'Name', size: 11, weight: 650, fill: 'var(--f-dim)', max: 110 })
    + text({ x: valX, y: TAB.y + 19, s: 'Value', size: 11, weight: 650, fill: 'var(--f-dim)', max: 240 });

  // Five rows, not two. A parent's real cookie list is a wall of names they have never
  // heard of, and the skill the picture teaches is picking one out of a crowd, so the row
  // that matters is neither the first nor the last and has strangers either side of it.
  const cells: Array<[string, string]> = [
    ['_ga', 'GA1.2.0000000000.0000000000'],
    ['_brightwheel_v2', EXAMPLE_VALUE_SHOWN],
    ['intercom-session', 'bm90LWEtcmVhbC1jb29raWU%3D'],
    ['_gid', 'GA1.2.0000000000.0000000000'],
    ['ajs_anonymous_id', '00000000-0000-0000-0000-000000000000'],
  ];
  cells.forEach(([name, value], i) => {
    const top = TAB.y + 28 + i * 30;
    const target = i === 1;
    if (target) {
      body += rect({ x: TAB.x, y: top, w: right - TAB.x, h: 30, fill: 'var(--f-row)' })
        + rect({ x: valX - 4, y: top + 5, w: 258, h: 20, r: 4, fill: 'var(--f-sel)' });
    }
    body += text({
      x: nameX, y: top + 19.5, s: name, size: 10.5, mono: true,
      weight: target ? 700 : 400, fill: target ? 'var(--f-ink)' : 'var(--f-dim)', max: 118,
    })
      + text({
        x: valX, y: top + 19.5, s: value, size: 9.5, mono: true,
        fill: target ? 'var(--f-ink)' : 'var(--f-dim)', max: 250,
      });
    if (target) body += ring(TAB.x + 4, top - 2, right - TAB.x - 8, 34) + badge(3, right - 19, top + 15);
  });

  body += ring(...strip.ringAt) + badge(1, strip.ringAt[0] - 15, 26);
  return figure(meta, body, legend);
}

// ---------------------------------------------------------------- the window drawings

/** A browser window with its own menu hanging open: "open the developer tools". */
function menuFigure(
  meta: FigureMeta,
  o: { buttonGlyph: 'dots' | 'burger'; items: readonly string[]; target: string },
  legend: readonly Legend[],
): CookieFigure {
  // The button lives on the toolbar row beside the address bar, where both browsers put
  // it, and the menu drops below that row. Drawn any higher the menu covered the address
  // bar, which is the one thing in the picture saying "do this on the Brightwheel tab".
  const BTN = { x: 588, y: 52, w: 28, h: 28 };
  let body = rect({ x: WIN.x, y: WIN.y, w: WIN.w, h: WIN.h, r: 10, fill: 'var(--f-panel)', stroke: 'var(--f-line)' })
    + rect({ x: WIN.x + 1, y: WIN.y + 1, w: WIN.w - 2, h: 33, r: 9, fill: 'var(--f-chrome)' })
    + rect({ x: WIN.x + 1, y: WIN.y + 18, w: WIN.w - 2, h: 68, fill: 'var(--f-chrome)' })
    + line(WIN.x + 1, 86, WIN.x + WIN.w - 1, 86)
    // One tab, so the drawing reads as a browser and not as a dialog box.
    + rect({ x: 22, y: 13, w: 168, h: 28, r: 7, fill: 'var(--f-panel)', stroke: 'var(--f-line)' })
    + text({ x: 36, y: 32, s: 'Brightwheel', size: 11, fill: 'var(--f-dim)', max: 140 })
    + text({ x: 206, y: 32, s: '+', size: 14, fill: 'var(--f-dim)' })
    // The address bar, so it is plain that this is the Brightwheel tab and not another.
    + rect({ x: 22, y: 52, w: 500, h: 28, r: 14, fill: 'var(--f-sunken)', stroke: 'var(--f-line)' })
    + text({ x: 40, y: 70, s: SITE, size: 11.5, fill: 'var(--f-dim)', max: 300 })
    // A suggestion of a web page, kept to the top left so every marker has clear space.
    + rect({ x: 22, y: 102, w: 210, h: 13, r: 4, fill: 'var(--f-sunken)' })
    + rect({ x: 22, y: 126, w: 300, h: 9, r: 4, fill: 'var(--f-sunken)' })
    + rect({ x: 22, y: 144, w: 262, h: 9, r: 4, fill: 'var(--f-sunken)' });

  body += rect({ x: BTN.x, y: BTN.y, w: BTN.w, h: BTN.h, r: 7, fill: 'var(--f-sunken)' });
  if (o.buttonGlyph === 'dots') {
    for (const cy of [59, 66, 73]) body += `<circle cx="${BTN.x + 14}" cy="${cy}" r="2" fill="var(--f-dim)"/>`;
  } else {
    for (const y of [59, 65, 71]) body += rect({ x: BTN.x + 7, y, w: 14, h: 2, r: 1, fill: 'var(--f-dim)' });
  }
  body += ring(BTN.x - 4, BTN.y - 4, BTN.w + 8, BTN.h + 8) + badge(1, BTN.x - 22, BTN.y + 14);

  // The menu, anchored under the button as a real one is, with its rows 30 apart.
  const MENU = { x: 400, y: 90, w: 224 };
  body += rect({
    x: MENU.x, y: MENU.y, w: MENU.w, h: 12 + o.items.length * 30, r: 10,
    fill: 'var(--f-panel)', stroke: 'var(--f-line)',
  });
  o.items.forEach((item, i) => {
    const top = MENU.y + 6 + i * 30;
    const isTarget = item === o.target;
    if (isTarget) body += rect({ x: MENU.x + 5, y: top, w: MENU.w - 10, h: 30, r: 6, fill: 'var(--f-sel)' });
    body += text({
      x: MENU.x + 18, y: top + 20, s: item, size: 11.5,
      weight: isTarget ? 650 : 400, fill: isTarget ? 'var(--f-ink)' : 'var(--f-dim)', max: MENU.w - 46,
    });
    if (isTarget) {
      body += text({ x: MENU.x + MENU.w - 16, y: top + 20, s: '▸', size: 11, fill: 'var(--f-dim)', anchor: 'end' })
        + ring(MENU.x + 3, top - 2, MENU.w - 6, 34) + badge(2, MENU.x - 18, top + 15);
    }
  });
  return figure(meta, body, legend);
}

/** The Mac menu bar with Safari's Develop menu hanging open. */
function developMenuFigure(meta: FigureMeta, legend: readonly Legend[]): CookieFigure {
  const names = ['Safari', 'File', 'Edit', 'View', 'History', 'Bookmarks', 'Develop', 'Window', 'Help'];
  let body = rect({ x: WIN.x, y: WIN.y, w: WIN.w, h: WIN.h, r: 10, fill: 'var(--f-sunken)', stroke: 'var(--f-line)' })
    + rect({ x: WIN.x + 1, y: WIN.y + 1, w: WIN.w - 2, h: 33, r: 9, fill: 'var(--f-chrome)' })
    + rect({ x: WIN.x + 1, y: WIN.y + 24, w: WIN.w - 2, h: 10, fill: 'var(--f-chrome)' })
    + line(WIN.x + 1, 34, WIN.x + WIN.w - 1, 34)
    // A Safari window below the bar, so it is clear the menu bar is above the window and
    // not part of it — the thing a Windows user gets wrong about a Mac every time.
    + rect({ x: 40, y: 62, w: 320, h: 200, r: 10, fill: 'var(--f-panel)', stroke: 'var(--f-line)' })
    + rect({ x: 41, y: 63, w: 318, h: 26, r: 9, fill: 'var(--f-chrome)' })
    + rect({ x: 41, y: 80, w: 318, h: 9, fill: 'var(--f-chrome)' })
    + text({ x: 56, y: 81, s: 'Brightwheel', size: 10, fill: 'var(--f-dim)', max: 120 })
    + rect({ x: 56, y: 106, w: 220, h: 11, r: 4, fill: 'var(--f-sunken)' })
    + rect({ x: 56, y: 128, w: 260, h: 8, r: 4, fill: 'var(--f-sunken)' })
    + rect({ x: 56, y: 146, w: 198, h: 8, r: 4, fill: 'var(--f-sunken)' });

  let x = 24;
  let developX = 0;
  let developW = 0;
  for (const name of names) {
    const w = wide(name);
    const isDevelop = name === 'Develop';
    body += text({
      x, y: 27, s: name, size: 11.5,
      weight: name === 'Safari' ? 700 : isDevelop ? 650 : 400,
      fill: isDevelop ? 'var(--f-ink)' : 'var(--f-dim)', max: w + 4,
    });
    if (isDevelop) { developX = x; developW = w; }
    // Extra room after Develop: marker 1 goes in that gap rather than on top of "Window".
    x += w + (isDevelop ? 48 : 26);
  }
  body += ring(developX - 7, 10, developW + 14, 24) + badge(1, developX + developW + 23, 22);

  const MENU = { x: 395, y: 46, w: 232 };
  const items = ['Open Page With', 'User Agent', 'Show Web Inspector', 'Show JavaScript Console', 'Show Page Source'];
  body += rect({
    x: MENU.x, y: MENU.y, w: MENU.w, h: 12 + items.length * 30, r: 10,
    fill: 'var(--f-panel)', stroke: 'var(--f-line)',
  });
  items.forEach((item, i) => {
    const top = MENU.y + 6 + i * 30;
    const isTarget = item === 'Show Web Inspector';
    if (isTarget) body += rect({ x: MENU.x + 5, y: top, w: MENU.w - 10, h: 30, r: 6, fill: 'var(--f-sel)' });
    body += text({
      x: MENU.x + 18, y: top + 20, s: item, size: 11.5, weight: isTarget ? 650 : 400,
      fill: isTarget ? 'var(--f-ink)' : 'var(--f-dim)', max: 150,
    });
    if (i < 2) {
      body += text({ x: MENU.x + MENU.w - 16, y: top + 20, s: '▸', size: 11, fill: 'var(--f-dim)', anchor: 'end' });
    }
    if (isTarget) {
      body += text({ x: MENU.x + MENU.w - 16, y: top + 20, s: '⌥⌘I', size: 11, fill: 'var(--f-dim)', anchor: 'end' })
        + ring(MENU.x + 3, top - 2, MENU.w - 6, 34) + badge(2, MENU.x - 18, top + 15);
    }
  });
  return figure(meta, body, legend);
}

/** Safari's Settings window, on the Advanced tab, with the one tick box that matters. */
function safariSettingsFigure(meta: FigureMeta, legend: readonly Legend[]): CookieFigure {
  const DLG = { x: 64, y: 8, w: 512, h: 292 };
  let body = rect({ x: DLG.x, y: DLG.y, w: DLG.w, h: DLG.h, r: 10, fill: 'var(--f-panel)', stroke: 'var(--f-line)' })
    + rect({ x: DLG.x + 1, y: DLG.y + 1, w: DLG.w - 2, h: 33, r: 9, fill: 'var(--f-chrome)' })
    + rect({ x: DLG.x + 1, y: DLG.y + 24, w: DLG.w - 2, h: 10, fill: 'var(--f-chrome)' })
    + text({ x: DLG.x + 24, y: 27, s: 'Settings', size: 11.5, weight: 650, fill: 'var(--f-dim)', max: 60 });

  const tabs = ['General', 'Tabs', 'AutoFill', 'Passwords', 'Search', 'Security', 'Privacy', 'Advanced'];
  // The strip is inset from the dialog's edges, so the ring around the last tab has room
  // to breathe rather than sitting on the window border.
  const INSET = 14;
  const slot = (DLG.w - INSET * 2) / tabs.length;
  const tabX = (i: number): number => DLG.x + INSET + slot * i;
  tabs.forEach((tab, i) => {
    const isActive = tab === 'Advanced';
    if (isActive) body += rect({ x: tabX(i) + 4, y: 44, w: slot - 8, h: 30, r: 6, fill: 'var(--f-sel)' });
    body += text({
      x: tabX(i) + slot / 2, y: 63, s: tab, size: 9.5, weight: isActive ? 650 : 400,
      fill: isActive ? 'var(--f-ink)' : 'var(--f-dim)', anchor: 'middle', max: slot - 6,
    });
  });
  body += ring(tabX(7) + 2, 42, slot - 4, 34) + badge(1, tabX(7) + slot / 2, 24)
    + line(DLG.x + 1, 82, DLG.x + DLG.w - 1, 82);

  const options = [
    'Show full website address',
    'Never use font sizes smaller than 9',
    'Press Tab to highlight each item on a webpage',
    'Save articles for offline reading automatically',
    'Show features for web developers',
  ];
  options.forEach((option, i) => {
    const top = 104 + i * 38;
    const isTarget = i === options.length - 1;
    body += rect({
      x: DLG.x + 32, y: top, w: 17, h: 17, r: 4,
      fill: isTarget ? 'var(--f-active)' : 'var(--f-panel)', stroke: 'var(--f-line)',
    });
    if (isTarget) {
      body += `<path d="M ${DLG.x + 36} ${top + 8.5} l 3.6 4 l 6.2 -7.6" fill="none" stroke="#ffffff"`
        + ' stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>';
    }
    body += text({
      x: DLG.x + 60, y: top + 13, s: option, size: 11.5,
      weight: isTarget ? 650 : 400, fill: isTarget ? 'var(--f-ink)' : 'var(--f-dim)', max: 330,
    });
    if (isTarget) body += ring(DLG.x + 24, top - 7, 376, 31) + badge(2, DLG.x + 420, top + 8);
  });
  return figure(meta, body, legend);
}

// ------------------------------------------------------------------------ the figures

/** The same closing aside on all three cookie tables, because it is the same mistake. */
const COPY_TIP: Legend = { s: 'The value is long. Click it, select all of it, then copy.' };

export const COOKIE_FIGURES: readonly CookieFigure[] = [
  menuFigure(
    {
      id: 'chrome-1-open',
      browser: 'chrome',
      caption: 'Opening the developer tools in Chrome or Edge.',
      alt: 'A drawing of a Chrome window showing schools.mybrightwheel.com. The three-dot button at '
        + 'the top right is marked 1, and the menu hanging open below it has More tools marked 2.',
    },
    {
      buttonGlyph: 'dots',
      items: ['New tab', 'History', 'Downloads', 'Bookmarks', 'More tools', 'Settings'],
      target: 'More tools',
    },
    [
      { n: 1, s: 'On the Brightwheel tab, click the three dots at the top right.' },
      { n: 2, s: 'Point at *More tools*, then click *Developer tools* in the list that opens.' },
      { s: 'Quicker: press F12, or Option + Cmd + I on a Mac. A panel appears.' },
    ],
  ),
  panelFigure(
    {
      id: 'chrome-2-cookie',
      browser: 'chrome',
      caption: 'Finding the value in Chrome or Edge.',
      alt: 'A drawing of the Chrome developer tools. The Application tab along the top is marked 1; '
        + 'Cookies and the schools.mybrightwheel.com entry under it in the left-hand list are marked '
        + '2; and in the table on the right the row named _brightwheel_v2 is marked 3, with a long '
        + 'invented value highlighted in its Value column.',
    },
    {
      tabs: ['Elements', 'Console', 'Sources', 'Network', 'Application'],
      active: 'Application',
      sidebarLead: ['Storage', '▸ Local Storage', '▸ Session Storage'],
    },
    [
      { n: 1, s: 'Click *Application* along the top of the new panel.' },
      { n: 2, s: 'Click *Cookies* on the left, then your school’s address underneath it.' },
      { n: 3, s: 'Find the row named `_brightwheel_v2` and copy what is in its *Value* column.' },
      COPY_TIP,
    ],
  ),
  safariSettingsFigure(
    {
      id: 'safari-1-enable',
      browser: 'safari',
      caption: 'Safari hides the developer tools until you turn them on.',
      alt: 'A drawing of Safari’s Settings window. The Advanced tab along the top is marked 1, '
        + 'and the ticked box labelled Show features for web developers is marked 2.',
    },
    [
      { n: 1, s: 'Safari menu → *Settings* → the *Advanced* tab.' },
      { n: 2, s: 'Tick *Show features for web developers*, then close Settings.' },
      { s: 'A new *Develop* menu appears in the bar at the very top of your screen.' },
    ],
  ),
  developMenuFigure(
    {
      id: 'safari-2-open',
      browser: 'safari',
      caption: 'Opening the Web Inspector in Safari.',
      alt: 'A drawing of the menu bar at the top of a Mac screen. The Develop menu is marked 1, and '
        + 'in the menu hanging open below it Show Web Inspector is marked 2.',
    },
    [
      { n: 1, s: 'Click *Develop* in the bar at the very top of your screen.' },
      { n: 2, s: 'Choose *Show Web Inspector*. A panel appears inside the window.' },
      { s: 'Quicker: press Option + Cmd + I.' },
    ],
  ),
  panelFigure(
    {
      id: 'safari-3-cookie',
      browser: 'safari',
      caption: 'Finding the value in Safari.',
      alt: 'A drawing of Safari’s Web Inspector. The Storage tab along the top is marked 1; '
        + 'Cookies and the schools.mybrightwheel.com entry under it in the left-hand list are marked '
        + '2; and in the table on the right the row named _brightwheel_v2 is marked 3, with a long '
        + 'invented value highlighted in its Value column.',
    },
    {
      tabs: ['Elements', 'Network', 'Sources', 'Timelines', 'Storage', 'Console'],
      active: 'Storage',
      sidebarLead: ['Storage', '▸ Local Storage', '▸ Session Storage'],
    },
    [
      { n: 1, s: 'Click *Storage* along the top — Safari calls it that, not Application.' },
      { n: 2, s: 'Click *Cookies* on the left, then your school’s address underneath it.' },
      { n: 3, s: 'Find the row named `_brightwheel_v2` and copy what is in its *Value* column.' },
      COPY_TIP,
    ],
  ),
  menuFigure(
    {
      id: 'firefox-1-open',
      browser: 'firefox',
      caption: 'Opening the developer tools in Firefox.',
      alt: 'A drawing of a Firefox window showing schools.mybrightwheel.com. The three-line menu '
        + 'button at the top right is marked 1, and the menu hanging open below it has More tools '
        + 'marked 2.',
    },
    {
      buttonGlyph: 'burger',
      items: ['New tab', 'New window', 'Bookmarks', 'History', 'More tools', 'Settings'],
      target: 'More tools',
    },
    [
      { n: 1, s: 'On the Brightwheel tab, click the three lines at the top right.' },
      { n: 2, s: 'Point at *More tools*, then click *Web Developer Tools*.' },
      { s: 'Quicker: press F12, or Option + Cmd + I on a Mac.' },
    ],
  ),
  panelFigure(
    {
      id: 'firefox-2-cookie',
      browser: 'firefox',
      caption: 'Finding the value in Firefox.',
      alt: 'A drawing of the Firefox developer tools. The Storage tab along the top is marked 1; '
        + 'Cookies and the schools.mybrightwheel.com entry under it in the left-hand list are marked '
        + '2; and in the table on the right the row named _brightwheel_v2 is marked 3, with a long '
        + 'invented value highlighted in its Value column.',
    },
    {
      tabs: ['Inspector', 'Console', 'Debugger', 'Network', 'Storage'],
      active: 'Storage',
      sidebarLead: ['Storage', '▸ Cache Storage', '▸ Local Storage'],
    },
    [
      { n: 1, s: 'Click *Storage* along the top — Firefox calls it that, not Application.' },
      { n: 2, s: 'Click *Cookies* on the left, then your school’s address underneath it.' },
      { n: 3, s: 'Find the row named `_brightwheel_v2` and copy what is in its *Value* column.' },
      COPY_TIP,
    ],
  ),
];

/** The three sets, in the order the page falls back to when it cannot tell the browser. */
export const COOKIE_BROWSERS: ReadonlyArray<{ key: CookieFigure['browser']; name: string }> = [
  { key: 'chrome', name: 'Chrome or Edge' },
  { key: 'safari', name: 'Safari' },
  { key: 'firefox', name: 'Firefox' },
];

/**
 * The palette the drawings are painted from, as a CSS rule.
 *
 * Exported because scripts/cookie-help-images.js paints the very same SVGs into PNGs for
 * docs/COOKIE.md: one definition, so a colour changed for the page cannot leave the
 * pictures in the document looking like a different product. The light values imitate a
 * developer tools panel in a light theme, the dark ones in a dark theme, so the figure
 * belongs to whichever the reader is in.
 */
export const COOKIE_FIGURE_CSS = `
  .ck-panel {
    --f-canvas: var(--surface-sunken);
    --f-panel: #ffffff; --f-chrome: #f1f3f4; --f-sunken: #f7f8fa; --f-line: #ccd3dc;
    --f-ink: #1f2328; --f-dim: #55606e; --f-sel: #dbe8fd; --f-row: #eef4ff;
    --f-active: #1558c0; --f-mark: #c3351c; --f-mark-ink: #ffffff;
  }
  @media (prefers-color-scheme: dark) {
    .ck-panel {
      --f-panel: #1d2128; --f-chrome: #2a2f38; --f-sunken: #232832; --f-line: #3f4754;
      --f-ink: #e8ebf1; --f-dim: #a7b1c0; --f-sel: #26406b; --f-row: #1f2a3d;
      --f-active: #8ab4f8; --f-mark: #ff7a5c; --f-mark-ink: #1a1a1a;
    }
  }`;

/**
 * The picture guide's styles, for the page's one stylesheet.
 *
 * Kept here rather than written into the page's `<style>` block so that the whole feature
 * — palette, markup, behaviour — reads in one file. It goes into that one block all the
 * same, and the behaviour into that one script, because the page has exactly one of each
 * on purpose: a `<style>` in the body is not conforming HTML, and a second `<script>`
 * would slip past the test that compiles the page's script to prove it parses.
 */
export const COOKIE_HELP_CSS = `${COOKIE_FIGURE_CSS}
  .ck-help { margin: 0 0 var(--s4); }
  .ck-toggle {
    display: inline-flex; align-items: center; gap: var(--s2);
    background: var(--surface-sunken); color: var(--accent-ink);
    border: 1px solid var(--border-strong); border-radius: var(--radius-sm);
    padding: var(--s2) var(--s4); font: 550 .9375rem/1.4 inherit;
    cursor: pointer; min-height: 2.75rem;
  }
  .ck-toggle:hover { background: var(--border); }
  .ck-caret { display: inline-block; transition: transform .15s; }
  .ck-toggle[aria-expanded="true"] .ck-caret { transform: rotate(90deg); }
  .ck-panel {
    margin-top: var(--s3); padding: var(--s4);
    background: var(--surface-sunken); border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
  .ck-panel[hidden] { display: none; }
  .ck-note { margin: 0 0 var(--s4); font-size: .875rem; color: var(--text-muted); }
  .ck-browser + .ck-browser { margin-top: var(--s5); border-top: 1px solid var(--border); padding-top: var(--s4); }
  .ck-browser h3 { font-size: 1rem; font-weight: 650; margin: 0 0 var(--s3); }
  .ck-fig { margin: 0 0 var(--s5); }
  .ck-fig:last-child { margin-bottom: 0; }
  .ck-cap { display: block; margin-top: var(--s2); font-size: .875rem; color: var(--text-muted); }
  .ck-legend { list-style: none; margin: var(--s3) 0 0; padding: 0; }
  .ck-legend li { display: flex; align-items: flex-start; gap: var(--s2); margin-bottom: var(--s2); font-size: .9375rem; color: var(--text); }
  .ck-legend li:last-child { margin-bottom: 0; }
  /* The badge repeats the marker drawn on the picture, so the sentence and the thing it
     points at are tied together by a number and not only by their order on the page. */
  .ck-n {
    flex: 0 0 auto; display: grid; place-items: center;
    width: 1.375rem; height: 1.375rem; margin-top: .0625rem; border-radius: 50%;
    background: var(--f-mark); color: var(--f-mark-ink);
    font-size: .8125rem; font-weight: 700;
  }
  .ck-aside { color: var(--text-muted); }
  .ck-aside .ck-n { background: none; color: var(--text-muted); font-weight: 400; }
  /* Keep its own palette when the system forces colours, exactly as .num does: the drawing
     paints its own background, so it stays legible instead of flattening to two colours. */
  @media (forced-colors: active) { .ck-svg { forced-color-adjust: none; } }
  .ck-svg { display: block; width: 100%; height: auto; border-radius: var(--radius-sm); }`;

/**
 * The picture guide itself, dropped into step 1 between the written steps and the box.
 *
 * It is a button and a region rather than `<details>`, which would have been the obvious
 * control: both the page's own script and scripts/screenshots.js reach for
 * `document.querySelector('details')` meaning step 2's Advanced options, and a `<details>`
 * added here would silently become the one they find.
 */
export const COOKIE_HELP = `<div class="ck-help">
  <button type="button" class="ck-toggle" id="ck-toggle" aria-expanded="false" aria-controls="ck-panel">
    <span class="ck-caret" aria-hidden="true">&#9656;</span>
    <span id="ck-toggle-text">Show me pictures of these steps</span>
  </button>
  <div class="ck-panel" id="ck-panel" hidden>
    <p class="ck-note">
      These are drawings of what a browser looks like, not photographs of anyone&rsquo;s
      account. The value in them is invented. The written steps above are enough on their
      own &mdash; the pictures are here in case they are not.
    </p>
    ${COOKIE_BROWSERS.map((b) => `<section class="ck-browser" id="ck-${b.key}" aria-labelledby="ck-${b.key}-h">
      <h3 id="ck-${b.key}-h">${b.name}</h3>
      ${COOKIE_FIGURES.filter((f) => f.browser === b.key).map((f) => `<figure class="ck-fig">
        ${f.svg}
        <figcaption>
          <span class="ck-cap">${xml(f.caption)}</span>
          ${legendHtml(f.legend)}
        </figcaption>
      </figure>`).join('\n      ')}
    </section>`).join('\n    ')}
  </div>
</div>`;

/** The picture guide's behaviour, for the page's one script. */
export const COOKIE_HELP_SCRIPT = `
(function () {
  var btn = document.getElementById('ck-toggle');
  var panel = document.getElementById('ck-panel');
  var label = document.getElementById('ck-toggle-text');
  btn.addEventListener('click', function () {
    var open = btn.getAttribute('aria-expanded') === 'true';
    btn.setAttribute('aria-expanded', open ? 'false' : 'true');
    panel.hidden = open;
    label.textContent = open ? 'Show me pictures of these steps' : 'Hide the pictures';
  });

  // The reader's own browser goes first, so the right pictures are the ones in front of
  // them. The other two stay on the page rather than being hidden: somebody who uses
  // Chrome at work and Safari at home should not have to guess that the page has decided
  // for them. Deliberately the same test as howToSteps() just above — change both.
  var ua = navigator.userAgent;
  var key = /Firefox\\//.test(ua)
    ? 'firefox'
    : (/Safari\\//.test(ua) && !/Chrome|Chromium|Edg\\//.test(ua)) ? 'safari' : 'chrome';
  var mine = document.getElementById('ck-' + key);
  var first = panel.querySelector('.ck-browser');
  if (mine && first && mine !== first) panel.insertBefore(mine, first);
  var heading = document.getElementById('ck-' + key + '-h');
  if (heading) heading.textContent += ' \\u2014 what you are reading this in';
})();`;
