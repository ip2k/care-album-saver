/**
 * The setup assistant page.
 *
 * One self-contained file: no bundler, no framework, no CDN, no web fonts. Every byte is
 * served from this process, which is what lets the Content-Security-Policy forbid all
 * external origins. For a tool that handles children's photos, "this page cannot load
 * anything from the internet" is worth more than any convenience a framework would buy.
 *
 * Design notes, with sources:
 *
 *  - Colour is never the only carrier of meaning. Step completion is announced to assistive
 *    technology via aria-current and a visually-hidden status, not just a green border
 *    (WCAG 1.4.1, and HIG /design/human-interface-guidelines/accessibility).
 *  - Contrast: every foreground/background pair here is computed to meet 4.5:1 for text and
 *    3:1 for control boundaries. The HIG asks for 4.5:1 minimum and "strive for 7:1,
 *    especially in small text" (/design/human-interface-guidelines/color).
 *  - Targets are at least 24x24 CSS px (WCAG 2.5.8); interactive rows are larger still,
 *    toward the HIG's 44pt guidance (/design/human-interface-guidelines/accessibility).
 *  - Progress is honest. When the total is unknown the indicator is indeterminate rather
 *    than a bar that invents a percentage
 *    (/design/human-interface-guidelines/progress-indicators).
 *  - Light and dark are both first-class, via prefers-color-scheme
 *    (/design/human-interface-guidelines/dark-mode).
 *  - Motion respects prefers-reduced-motion (/design/human-interface-guidelines/motion).
 *  - What is on screen is what runs. Every setting saves itself the moment it changes, and
 *    "Start saving" sends the whole form again before it starts. A tick that was visible
 *    but not yet stored used to be silently ignored, because the run reads settings from
 *    disk (/design/human-interface-guidelines/feedback).
 */
export const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Brightwheel Archive - Setup</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f4f6fa;
    --surface: #ffffff;
    --surface-sunken: #eef1f6;
    --text: #171c26;
    --text-muted: #55617a;
    --border: #d8dee9;
    --border-strong: #7f8ca3;
    --accent: #1f5ddb;
    --accent-hover: #17489f;
    --accent-text: #ffffff;
    --accent-tint: #e9f0fe;
    --accent-ink: #1a4bb0;
    --ok: #0f6b42;
    --ok-tint: #e4f4ec;
    --warn: #7c4a06;
    --warn-tint: #fcf1de;
    --danger: #a3141b;
    --danger-tint: #fdeaea;
    --focus: #1f5ddb;
    --radius: 12px;
    --radius-sm: 8px;
    --s1: 4px; --s2: 8px; --s3: 12px; --s4: 16px; --s5: 24px; --s6: 32px; --s7: 48px;
    --shadow: 0 1px 2px rgba(16, 24, 40, .05);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #12151c;
      --surface: #1a1f29;
      --surface-sunken: #232935;
      --text: #eef1f6;
      --text-muted: #a8b3c7;
      --border: #333c4b;
      --border-strong: #63708a;
      --accent: #74a4ff;
      --accent-hover: #9abaff;
      --accent-text: #0d1220;
      --accent-tint: #1d2839;
      --accent-ink: #a9c5ff;
      --ok: #5ddba0;
      --ok-tint: #16281f;
      --warn: #f0be71;
      --warn-tint: #2a2115;
      --danger: #ff9b9b;
      --danger-tint: #2c1718;
      --focus: #9abaff;
      --shadow: 0 1px 2px rgba(0, 0, 0, .4);
    }
  }

  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font: 1rem/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  }

  /* Visible only to assistive technology. Carries the meaning that colour alone would. */
  .sr-only {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
  }

  /* Off-canvas until focused. A negative top offset alone is not enough: the element is
     taller than the offset, so its lower edge stays visible at the top of the page. */
  .skip {
    position: absolute; left: var(--s4); top: var(--s4); z-index: 10;
    background: var(--surface); color: var(--text); padding: var(--s3) var(--s4);
    border-radius: var(--radius-sm); border: 2px solid var(--focus);
    transform: translateY(-250%);
    transition: transform .15s;
  }
  .skip:focus { transform: translateY(0); }

  .wrap { max-width: 47rem; margin: 0 auto; padding: var(--s7) var(--s5) 5rem; }

  header { margin-bottom: var(--s6); }
  h1 { font-size: 1.875rem; line-height: 1.25; margin: 0 0 var(--s2); letter-spacing: -.02em; font-weight: 650; }
  .lede { color: var(--text-muted); margin: 0; font-size: 1.0625rem; max-width: 38rem; }

  ol.steps-list { list-style: none; margin: 0; padding: 0; }

  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: var(--s5) var(--s5) var(--s5);
    margin-bottom: var(--s4);
    box-shadow: var(--shadow);
  }
  .card[data-state="complete"] { border-color: var(--ok); }
  .card[data-state="active"] { border-color: var(--accent); }

  .step-head { display: flex; align-items: center; gap: var(--s3); margin-bottom: var(--s2); }
  .num {
    flex: 0 0 auto; width: 2rem; height: 2rem; border-radius: 50%;
    background: var(--surface-sunken); color: var(--text-muted);
    border: 1px solid var(--border);
    font-weight: 650; font-size: .9375rem;
    display: grid; place-items: center;
  }
  .card[data-state="active"] .num { background: var(--accent); color: var(--accent-text); border-color: var(--accent); }
  .card[data-state="complete"] .num { background: var(--ok); color: var(--surface); border-color: var(--ok); }
  h2 { font-size: 1.1875rem; margin: 0; letter-spacing: -.01em; font-weight: 640; }

  .hint { color: var(--text-muted); font-size: .9375rem; margin: var(--s2) 0 var(--s4) 2.75rem; max-width: 34rem; }
  .body { margin-left: 2.75rem; }
  @media (max-width: 34rem) {
    .hint, .body { margin-left: 0; }
    .wrap { padding: var(--s5) var(--s4) 4rem; }
  }

  ol.howto { margin: 0 0 var(--s4); padding-left: 1.25rem; color: var(--text-muted); font-size: .9375rem; }
  ol.howto li { margin-bottom: var(--s2); padding-left: var(--s1); }
  kbd, code {
    background: var(--surface-sunken); padding: .125rem .4rem; border-radius: 5px;
    font-size: .8125rem; color: var(--text);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    border: 1px solid var(--border);
  }

  /* The reason for the ask sits directly above the input it justifies, per HIG privacy
     guidance, rather than in a panel below the fold nobody scrolls to. */
  .why-ask {
    background: var(--accent-tint); border: 1px solid var(--border);
    border-radius: var(--radius-sm); padding: var(--s3) var(--s4);
    margin: 0 0 var(--s4); font-size: .9375rem; color: var(--text);
  }
  .field { margin-bottom: var(--s4); }
  label.field-label { display: block; font-size: .9375rem; font-weight: 550; margin-bottom: var(--s2); }
  textarea, input[type=text], input[type=email], input[type=password], select {
    width: 100%; padding: .6875rem .8125rem;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    font: .9375rem/1.5 inherit;
    background: var(--surface); color: var(--text);
    min-height: 2.75rem;
  }
  textarea { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; resize: vertical; }
  [aria-invalid="true"] { border-color: var(--danger); border-width: 2px; }

  :focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; border-radius: 4px; }
  :focus:not(:focus-visible) { outline: none; }

  button {
    background: var(--accent); color: var(--accent-text);
    border: 1px solid transparent; border-radius: var(--radius-sm);
    padding: .6875rem 1.25rem; font: 550 .9375rem/1.4 inherit;
    cursor: pointer; min-height: 2.75rem; transition: background .15s;
  }
  button:hover:not(:disabled) { background: var(--accent-hover); }
  button:disabled { opacity: .5; cursor: not-allowed; }
  button.secondary { background: var(--surface-sunken); color: var(--text); border-color: var(--border-strong); }
  button.secondary:hover:not(:disabled) { background: var(--border); }

  .msg { margin-top: var(--s4); padding: var(--s3) var(--s4); border-radius: var(--radius-sm); font-size: .9375rem; border: 1px solid transparent; }
  .msg.ok { background: var(--ok-tint); color: var(--ok); border-color: var(--ok); }
  .msg.err { background: var(--danger-tint); color: var(--danger); border-color: var(--danger); }
  .msg.warn { background: var(--warn-tint); color: var(--warn); border-color: var(--warn); }
  .msg b { font-weight: 650; }
  /* The quiet confirmation for a setting that saved itself. A full banner for every tick
     would shout; this is a footnote. */
  .saved { display: inline-block; margin-top: var(--s3); font-size: .875rem; color: var(--ok); font-weight: 550; }

  fieldset.kids-set { border: 0; padding: 0; margin: 0 0 var(--s4); min-width: 0; }
  fieldset.kids-set legend { font-size: .9375rem; font-weight: 550; padding: 0; margin-bottom: var(--s2); }
  ul.kids { display: flex; flex-wrap: wrap; gap: var(--s2); margin: 0; padding: 0; list-style: none; }
  .kids-empty { color: var(--text-muted); font-size: .9375rem; }
  /* Each child is a pill that is also its checkbox's label, so the whole pill is the
     target (44px tall, per the HIG) rather than only the 24px box inside it. */
  .kid {
    display: inline-flex; align-items: center; gap: var(--s2);
    background: var(--surface); color: var(--text);
    border: 1px solid var(--border-strong);
    padding: var(--s2) var(--s4) var(--s2) var(--s3); border-radius: 999px;
    font-size: .9375rem; font-weight: 550; min-height: 2.75rem;
    cursor: pointer;
  }
  .kid:has(input:checked) { background: var(--accent-tint); color: var(--accent-ink); border-color: var(--accent); }
  .kid:has(input:disabled) { cursor: not-allowed; opacity: .6; }
  .kid input[type=checkbox] {
    margin: 0; flex: 0 0 auto;
    width: 1.5rem; height: 1.5rem;   /* 24px — WCAG 2.5.8 minimum target size */
    accent-color: var(--accent);
  }
  .kids-status { font-size: .875rem; color: var(--text-muted); margin: var(--s2) 0 0; min-height: 1.4em; }
  .kids-status.err { color: var(--danger); font-weight: 550; }

  .opt { display: flex; align-items: flex-start; gap: var(--s3); padding: var(--s3) 0; border-top: 1px solid var(--border); }
  .opt:first-of-type { border-top: 0; }
  .opt input[type=checkbox] {
    margin: .2rem 0 0; flex: 0 0 auto;
    width: 1.5rem; height: 1.5rem;   /* 24px — WCAG 2.5.8 minimum target size */
    accent-color: var(--accent);
  }
  .opt label { font-size: .9375rem; cursor: pointer; }
  .opt .why { display: block; color: var(--text-muted); font-size: .875rem; margin-top: var(--s1); }

  details { margin-top: var(--s4); border-top: 1px solid var(--border); padding-top: var(--s3); }
  summary {
    cursor: pointer; font-size: .9375rem; color: var(--accent-ink); font-weight: 550;
    padding: var(--s2) 0; min-height: 1.5rem;
  }
  details .inner { padding-top: var(--s4); }

  /* Start and Stop sit together, with a real gap: two buttons touching read as one
     control, and the destructive-sounding one must not be a slip of the mouse away. */
  .run-actions { display: flex; flex-wrap: wrap; gap: var(--s3); }

  .bar { height: .625rem; background: var(--surface-sunken); border: 1px solid var(--border); border-radius: 99px; overflow: hidden; margin: var(--s4) 0 var(--s3); }
  .bar > i { display: block; height: 100%; background: var(--accent); width: 0; transition: width .3s; }
  /* Indeterminate: we do not know the total, so we must not imply a percentage. */
  .bar[data-indeterminate="true"] > i {
    width: 35%; animation: slide 1.4s ease-in-out infinite;
  }
  /* Stopped part-way: hold the indicator still where it was. Snapping it to 0% or 100%
     would both be untrue, and a bar still moving says the run is still going. */
  .bar[data-stopped="true"] > i { animation-play-state: paused; background: var(--text-muted); }
  @keyframes slide { 0% { transform: translateX(-100%); } 100% { transform: translateX(286%); } }

  .stats { display: flex; flex-wrap: wrap; gap: var(--s6); margin-top: var(--s5); }
  .stat .n { font-size: 1.625rem; font-weight: 650; letter-spacing: -.02em; display: block; margin-bottom: var(--s2); }
  .stat .l { font-size: .8125rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: .06em; }

  .privacy {
    background: var(--surface); border: 1px solid var(--border);
    border-left: 4px solid var(--ok);
    border-radius: var(--radius); padding: var(--s5); margin-top: var(--s5);
  }
  .privacy h2 { font-size: 1rem; margin: 0 0 var(--s2); }
  .privacy p { margin: 0 0 var(--s2); font-size: .9375rem; color: var(--text-muted); }
  .privacy p:last-child { margin-bottom: 0; }
  .path {
    font-family: ui-monospace, Menlo, monospace; font-size: .8125rem;
    background: var(--surface-sunken); padding: .125rem .4rem; border-radius: 5px;
    border: 1px solid var(--border); color: var(--text); word-break: break-all;
  }

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation-duration: .001ms !important; animation-iteration-count: 1 !important; transition-duration: .001ms !important; }
  }
  @media (forced-colors: active) {
    .card, .kid, button, .msg { border: 1px solid ButtonBorder; }
    .num { forced-color-adjust: none; }
  }
</style>
</head>
<body>
<a class="skip" href="#main">Skip to the setup steps</a>
<div class="wrap">
  <header>
    <h1>Save your child&rsquo;s photos</h1>
    <p class="lede">This copies photos from your own Brightwheel account onto this computer, sorted into a folder for each week.</p>
  </header>

  <main id="main">
  <ol class="steps-list">
    <li>
      <section class="card" id="card-connect" data-state="active" aria-labelledby="h-connect">
        <div class="step-head">
          <span class="num" aria-hidden="true" id="num-1">1</span>
          <h2 id="h-connect">Connect to your Brightwheel account</h2>
        </div>
        <p class="hint" id="connect-hint">This tool never sees your password. You sign in on Brightwheel&rsquo;s own website, then copy one value across.</p>
        <div class="body">
          <p class="sr-only" id="connect-state">Step 1 of 3. Not started.</p>
          <ol class="howto" id="howto"></ol>
          <p class="why-ask">
            <b>Why this is needed:</b> it is how the tool proves to Brightwheel that it is
            you, so it can see your own children&rsquo;s photos. It stays on this computer,
            it is not your password, and you can cancel it at any time by signing out of
            Brightwheel.
          </p>
          <div class="field">
            <label class="field-label" for="cookie">Paste the value here</label>
            <textarea id="cookie" rows="3" aria-describedby="connect-hint connect-msg"></textarea>
          </div>
          <button id="btn-connect" type="button">Connect</button>
          <div id="connect-msg" role="alert" aria-live="assertive"></div>
        </div>
      </section>
    </li>

    <li>
      <section class="card" id="card-children" aria-labelledby="h-children">
        <div class="step-head">
          <span class="num" aria-hidden="true" id="num-2">2</span>
          <h2 id="h-children">Children on this account</h2>
        </div>
        <p class="hint">Tick the children whose photos you want. Brightwheel only ever shows this tool the children on your own account. Each setting here is saved the moment you change it.</p>
        <div class="body">
          <p class="sr-only" id="children-state">Step 2 of 3. Waiting for step 1.</p>
          <fieldset class="kids-set">
            <legend>Save photos for</legend>
            <ul class="kids" id="kids"><li class="kids-empty">Connect first to see your children here.</li></ul>
            <p class="kids-status" id="kids-status" role="status" aria-live="polite"></p>
          </fieldset>

          <div class="opt">
            <input type="checkbox" id="tagChildName" checked>
            <label for="tagChildName">Label photos with names
              <span class="why">Your child&rsquo;s name, the nursery&rsquo;s name, the name of whoever posted the photo, and the teacher&rsquo;s note &mdash; which usually says all three &mdash; stored inside the file. That is what lets Apple Photos, Immich and similar apps search by name, and it means those names travel with the file if you ever share it. Turn this off and nothing inside the file says who or where. Everything is still kept in the small .json file beside the photo, which stays behind when you share the photo itself.</span>
            </label>
          </div>
          <div class="opt">
            <input type="checkbox" id="tagNote" checked>
            <label for="tagNote">Keep the teacher&rsquo;s note
              <span class="why">Saves the caption as the photo&rsquo;s description. It applies only while &ldquo;Label photos with names&rdquo; is on, because a note usually names the child, the room and the teacher in one sentence.</span>
            </label>
          </div>
          <div class="opt">
            <input type="checkbox" id="stripLocation" checked>
            <label for="stripLocation">Remove location information
              <span class="why">Strips any GPS coordinates, so the file cannot reveal where it was taken. This one needs ExifTool; without it the run says so plainly rather than leaving you to assume it happened.</span>
            </label>
          </div>

          <details>
            <summary>Advanced options</summary>
            <div class="inner">
              <div class="field">
                <label class="field-label" for="organiseBy">Folder layout</label>
                <select id="organiseBy">
                  <option value="child-then-week">Each child, then a folder per week (recommended)</option>
                  <option value="week">One folder per week, all children together</option>
                  <option value="week-per-child">Each week, then a folder per child</option>
                </select>
              </div>
              <div class="field">
                <label class="field-label" for="archiveDir">Where to save the photos</label>
                <input type="text" id="archiveDir" spellcheck="false" aria-describedby="dir-warn config-msg">
                <p class="why" id="dir-warn" style="color:var(--text-muted);font-size:.875rem;margin:var(--s2) 0 0">Avoid iCloud Drive, Dropbox or OneDrive folders unless you want copies on their servers.</p>
                <button class="secondary" id="btn-dir" type="button" style="margin-top:var(--s3)">Use this folder</button>
              </div>
              <div class="opt">
                <input type="checkbox" id="incremental" checked>
                <label for="incremental">Only look for new photos
                  <span class="why">Much faster. Turn off to re-check everything from the beginning.</span>
                </label>
              </div>
              <div class="opt">
                <input type="checkbox" id="writeSidecar">
                <label for="writeSidecar">Save an extra settings file beside each photo
                  <span class="why">A small .xmp file that photo-editing programs such as Lightroom and darktable can read. Leave this off unless you use one of them.</span>
                </label>
              </div>
            </div>
          </details>
          <div id="config-msg" role="status" aria-live="polite"></div>
        </div>
      </section>
    </li>

    <li>
      <section class="card" id="card-run" aria-labelledby="h-run">
        <div class="step-head">
          <span class="num" aria-hidden="true" id="num-3">3</span>
          <h2 id="h-run">Save the photos</h2>
        </div>
        <p class="hint">The first time takes a while. After that it only looks for what is new, which is quick. You can close this page &mdash; it keeps going in the black window you started it from.</p>
        <div class="body">
          <p class="sr-only" id="run-state">Step 3 of 3. Waiting for step 1.</p>
          <div class="run-actions">
            <button id="btn-run" type="button" disabled>Start saving</button>
            <button class="secondary" id="btn-stop" type="button" disabled>Stop</button>
          </div>
          <div class="bar" id="bar" role="progressbar" aria-labelledby="run-msg" aria-valuemin="0" aria-valuemax="100"><i id="bar-fill"></i></div>
          <p id="run-msg" style="font-size:.9375rem;color:var(--text-muted);margin:0">Not started yet.</p>
          <p class="sr-only" id="run-live" role="status" aria-live="polite"></p>
          <div class="stats">
            <div class="stat"><span class="n" id="s-saved">0</span><span class="l">Saved</span></div>
            <div class="stat"><span class="n" id="s-skipped">0</span><span class="l">Already had</span></div>
            <div class="stat"><span class="n" id="s-failed">0</span><span class="l">Couldn&rsquo;t save</span></div>
          </div>
          <div id="run-result"></div>
        </div>
      </section>
    </li>
  </ol>
  </main>

  <aside class="privacy" aria-labelledby="h-privacy">
    <h2 id="h-privacy">Where your photos go</h2>
    <p>From Brightwheel straight onto this computer, into <span class="path" id="p-dir">your chosen folder</span>. Nothing is uploaded anywhere else. There is no online account to sign up for, and nothing is collected about you.</p>
    <p>This page is being served by the program running on your own computer &mdash; that is why the address starts with 127.0.0.1, which means <em>this machine only</em>. Nobody else on your network can open it, and it disappears when you stop the program.</p>
  </aside>
</div>

<script>
const TOKEN = '__TOKEN__';
const $ = (id) => document.getElementById(id);
const api = (path, opts = {}) => fetch(path + (path.includes('?') ? '&' : '?') + 'token=' + TOKEN, {
  ...opts, headers: { 'content-type': 'application/json', 'x-setup-token': TOKEN, ...(opts.headers || {}) }
});
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const show = (el, kind, html) => { el.innerHTML = '<div class="msg ' + kind + '">' + html + '</div>'; };

/**
 * Browser-specific instructions. The keystroke and the menu path genuinely differ, and a
 * parent following Chrome steps in Safari simply fails — Safari hides the Develop menu
 * until you turn it on, which is a dead end nobody guesses their way out of.
 */
function howToSteps() {
  const ua = navigator.userAgent;
  const isFirefox = /Firefox\//.test(ua);
  const isSafari = /Safari\//.test(ua) && !/Chrome|Chromium|Edg\//.test(ua);
  const open = isSafari
    ? 'Turn on the developer menu first: Safari menu &rarr; <b>Settings</b> &rarr; <b>Advanced</b> &rarr; tick <b>Show features for web developers</b>. Then press <kbd>Option</kbd>+<kbd>Cmd</kbd>+<kbd>I</kbd>.'
    : isFirefox
      ? 'Press <kbd>F12</kbd> (or <kbd>Option</kbd>+<kbd>Cmd</kbd>+<kbd>I</kbd> on a Mac).'
      : 'Press <kbd>F12</kbd> (or <kbd>Option</kbd>+<kbd>Cmd</kbd>+<kbd>I</kbd> on a Mac).';
  const where = isFirefox
    ? 'Click <b>Storage</b> along the top, then <b>Cookies</b> on the left.'
    : isSafari
      ? 'Click <b>Storage</b> along the top, then <b>Cookies</b> on the left.'
      : 'Click <b>Application</b> along the top, then <b>Cookies</b> on the left.';
  return [
    'Open <b>schools.mybrightwheel.com</b> in a new tab and sign in as you normally would.',
    open,
    where,
    'Find the row named <code>_brightwheel_v2</code> and copy what is in its <b>Value</b> column.',
    'Paste it in the box below and press Connect.',
  ];
}
$('howto').innerHTML = howToSteps().map((s) => '<li>' + s + '</li>').join('');

function setStep(card, numEl, srEl, state, srText) {
  card.dataset.state = state;
  if (state === 'complete') { numEl.textContent = '✓'; card.setAttribute('aria-current', 'false'); }
  else if (state === 'active') card.setAttribute('aria-current', 'step');
  srEl.textContent = srText;
}

let lastAnnounced = '';
let state = null;
let sessionOk = false;
let isRunning = false;
/** The children on the account, as last read. Empty until step 1 is done. */
let kids = [];
/** The folder as last accepted by the tool, so re-saving the same value costs nothing. */
let savedDir = '';
/** Whether a refused folder is still marked and explained on screen. */
// The folder refusal's own words, or null. Held as text rather than read back out of the
// message box, because any other error — a failed save, the tool having stopped — lands in
// that same box, and restoring one of those would leave a stale complaint on screen that
// nothing can clear.
let dirError = null;
/** Whether Stop has been pressed and the run has not wound down yet. */
let stopping = false;

const selectedIds = () =>
  [...document.querySelectorAll('#kids input[type=checkbox]')].filter((b) => b.checked).map((b) => b.dataset.id);

/** Everything the person can see in step 2, as one config patch. */
function formState() {
  const patch = {
    tagChildName: $('tagChildName').checked, tagNote: $('tagNote').checked,
    stripLocation: $('stripLocation').checked, incremental: $('incremental').checked,
    writeSidecar: $('writeSidecar').checked, organiseBy: $('organiseBy').value,
    archiveDir: $('archiveDir').value,
  };
  if (kids.length > 0) patch.includeStudents = selectedIds();
  return patch;
}

/**
 * Saves go one at a time, in the order they happened. Two quick ticks otherwise race, and
 * the one that lands second wins even if it was made first.
 */
let saves = Promise.resolve();
function persist(patch, opts = {}) {
  const run = saves.then(() => save(patch, opts));
  saves = run.catch(() => {});
  return run;
}

async function save(patch, opts) {
  if (Object.keys(patch).length === 1 && patch.archiveDir === savedDir) {
    // Leaving the field and pressing the button both save; the second is a no-op.
    // A refusal from earlier is cleared first: what is in the field is now exactly what is
    // stored, so saying it was refused would be untrue, and leaving the field marked
    // invalid would tell a screen reader the same untruth.
    clearDirError();
    savedNote();
    return true;
  }
  let d;
  try {
    const r = await api('/api/config', { method: 'POST', body: JSON.stringify(patch) });
    d = await r.json();
  } catch {
    d = { ok: false, error: 'Could not save that. Check the tool is still running in the window you started it from.' };
  }
  if (!d.ok) {
    showSaveError(d, opts);
    return false;
  }
  // Only the save that carried the folder may rewrite the field or clear the mark on it.
  // Otherwise ticking a checkbox after a refused folder silently replaced what the person
  // had typed with the stored path and wiped the refusal explaining why it was not kept.
  if (patch.archiveDir !== undefined) {
    $('archiveDir').value = d.config.archiveDir;
    clearDirError();
  }
  savedDir = d.config.archiveDir;
  // Always the stored folder, never the typed one: this says where the photos will go.
  $('p-dir').textContent = d.config.archiveDir;
  if (d.warning) show($('config-msg'), 'warn', esc(d.warning));
  else savedNote();
  return true;
}

function savedNote() {
  const el = $('config-msg');
  // A refused folder shares this box with the note, and the note must never be what
  // removes it: the refusal is the only thing saying the photos are not going where the
  // person just typed. It is put back because it is still true — the tick that saved did
  // not fix it.
  const restore = () => {
    el.textContent = '';
    if (dirError) el.innerHTML = '<div class="msg err">' + esc(dirError) + '</div>';
  };
  // Emptied first, so the second "Saved" is announced as well as the first. The brief
  // blink is also the visual cue that something new was just stored.
  restore();
  // Not over the "locked" note: Start saving persists the form and then the run begins
  // inside those 50ms.
  setTimeout(() => {
    if (isRunning) return;
    restore();
    el.insertAdjacentHTML('beforeend', '<span class="saved">Saved</span>');
  }, 50);
}

/** The folder is agreed again: drop the refusal and the invalid mark together. */
function clearDirError() {
  dirError = null;
  $('archiveDir').setAttribute('aria-invalid', 'false');
}

function showSaveError(d, opts) {
  const text = d.error || 'Could not save those settings.';
  if (d.field === 'includeStudents') {
    const st = $('kids-status');
    st.classList.add('err');
    st.textContent = text;
    updateRunReady();
    return;
  }
  show($('config-msg'), 'err', esc(text));
  if (d.field === 'archiveDir') {
    dirError = text;
    $('archiveDir').setAttribute('aria-invalid', 'true');
    // Only move focus when the person pressed something; stealing it as they tab away
    // from the field would trap them in it.
    if (opts.focus) {
      document.querySelector('details').open = true;
      $('archiveDir').focus();
    }
  }
}

/**
 * Whether "Start saving" may be pressed, and why not when it may not. The reason is put
 * where a screen reader will find it, next to the button, not only in a colour change.
 */
function updateRunReady() {
  const none = kids.length > 0 && selectedIds().length === 0;
  $('btn-run').disabled = !sessionOk || isRunning || none;
  const stopBtn = $('btn-stop');
  stopBtn.disabled = !isRunning || stopping;
  if (isRunning) return;
  // The run is over, however it ended; Stop is ready for the next one.
  stopping = false;
  stopBtn.textContent = 'Stop';
  if (!sessionOk) $('run-state').textContent = 'Step 3 of 3. Waiting for step 1.';
  else if (none) $('run-state').textContent = 'Step 3 of 3. Cannot start until at least one child is ticked in step 2.';
  else $('run-state').textContent = 'Step 3 of 3. Ready to start.';
}

/** Settings cannot change under a run that has already read them, so say so. */
function lockSettings(locked) {
  for (const el of document.querySelectorAll('#card-children input, #card-children select, #card-children button')) {
    el.disabled = locked;
  }
  const msg = $('config-msg');
  if (locked) msg.innerHTML = '<span class="saved" data-note="lock" style="color:var(--text-muted)">Settings are locked while saving is in progress.</span>';
  else if (msg.firstElementChild?.dataset.note === 'lock') msg.textContent = '';
}

async function refresh() {
  const r = await api('/api/state');
  state = await r.json();
  const c = state.config;
  for (const k of ['tagChildName','tagNote','stripLocation','incremental','writeSidecar']) $(k).checked = c[k];
  $('organiseBy').value = c.organiseBy;
  $('archiveDir').value = c.archiveDir;
  savedDir = c.archiveDir;
  $('p-dir').textContent = c.archiveDir;

  if (state.hasSession) {
    sessionOk = true;
    setStep($('card-connect'), $('num-1'), $('connect-state'), 'complete',
      'Step 1 of 3, complete. Connected' + (state.email ? ' as ' + state.email : '') + '.');
    show($('connect-msg'), 'ok', 'Connected' + (state.email ? ' as <b>' + esc(state.email) + '</b>' : '') + '.');
    setStep($('card-run'), $('num-3'), $('run-state'), 'active', 'Step 3 of 3. Ready to start.');
    await loadChildren();
  }
  updateRunReady();
  paint(state.progress, state.running, state.lastResult);
  // A run started before this page was opened (or before a reload) is still going in the
  // terminal. Without restarting the poll here the bar sits motionless, and HIG's
  // progress-indicators guidance is explicit that people read a stationary indicator as a
  // stalled process — so the page would imply a hang that is not happening.
  if (state.running) poll();
}

async function loadChildren() {
  const r = await api('/api/children');
  const d = await r.json();
  if (!d.ok) return;
  kids = d.children;
  const included = new Set(d.included);
  // The element id is positional; the Brightwheel id travels in a data attribute, where
  // any character is safe once escaped.
  $('kids').innerHTML = kids.map((k, i) =>
    '<li><label class="kid" for="kid-' + i + '">' +
    '<input type="checkbox" id="kid-' + i + '" data-id="' + esc(k.id) + '"' + (included.has(k.id) ? ' checked' : '') + '>' +
    esc(k.fullName) + '</label></li>').join('');
  for (const box of document.querySelectorAll('#kids input')) box.addEventListener('change', onChildToggled);
  describeSelection();
  setStep($('card-children'), $('num-2'), $('children-state'), 'complete',
    'Step 2 of 3. Found ' + kids.length + ' child' + (kids.length === 1 ? '' : 'ren') + '. Tick the ones to save photos for.');
}

function onChildToggled() {
  describeSelection();
  updateRunReady();
  // Sent even when nothing is ticked: the tool refuses that, and its reason is shown.
  persist({ includeStudents: selectedIds() });
}

/** Plain words for who is in and who is out, spoken as well as shown. */
function describeSelection() {
  const st = $('kids-status');
  st.classList.remove('err');
  const chosen = selectedIds();
  if (kids.length === 0) { st.textContent = ''; return; }
  if (chosen.length === 0) {
    // Nobody ticked has to be said where the eye already is — beside the names — and not
    // only in the line next to the button, which is for screen readers. A sighted person
    // otherwise meets a greyed-out "Start saving" with nothing on screen explaining it.
    // This is also the state /api/children can arrive in, when every stored child has
    // left the account.
    st.classList.add('err');
    st.textContent = 'Tick at least one child. Photos are only saved for the children you tick.';
    return;
  }
  const names = kids.filter((k) => chosen.includes(k.id)).map((k) => k.fullName);
  const list = names.length === 1 ? names[0] : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
  if (chosen.length === kids.length) {
    st.textContent = 'Photos will be saved for ' + (kids.length === 1 ? names[0] : kids.length === 2 ? 'both children' : 'all ' + kids.length + ' children') + '.';
  } else {
    st.textContent = 'Photos will be saved for ' + list + ' only.';
  }
}

$('btn-connect').onclick = async () => {
  const btn = $('btn-connect');
  const field = $('cookie');
  btn.disabled = true; btn.textContent = 'Checking…';
  field.setAttribute('aria-invalid', 'false');
  show($('connect-msg'), 'warn', 'Checking with Brightwheel…');
  try {
    const r = await api('/api/session', { method: 'POST', body: JSON.stringify({ cookie: field.value }) });
    const d = await r.json();
    if (d.ok) {
      field.value = '';
      await refresh();
      // Move focus forward so a keyboard or screen-reader user is taken to what is next.
      $('btn-run').focus();
    } else {
      field.setAttribute('aria-invalid', 'true');
      show($('connect-msg'), 'err', esc(d.error));
      field.focus();
    }
  } catch {
    show($('connect-msg'), 'err', 'Could not reach the tool. Check it is still running in the window you started it from.');
  }
  btn.disabled = false; btn.textContent = 'Connect';
};

// Ticks and the layout menu save themselves. The folder is typed, so it saves when the
// person leaves the field or presses Enter, never per keystroke: half a path is always
// an invalid folder, and the error would flash on every letter.
for (const k of ['tagChildName', 'tagNote', 'stripLocation', 'incremental', 'writeSidecar']) {
  $(k).addEventListener('change', () => persist({ [k]: $(k).checked }));
}
$('organiseBy').addEventListener('change', () => persist({ organiseBy: $('organiseBy').value }));
$('archiveDir').addEventListener('change', () => persist({ archiveDir: $('archiveDir').value }));
$('btn-dir').onclick = () => persist({ archiveDir: $('archiveDir').value }, { focus: true });

$('btn-run').onclick = async () => {
  $('btn-run').disabled = true;
  $('run-result').innerHTML = '';
  // What is on screen is what runs. The whole form is sent again here, so a change that
  // was refused earlier, or is still on its way, cannot be left behind by a run that
  // reads its settings from disk.
  if (!(await persist(formState(), { focus: true }))) {
    show($('run-result'), 'err', 'Not started. Fix the setting marked in step 2, then press Start saving again.');
    updateRunReady();
    return;
  }
  const r = await api('/api/sync', { method: 'POST', body: '{}' });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    show($('run-result'), 'err', esc(d.error || 'Could not start.'));
    updateRunReady();
    return;
  }
  poll();
};

$('btn-stop').onclick = async () => {
  const btn = $('btn-stop');
  stopping = true;
  btn.disabled = true;
  // The reply comes back at once; the run then finishes the photo it is on before it
  // stops, so the waiting shows in the progress line rather than in a frozen button.
  btn.textContent = 'Stopping\u2026';
  try {
    const r = await api('/api/stop', { method: 'POST', body: '{}' });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      show($('run-result'), 'err', esc(d.error || 'Could not stop it.'));
      stopping = false;
      updateRunReady();
    }
  } catch {
    show($('run-result'), 'err', 'Could not reach the tool. Check it is still running in the window you started it from.');
    stopping = false;
    updateRunReady();
  }
};

function paint(p, running, result) {
  if (!p) return;
  $('s-saved').textContent = p.saved;
  $('s-skipped').textContent = p.skipped;
  $('s-failed').textContent = p.failed;
  $('run-msg').textContent = p.message;

  const bar = $('bar');
  const fill = $('bar-fill');
  const stopped = p.phase === 'stopped';
  bar.dataset.stopped = stopped ? 'true' : 'false';
  if ((running || stopped) && !p.total) {
    // We do not know how many photos there are until the feed has been walked. Showing a
    // percentage here would be an invention, so show motion without a number instead.
    bar.dataset.indeterminate = 'true';
    bar.removeAttribute('aria-valuenow');
    fill.style.width = '';
  } else {
    bar.dataset.indeterminate = 'false';
    const done = p.total ? Math.round(((p.saved + p.skipped + p.failed) / p.total) * 100) : (p.phase === 'done' ? 100 : 0);
    bar.setAttribute('aria-valuenow', String(done));
    fill.style.width = done + '%';
  }

  // Announce sparingly. The poll runs every 700ms; announcing each tick would make a
  // screen reader unusable, so only genuine phase changes are spoken.
  if (p.phase !== lastAnnounced) {
    lastAnnounced = p.phase;
    $('run-live').textContent = p.message;
  }

  // Before the phase text below, so "finished" is not overwritten by "ready to start".
  if (Boolean(running) !== isRunning) {
    isRunning = Boolean(running);
    lockSettings(isRunning);
  }
  updateRunReady();

  if (p.phase === 'done') {
    setStep($('card-run'), $('num-3'), $('run-state'), 'complete', 'Step 3 of 3, finished.');
    bar.dataset.indeterminate = 'false';
    fill.style.width = '100%';
    // "Nothing new" is the normal outcome of a daily run. It must read as success, not
    // as a zero that looks like failure.
    if (result && result.saved === 0 && result.failed === 0) {
      show($('run-result'), 'ok', 'You are up to date &mdash; there were no new photos to save.');
    } else if (result) {
      let html = 'Saved <b>' + result.saved + '</b> new item' + (result.saved === 1 ? '' : 's') + '.';
      if (result.failed > 0) html += ' <b>' + result.failed + '</b> could not be fetched &mdash; press Start saving again to retry them.';
      show($('run-result'), result.failed > 0 ? 'warn' : 'ok', html);
    }
  }
  if (p.phase === 'stopped') {
    // Neither finished nor failed. Everything already saved is on disk and the next run
    // carries on from there, so this reads as an ordinary outcome, not as a warning.
    setStep($('card-run'), $('num-3'), $('run-state'), 'active', p.message);
    show($('run-result'), 'ok', esc(p.message));
  }
  if (p.phase === 'error') {
    show($('run-result'), 'err', esc(p.message) + ' <br><br>If your session has expired, paste a fresh value in step 1 above.');
    $('card-run').dataset.state = 'active';
  }
}

async function poll() {
  const r = await api('/api/state');
  const s = await r.json();
  paint(s.progress, s.running, s.lastResult);
  if (s.running) setTimeout(poll, 700);
}

refresh();
</script>
</body>
</html>`;
