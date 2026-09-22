/**
 * The setup assistant page.
 *
 * One self-contained file: no bundler, no framework, no CDN. Every byte is served from
 * this process, which is what lets the Content-Security-Policy forbid all external
 * origins. For a tool that handles children's photos, "this page cannot load anything
 * from the internet" is worth more than any convenience a framework would buy.
 */
export const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Brightwheel Archive - Setup</title>
<style>
  :root {
    --ink: #1d2430; --muted: #5d6b80; --line: #e2e8f0;
    --bg: #f6f8fb; --card: #ffffff; --accent: #2f6fed; --accent-dark: #2457c5;
    --ok: #1a7f52; --ok-bg: #e8f6ef; --warn: #9a6207; --warn-bg: #fdf3e0;
    --radius: 14px;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  .wrap { max-width: 760px; margin: 0 auto; padding: 40px 24px 80px; }
  header { margin-bottom: 32px; }
  h1 { font-size: 30px; line-height: 1.25; margin: 0 0 10px; letter-spacing: -0.02em; }
  .sub { color: var(--muted); margin: 0; font-size: 17px; }
  .card {
    background: var(--card); border: 1px solid var(--line); border-radius: var(--radius);
    padding: 28px; margin-bottom: 20px; box-shadow: 0 1px 2px rgba(16,24,40,.04);
  }
  .card.done { border-color: #bfe3d0; }
  .step-head { display: flex; align-items: center; gap: 14px; margin-bottom: 8px; }
  .num {
    flex: 0 0 auto; width: 32px; height: 32px; border-radius: 50%;
    background: var(--accent); color: #fff; font-weight: 600; font-size: 15px;
    display: grid; place-items: center;
  }
  .card.done .num { background: var(--ok); }
  h2 { font-size: 19px; margin: 0; letter-spacing: -0.01em; }
  .hint { color: var(--muted); font-size: 15px; margin: 6px 0 18px 46px; }
  .body { margin-left: 46px; }
  ol.steps { margin: 0 0 18px; padding-left: 20px; color: var(--muted); font-size: 15px; }
  ol.steps li { margin-bottom: 7px; }
  ol.steps code {
    background: #eef2f7; padding: 2px 7px; border-radius: 5px;
    font-size: 13.5px; color: var(--ink); font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  textarea, input[type=text] {
    width: 100%; padding: 12px 14px; border: 1px solid var(--line); border-radius: 9px;
    font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; resize: vertical;
    background: #fcfdff; color: var(--ink);
  }
  textarea:focus, input:focus { outline: 2px solid var(--accent); outline-offset: 1px; border-color: transparent; }
  button {
    background: var(--accent); color: #fff; border: 0; border-radius: 9px;
    padding: 12px 22px; font-size: 15px; font-weight: 600; cursor: pointer;
    margin-top: 14px; transition: background .15s;
  }
  button:hover:not(:disabled) { background: var(--accent-dark); }
  button:disabled { opacity: .45; cursor: not-allowed; }
  button.secondary { background: #eef2f7; color: var(--ink); }
  .msg { margin-top: 14px; padding: 12px 16px; border-radius: 9px; font-size: 14.5px; }
  .msg.ok { background: var(--ok-bg); color: var(--ok); }
  .msg.err { background: #fdecec; color: #a32020; }
  .msg.warn { background: var(--warn-bg); color: var(--warn); }
  .kids { display: flex; flex-wrap: wrap; gap: 10px; margin: 4px 0 18px; }
  .kid {
    background: #eef3fe; color: var(--accent-dark); border: 1px solid #d3e0fb;
    padding: 8px 16px; border-radius: 999px; font-size: 14.5px; font-weight: 500;
  }
  .opt { display: flex; align-items: flex-start; gap: 12px; padding: 13px 0; border-top: 1px solid var(--line); }
  .opt:first-of-type { border-top: 0; }
  .opt input { margin-top: 4px; flex: 0 0 auto; width: 17px; height: 17px; accent-color: var(--accent); }
  .opt label { font-size: 15px; cursor: pointer; }
  .opt .why { display: block; color: var(--muted); font-size: 13.5px; margin-top: 3px; }
  details { margin-top: 16px; border-top: 1px solid var(--line); padding-top: 14px; }
  summary { cursor: pointer; font-size: 14.5px; color: var(--accent-dark); font-weight: 500; }
  details .inner { padding-top: 16px; }
  .field { margin-bottom: 16px; }
  .field label { display: block; font-size: 14.5px; font-weight: 500; margin-bottom: 6px; }
  select {
    width: 100%; padding: 11px 13px; border: 1px solid var(--line);
    border-radius: 9px; font-size: 15px; background: #fcfdff; color: var(--ink);
  }
  .bar { height: 9px; background: #e8edf5; border-radius: 99px; overflow: hidden; margin: 18px 0 12px; }
  .bar span { display: block; height: 100%; background: var(--accent); width: 0; transition: width .3s; }
  .stats { display: flex; gap: 30px; margin-top: 18px; }
  .stat .n { font-size: 26px; font-weight: 650; letter-spacing: -0.02em; display: block; margin-bottom: 4px; }
  .stat .l { font-size: 13px; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; }
  .privacy {
    background: #fff; border: 1px solid var(--line); border-left: 4px solid var(--ok);
    border-radius: var(--radius); padding: 22px 26px; margin-top: 8px;
  }
  .privacy h3 { margin: 0 0 10px; font-size: 16px; }
  .privacy p { margin: 0 0 8px; font-size: 14.5px; color: var(--muted); }
  .privacy p:last-child { margin-bottom: 0; }
  .path { font-family: ui-monospace, Menlo, monospace; font-size: 13.5px; color: var(--ink); background: #eef2f7; padding: 2px 7px; border-radius: 5px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Save your child&rsquo;s photos</h1>
    <p class="sub">This copies the photos from your own Brightwheel account onto this computer, sorted into a folder for each week.</p>
  </header>

  <section class="card" id="card-connect">
    <div class="step-head"><div class="num" id="num-1">1</div><h2>Connect to your Brightwheel account</h2></div>
    <p class="hint">This tool never sees your password. You sign in on Brightwheel&rsquo;s own website, then copy one value across.</p>
    <div class="body">
      <ol class="steps">
        <li>Open <strong>schools.mybrightwheel.com</strong> in a new tab and sign in as you normally would.</li>
        <li>Press <code>F12</code> (Windows) or <code>Option</code>+<code>Cmd</code>+<code>I</code> (Mac) to open developer tools.</li>
        <li>Go to <strong>Application</strong> &rarr; <strong>Cookies</strong>, and find the row named <code>_brightwheel_v2</code>.</li>
        <li>Copy its <strong>Value</strong> and paste it below.</li>
      </ol>
      <textarea id="cookie" rows="3" placeholder="Paste the _brightwheel_v2 value here" aria-label="Brightwheel session value"></textarea>
      <button id="btn-connect">Connect</button>
      <div id="connect-msg"></div>
    </div>
  </section>

  <section class="card" id="card-children">
    <div class="step-head"><div class="num" id="num-2">2</div><h2>Your children</h2></div>
    <p class="hint">Brightwheel only ever shows this tool the children on your own account.</p>
    <div class="body">
      <div class="kids" id="kids"><span style="color:var(--muted);font-size:15px">Connect first to see your children here.</span></div>

      <div class="opt">
        <input type="checkbox" id="tagChildName" checked>
        <label for="tagChildName">Label photos with your child&rsquo;s name
          <span class="why">Lets Apple Photos, Immich and similar apps search by name. The name is stored inside the photo file, so it travels with the file if you ever share it.</span>
        </label>
      </div>
      <div class="opt">
        <input type="checkbox" id="tagNote" checked>
        <label for="tagNote">Keep the teacher&rsquo;s note
          <span class="why">Saves the caption as the photo&rsquo;s description.</span>
        </label>
      </div>
      <div class="opt">
        <input type="checkbox" id="stripLocation" checked>
        <label for="stripLocation">Remove location information
          <span class="why">Strips any GPS coordinates, so the file cannot reveal where it was taken.</span>
        </label>
      </div>

      <details>
        <summary>Advanced options</summary>
        <div class="inner">
          <div class="field">
            <label for="organiseBy">Folder layout</label>
            <select id="organiseBy">
              <option value="child-then-week">Each child, then a folder per week (recommended)</option>
              <option value="week">One folder per week, all children together</option>
              <option value="week-per-child">Each week, then a folder per child</option>
            </select>
          </div>
          <div class="field">
            <label for="archiveDir">Where to save the photos</label>
            <input type="text" id="archiveDir" spellcheck="false">
          </div>
          <div class="opt">
            <input type="checkbox" id="incremental" checked>
            <label for="incremental">Only look for new photos
              <span class="why">Much faster. Turn off to re-check everything from the beginning.</span>
            </label>
          </div>
          <div class="opt">
            <input type="checkbox" id="writeSidecar">
            <label for="writeSidecar">Also write .xmp sidecar files
              <span class="why">Only useful with Lightroom or darktable.</span>
            </label>
          </div>
          <button class="secondary" id="btn-save-config">Save settings</button>
          <div id="config-msg"></div>
        </div>
      </details>
    </div>
  </section>

  <section class="card" id="card-run">
    <div class="step-head"><div class="num" id="num-3">3</div><h2>Save the photos</h2></div>
    <p class="hint">You can close this page while it runs &mdash; it keeps going in the terminal.</p>
    <div class="body">
      <button id="btn-run" disabled>Start saving</button>
      <div class="bar"><span id="bar"></span></div>
      <div id="run-msg" style="font-size:14.5px;color:var(--muted)">Not started yet.</div>
      <div class="stats">
        <div class="stat"><span class="n" id="s-saved">0</span><span class="l">Saved</span></div>
        <div class="stat"><span class="n" id="s-skipped">0</span><span class="l">Already had</span></div>
        <div class="stat"><span class="n" id="s-failed">0</span><span class="l">Failed</span></div>
      </div>
    </div>
  </section>

  <div class="privacy">
    <h3>Where your photos go</h3>
    <p>They go from Brightwheel straight onto this computer, into <span class="path" id="p-dir">your chosen folder</span>. Nothing is uploaded anywhere else, and this tool has no account, no server and no analytics.</p>
    <p>This page is only open on this computer. Nobody else on your network can reach it, and it closes when you stop the program.</p>
  </div>
</div>

<script>
const TOKEN = '__TOKEN__';
const api = (path, opts = {}) => fetch(path + (path.includes('?') ? '&' : '?') + 'token=' + TOKEN, {
  ...opts, headers: { 'content-type': 'application/json', 'x-setup-token': TOKEN, ...(opts.headers || {}) }
});
const $ = (id) => document.getElementById(id);
const show = (el, kind, text) => { el.innerHTML = '<div class="msg ' + kind + '">' + text + '</div>'; };

let state = null;

async function refresh() {
  const r = await api('/api/state');
  state = await r.json();
  const c = state.config;
  $('tagChildName').checked = c.tagChildName;
  $('tagNote').checked = c.tagNote;
  $('stripLocation').checked = c.stripLocation;
  $('incremental').checked = c.incremental;
  $('writeSidecar').checked = c.writeSidecar;
  $('organiseBy').value = c.organiseBy;
  $('archiveDir').value = c.archiveDir;
  $('p-dir').textContent = c.archiveDir;

  if (state.hasSession) {
    $('card-connect').classList.add('done');
    $('num-1').textContent = '✓';
    show($('connect-msg'), 'ok', 'Connected' + (state.email ? ' as ' + state.email : '') + '.');
    $('btn-run').disabled = false;
    loadChildren();
  }
  paint(state.progress, state.running);
}

async function loadChildren() {
  const r = await api('/api/children');
  const d = await r.json();
  if (!d.ok) return;
  $('kids').innerHTML = d.children.map(k => '<span class="kid">' + k.fullName + '</span>').join('');
  $('card-children').classList.add('done');
  $('num-2').textContent = '✓';
}

$('btn-connect').onclick = async () => {
  const btn = $('btn-connect');
  btn.disabled = true; btn.textContent = 'Checking…';
  try {
    const r = await api('/api/session', { method: 'POST', body: JSON.stringify({ cookie: $('cookie').value }) });
    const d = await r.json();
    if (d.ok) { $('cookie').value = ''; await refresh(); }
    else show($('connect-msg'), 'err', d.error);
  } catch (e) { show($('connect-msg'), 'err', 'Could not connect.'); }
  btn.disabled = false; btn.textContent = 'Connect';
};

$('btn-save-config').onclick = async () => {
  const patch = {
    tagChildName: $('tagChildName').checked, tagNote: $('tagNote').checked,
    stripLocation: $('stripLocation').checked, incremental: $('incremental').checked,
    writeSidecar: $('writeSidecar').checked, organiseBy: $('organiseBy').value,
    archiveDir: $('archiveDir').value,
  };
  const r = await api('/api/config', { method: 'POST', body: JSON.stringify(patch) });
  const d = await r.json();
  show($('config-msg'), d.ok ? 'ok' : 'err', d.ok ? 'Settings saved.' : 'Could not save.');
  if (d.ok) $('p-dir').textContent = d.config.archiveDir;
};

$('btn-run').onclick = async () => {
  $('btn-run').disabled = true;
  await api('/api/sync', { method: 'POST', body: '{}' });
  poll();
};

function paint(p, running) {
  if (!p) return;
  $('s-saved').textContent = p.saved;
  $('s-skipped').textContent = p.skipped;
  $('s-failed').textContent = p.failed;
  $('run-msg').textContent = p.message;
  const total = p.saved + p.skipped + p.failed;
  $('bar').style.width = p.phase === 'done' ? '100%' : Math.min(95, total * 2) + '%';
  if (p.phase === 'done') { $('card-run').classList.add('done'); $('num-3').textContent = '✓'; }
  if (p.phase === 'error') show($('run-msg'), 'err', p.message);
  $('btn-run').disabled = Boolean(running);
}

async function poll() {
  const r = await api('/api/state');
  const s = await r.json();
  paint(s.progress, s.running);
  if (s.running) setTimeout(poll, 700);
}

refresh();
</script>
</body>
</html>`;
