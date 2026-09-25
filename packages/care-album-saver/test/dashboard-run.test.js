import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext, runInContext } from 'node:vm';
import { PAGE } from '../dist/web/page.js';

/**
 * The main page once setup is done (2026-09-24). "Save new photos" saves on the main page:
 * the run's card moves onto the dashboard, under the buttons, rather than the button opening
 * Settings to show it there. And each line under the buttons starts with an icon for what it
 * is about, which turns to a warning sign on a line that needs attention.
 */

const TAG = '<script nonce="__NONCE__">';
const SCRIPT = PAGE.slice(PAGE.indexOf(TAG) + TAG.length, PAGE.indexOf('</script>'));
const STYLE = PAGE.slice(PAGE.indexOf('<style'), PAGE.indexOf('</style>'));
const DASH = PAGE.slice(PAGE.indexOf('<section class="dash" id="dash"'), PAGE.indexOf('</section>', PAGE.indexOf('<section class="dash" id="dash"')));

test('the run moves onto the dashboard, under its buttons, and not into Settings', () => {
  assert.match(SCRIPT, /\['card-run', 'dashboard'\],/);
  assert.match(SCRIPT, /const target = m\.panel === 'dashboard' \? \$\('dash-run'\)/);
  const actions = DASH.indexOf('class="dash-actions"');
  const run = DASH.indexOf('<div id="dash-run" hidden></div>');
  const facts = DASH.indexOf('<ul class="dash-facts"');
  assert.ok(actions >= 0 && actions < run && run < facts, 'buttons, then the run, then the lines about the archive');
  const settings = PAGE.slice(PAGE.indexOf('<dialog id="dlg-settings"'), PAGE.indexOf('</dialog>', PAGE.indexOf('<dialog id="dlg-settings"')));
  assert.doesNotMatch(settings, /data-panel="run"/, 'Settings has no section for it');
});

test('"Save new photos" starts the run where it is; it does not open Settings', () => {
  const handler = SCRIPT.slice(SCRIPT.indexOf("$('btn-dash-run').onclick"), SCRIPT.indexOf('\n};', SCRIPT.indexOf("$('btn-dash-run').onclick")));
  assert.match(handler, /\$\('btn-run'\)\.click\(\);$/, 'it presses the run\'s own button');
  assert.doesNotMatch(handler, /openSettings|openDialog/);
  assert.match(handler, /dashRunAsked = true;/, 'and what that run says, a refusal included, is shown on the dashboard');
  // On the dashboard the card's own heading, first-run notes and Start button are hidden
  // (the dashboard's button is the one pressed), and so are its counters until a run is going.
  for (const hidden of ['#dash-run .step-head', '#dash-run #btn-run', '#dash-run #card-run:not([data-running]) .stats']) {
    assert.ok(STYLE.includes(hidden), hidden);
  }
  // #dash-run .body loses the step cards' indent, which lines up with a number not shown here.
  assert.ok(STYLE.includes('#dash-run .body { margin-left: 0; }'));
  // A message that names a section still gets there from the dashboard, where Settings is shut.
  assert.match(SCRIPT, /\(\$\('dlg-settings'\)\.open \? showSection : openSettings\)\(to\.dataset\.section\)/);
});

test('each line under the buttons starts with its icon, which screen readers skip', () => {
  const icons = {
    'dash-connected': '\\1F517',
    'dash-schedule': '\\23F0',
    'dash-last': '\\1F4DC',
    'dash-folder': '\\1F5C2\\FE0F',
    'dash-photos': '\\1F4F7',
    'ask-updates': '\\1F4E6',
  };
  const facts = DASH.slice(DASH.indexOf('<ul class="dash-facts"'), DASH.indexOf('</ul>', DASH.indexOf('<ul class="dash-facts"')));
  for (const [id, icon] of Object.entries(icons)) {
    assert.match(facts, new RegExp(`<li id="${id}"`), `${id} is one of the lines`);
    // The second declaration gives it empty alternative text; the first is for browsers without that.
    assert.ok(STYLE.includes(`#${id}::before { content: "${icon}"; content: "${icon}" / ""; }`), id);
  }
  assert.match(STYLE, /\.dash-facts li \{ position: relative; padding-left: 2em; \}/, 'with room between the icon and the words');
});

test('a line that needs attention shows a warning sign instead, and that rule outranks the icons', () => {
  const rule = STYLE.split('\n').find((l) => l.includes('li.warn-text::before'));
  assert.ok(rule, 'there is one');
  assert.match(rule, /content: "\\26A0\\FE0F"; content: "\\26A0\\FE0F" \/ "";/);
  // An id outranks any number of classes, so a rule without one would lose to #dash-last::before.
  assert.match(rule.trim(), /^#dash \.dash-facts li\.warn-text::before/);
  assert.match(SCRIPT, /\$\('dash-connected'\)\.classList\.toggle\('warn-text'/);
  assert.match(SCRIPT, /\$\('dash-last'\)\.classList\.toggle\('warn-text'/);
  assert.match(SCRIPT, /dash\.classList\.toggle\('warn-text', failing \|\| doubtful\)/, 'and the Apple Photos.app line, failing or unconfirmed');
});

test('"Save new photos" with the run\'s own button greyed out says why, instead of doing nothing', () => {
  const handler = SCRIPT.slice(SCRIPT.indexOf("$('btn-dash-run').onclick"), SCRIPT.indexOf('\n};', SCRIPT.indexOf("$('btn-dash-run').onclick")) + 3);
  const run = (sessionOk) => {
    const els = new Map();
    const el = (id) => {
      if (!els.has(id)) els.set(id, { id, disabled: id === 'btn-run', clicked: 0, innerHTML: '', click() { this.clicked += 1; } });
      return els.get(id);
    };
    const context = createContext({
      $: el,
      isRunning: false,
      sessionOk,
      dashRunAsked: false,
      h: (tag, attrs, text) => `[${attrs['data-section']}:${text}]`,
      say: (target, kind, ...parts) => { target.innerHTML = `${kind}: ${parts.flat(2).join('')}`; },
    });
    runInContext(handler, context);
    el('btn-dash-run').onclick();
    return { said: el('run-result').innerHTML, clicked: el('btn-run').clicked, asked: context.dashRunAsked };
  };
  const signedOut = run(false);
  assert.equal(signedOut.said, 'err: Not started. Brightwheel is not connected: connect under [account:Account].');
  assert.equal(signedOut.clicked, 0);
  assert.equal(signedOut.asked, true, 'and the dashboard shows it');
  assert.equal(run(true).said, 'err: Not started. Tick at least one child under [children:Children].');
});
