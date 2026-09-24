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
 *  - Where the photos go is picked, not typed. A browser deliberately withholds absolute
 *    paths from a page, so the folder chooser is opened by the tool itself; the typed field
 *    stays as the fallback for a computer that has no chooser to open.
 *  - What is on screen is what runs. Every setting saves itself the moment it changes, and
 *    "Start saving" sends the whole form again before it starts. A tick that was visible
 *    but not yet stored used to be silently ignored, because the run reads settings from
 *    disk (/design/human-interface-guidelines/feedback).
 */
import { COOKIE_HELP, COOKIE_HELP_CSS, COOKIE_HELP_SCRIPT } from './cookie-help.js';
import { PASTE_CLIENT_SOURCE } from '../paste.js';
import { PHOTOS_DOC_URL, PHOTOS_SCRIPT_URL } from '../photos.js';
import { UPDATING_DOC_URL } from '../updates.js';

export const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Care Album Saver</title>
<style>
  /* Colour: Rosé Pine. Dawn when the computer is in light mode, the main Rosé Pine when it
     is in dark mode — the palette's own pairing. Values from rosepinetheme.com/palette.

     The --rp-* names are the palette, verbatim, and nothing else in this file names a
     colour directly. The semantic names below are made from them. Four are mixed towards
     the palette's own Text, and only as far as reading requires: Dawn's Subtle, Love and
     Gold are drawn for syntax highlighting, where a word is a few characters on a big
     screen, and as sentences on their own tints they fall short of WCAG AA's 4.5:1 —
     Subtle 4.0, Love 3.4, Gold 2.0. Each mix is the least that clears it, measured:
     muted text 5.0, danger 4.6, warning 4.8. Gold stays verbatim wherever it is a border
     or a tint rather than letters. */
  :root {
    color-scheme: light dark;
    --rp-base: #faf4ed; --rp-surface: #fffaf3; --rp-overlay: #f2e9e1;
    --rp-muted: #9893a5; --rp-subtle: #797593; --rp-text: #464261;
    --rp-love: #b4637a; --rp-gold: #ea9d34; --rp-rose: #d7827e;
    --rp-pine: #286983; --rp-foam: #56949f; --rp-iris: #907aa9;
    --rp-hl-low: #f4ede8; --rp-hl-med: #dfdad9; --rp-hl-high: #cecacd;

    --bg: var(--rp-base);
    --surface: var(--rp-surface);
    --surface-sunken: var(--rp-overlay);
    --text: var(--rp-text);
    --text-muted: color-mix(in srgb, var(--rp-subtle) 70%, var(--rp-text));
    --border: var(--rp-hl-med);
    /* Around things that are clicked or typed into: WCAG asks 3:1 of those, which Subtle
       has (4.2) and Muted, the palette's usual border, does not quite (2.9). */
    --border-strong: var(--rp-subtle);
    --accent: var(--rp-pine);
    --accent-hover: color-mix(in srgb, var(--rp-pine) 80%, var(--rp-text));
    --accent-text: var(--rp-surface);
    --accent-tint: color-mix(in srgb, var(--rp-pine) 10%, var(--rp-surface));
    --accent-ink: var(--rp-pine);
    --ok: var(--rp-pine);
    --ok-tint: color-mix(in srgb, var(--rp-foam) 14%, var(--rp-surface));
    --warn: var(--rp-gold);
    --warn-ink: color-mix(in srgb, var(--rp-gold) 35%, var(--rp-text));
    --warn-tint: color-mix(in srgb, var(--rp-gold) 14%, var(--rp-surface));
    --danger: color-mix(in srgb, var(--rp-love) 65%, var(--rp-text));
    --danger-tint: color-mix(in srgb, var(--rp-love) 14%, var(--rp-surface));
    --focus: var(--rp-iris);
    --backdrop: color-mix(in srgb, var(--rp-text) 45%, transparent);
    --radius: 12px;
    --radius-sm: 8px;
    --s1: 4px; --s2: 8px; --s3: 12px; --s4: 16px; --s5: 24px; --s6: 32px;
    --shadow: 0 1px 2px color-mix(in srgb, var(--rp-text) 8%, transparent);

    /* The photo viewer is dark in both modes, so it takes main Rosé Pine's values whatever
       the computer is set to: a photograph is judged against a dark surround. Its scrim
       lets a tenth of the page through on purpose — the dashboard faintly behind the photo
       is what says "still this page", where an opaque black looks like the browser's own
       image tab. Base, Overlay, Highlight Med and High, Subtle, Text and Iris, verbatim. */
    --rp-main-base: #191724; --rp-main-overlay: #26233a; --rp-main-hl-med: #403d52;
    --rp-main-hl-high: #524f67; --rp-main-subtle: #908caa; --rp-main-text: #e0def4;
    --rp-main-iris: #c4a7e7;
    --viewer-scrim: color-mix(in srgb, var(--rp-main-base) 90%, transparent);
    --viewer-control: color-mix(in srgb, var(--rp-main-overlay) 90%, transparent);
    --viewer-control-hover: var(--rp-main-hl-med);
    --viewer-edge: var(--rp-main-hl-high);
    --viewer-ink: var(--rp-main-text);
    --viewer-ink-muted: var(--rp-main-subtle);
    --viewer-focus: var(--rp-main-iris);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --rp-base: #191724; --rp-surface: #1f1d2e; --rp-overlay: #26233a;
      --rp-muted: #6e6a86; --rp-subtle: #908caa; --rp-text: #e0def4;
      --rp-love: #eb6f92; --rp-gold: #f6c177; --rp-rose: #ebbcba;
      --rp-pine: #31748f; --rp-foam: #9ccfd8; --rp-iris: #c4a7e7;
      --rp-hl-low: #21202e; --rp-hl-med: #403d52; --rp-hl-high: #524f67;

      /* On the dark palette Subtle, Gold and Foam read easily as they are (5.5, 10.8, 10.4).
         Pine does not (3.4), so Foam takes the accent here, with Base for its letters. */
      --text-muted: var(--rp-subtle);
      --border-strong: var(--rp-muted);
      --accent: var(--rp-foam);
      --accent-hover: color-mix(in srgb, var(--rp-foam) 70%, var(--rp-text));
      --accent-text: var(--rp-base);
      --accent-tint: color-mix(in srgb, var(--rp-foam) 14%, var(--rp-surface));
      --accent-ink: var(--rp-foam);
      --ok: var(--rp-foam);
      --ok-tint: color-mix(in srgb, var(--rp-foam) 16%, var(--rp-surface));
      --warn-ink: var(--rp-gold);
      --warn-tint: color-mix(in srgb, var(--rp-gold) 16%, var(--rp-surface));
      --danger: color-mix(in srgb, var(--rp-love) 95%, var(--rp-text));
      --danger-tint: color-mix(in srgb, var(--rp-love) 16%, var(--rp-surface));
      --backdrop: color-mix(in srgb, var(--rp-base) 70%, transparent);
      --shadow: 0 1px 2px rgba(0, 0, 0, .4);
    }
  }

  * { box-sizing: border-box; }
  /* The whole type scale, in one place. 112.5% of the browser's own setting — 18px for
     almost everyone — rather than a fixed pixel size, so a parent who has told their
     browser to use larger text still gets larger text. Every size below is in rem and
     follows it. The floor that matters: nothing a person clicks is set below 1rem, and no
     sentence below .875rem. The first two rounds set controls at 14 and 15px, and both
     times the answer was that they were too small. */
  html { -webkit-text-size-adjust: 100%; font-size: 112.5%; }
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

  /* The whole interface is meant to sit on one 1920x1080 screen with a browser toolbar,
     without scrolling. That is roughly 900px of usable height, so the padding below the
     content is a normal gap rather than the 5rem runway a long scrolling page wanted. */
  .wrap { max-width: 56rem; margin: 0 auto; padding: var(--s5) var(--s5) var(--s6); }

  header { display: flex; align-items: center; justify-content: space-between; gap: var(--s4); flex-wrap: wrap; }
  .top-actions { display: flex; gap: var(--s2); }

  /* The two ways out of the main view. Labelled, not icon-only: an icon alone is announced
     as nothing by a screen reader, and a gear means "settings" only to people who have
     been taught that it does. */
  .icon-btn {
    background: var(--surface); color: var(--text); border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm); padding: .4375rem .75rem;
    font: inherit; font-weight: 500; font-size: 1rem; line-height: 1.3; min-height: 2.5rem;
    display: inline-flex; align-items: center; gap: .4375rem; cursor: pointer;
  }
  .icon-btn:hover { background: var(--surface-sunken); }
  .icon-btn .ico { font-size: 1.0625rem; line-height: 1; }

  /* The dashboard. */
  .dash { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: var(--s5); }
  .dash-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--s4); flex-wrap: wrap; }
  .dash-head h2 { font-size: 1.25rem; margin: 0; }
  .dash-stats { color: var(--text-muted); font-size: .9375rem; margin: 0; }
  .dash-actions { display: flex; gap: var(--s2); flex-wrap: wrap; margin-top: var(--s4); }

  /* Thumbnails.
     The full photo is served and the browser scales it: this tool has no image library and
     is not about to gain one for a strip of pictures read off a local disk. A page is
     twenty-four, so eight across makes three rows, which is what the one-screen budget
     allows on a 1080p display — and the whole page is on screen at once, with no box of
     its own to scroll. Narrower windows get fewer across and the page scrolls instead. */
  .gallery {
    display: grid; gap: var(--s2); margin-top: var(--s4);
    grid-template-columns: repeat(8, minmax(0, 1fr));
  }
  @media (max-width: 60rem) {
    .gallery { grid-template-columns: repeat(auto-fill, minmax(6rem, 1fr)); }
  }
  .gallery a {
    display: block; position: relative; aspect-ratio: 1; overflow: hidden;
    border-radius: var(--radius-sm); border: 1px solid var(--border); background: var(--surface-sunken);
    text-decoration: none; color: var(--text-muted);
  }
  .gallery img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .gallery a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  /* A video has no thumbnail without decoding it, so it says what it is instead. */
  .gallery .vid { display: flex; align-items: center; justify-content: center; height: 100%; font-size: 1.75rem; }
  .gallery .cap {
    position: absolute; left: 0; right: 0; bottom: 0; padding: .25rem .375rem;
    background: rgba(0,0,0,.55); color: #fff; font-size: .75rem; line-height: 1.3;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  /* More than a page of them: newest first, a page at a time, and where you are in words. */
  .pager {
    display: flex; align-items: center; justify-content: space-between; gap: var(--s3);
    margin-top: var(--s3);
  }
  .pager-status { margin: 0; color: var(--text-muted); font-size: .9375rem; }

  /* The photo viewer. A modal over the dashboard rather than a page of its own: the photo
     sits on a scrim with the page faintly behind it, the arrows are at the edges of the
     screen and the close button in the corner, and clicking the scrim, Escape, or the
     close button all return to the page exactly as it was. */
  dialog.viewer {
    max-width: none; max-height: none; width: 100vw; height: 100vh; height: 100dvh;
    margin: 0; padding: 0; border: 0; border-radius: 0; overflow: hidden;
    background: transparent; color: var(--viewer-ink);
  }
  dialog.viewer::backdrop { background: var(--viewer-scrim); }
  html:has(dialog.viewer[open]) { overflow: hidden; }
  .viewer-stage {
    height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: var(--s3); padding: var(--s6) calc(3.5rem + var(--s4) * 2);
  }
  .viewer-media {
    display: block; max-width: 100%; max-height: calc(100dvh - 8rem); min-height: 0;
    object-fit: contain; border-radius: var(--radius-sm);
  }
  .viewer-cap { margin: 0; font-size: .9375rem; color: var(--viewer-ink-muted); text-align: center; }
  .viewer-cap b { color: var(--viewer-ink); font-weight: 600; }
  .viewer-btn {
    position: fixed; display: grid; place-items: center; padding: 0;
    width: 3.5rem; height: 3.5rem; min-height: 0; border-radius: 50%;
    background: var(--viewer-control); color: var(--viewer-ink); border: 1px solid var(--viewer-edge);
  }
  .viewer-btn:hover:not(:disabled) { background: var(--viewer-control-hover); }
  /* border-radius again: the page-wide :focus-visible rule further down squares it off. */
  .viewer-btn:focus-visible { outline: 3px solid var(--viewer-focus); outline-offset: 3px; border-radius: 50%; }
  .viewer-btn svg { width: 1.5rem; height: 1.5rem; }
  .viewer-prev { left: var(--s4); top: 50%; transform: translateY(-50%); }
  .viewer-next { right: var(--s4); top: 50%; transform: translateY(-50%); }
  .viewer-close { right: var(--s4); top: var(--s4); }
  @media (max-width: 40rem) {
    /* On a phone the arrows sit over the photo's edges rather than beside it. */
    .viewer-stage { padding: calc(3.5rem + var(--s5)) var(--s2) var(--s5); }
  }

  /* A newer version, in the header: seen on every visit and never in the way. Gold is the
     palette's "look at this", and the dot says "new" to anyone who does not read the words
     first. It stops pulsing for anyone who asks for less motion (the rule further down). */
  .update-pill {
    display: inline-flex; align-items: center; gap: .5rem;
    background: var(--warn-tint); color: var(--warn-ink); border: 1px solid var(--warn);
    border-radius: 999px; padding: .5rem 1.125rem; font-weight: 700;
  }
  .update-pill:hover:not(:disabled) { background: color-mix(in srgb, var(--rp-gold) 28%, var(--surface)); }
  .update-pill .dot { width: .625rem; height: .625rem; border-radius: 50%; background: var(--rp-love); flex: none; animation: pulse 2s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: .3; } }
  .release-notes, .commands {
    margin: 0; padding: var(--s3) var(--s4); white-space: pre-wrap; overflow-wrap: anywhere;
    background: var(--surface-sunken); border: 1px solid var(--border); border-radius: var(--radius-sm);
  }
  .release-notes { max-height: 14rem; overflow: auto; font: inherit; font-size: .9375rem; }
  .commands { font-family: ui-monospace, Menlo, monospace; font-size: .9375rem; }
  #dlg-update h3 { margin: var(--s5) 0 var(--s2); font-size: 1rem; }
  #dlg-update .dlg-body > p { margin: var(--s2) 0; }
  #dlg-update .run-actions { margin-top: var(--s3); }
  .release-notes strong { display: block; margin-top: var(--s2); }
  .release-notes strong:first-child { margin-top: 0; }

  /* Dialogs. */
  dialog {
    border: 1px solid var(--border-strong); border-radius: var(--radius);
    padding: 0; max-width: 46rem; width: calc(100vw - 3rem); max-height: calc(100vh - 4rem);
    background: var(--surface); color: var(--text);
  }
  dialog::backdrop { background: var(--backdrop); }
  .dlg-head {
    display: flex; align-items: center; justify-content: space-between; gap: var(--s4);
    padding: var(--s4) var(--s5); border-bottom: 1px solid var(--border);
    position: sticky; top: 0; background: var(--surface);
  }
  .dlg-head h2 { margin: 0; font-size: 1.125rem; }
  .dlg-body { padding: var(--s5); overflow: auto; max-height: calc(100vh - 9rem); }
  .dlg-body h3 { font-size: 1rem; margin: var(--s5) 0 var(--s2); }
  .dlg-body h3:first-child { margin-top: 0; }
  .dlg-foot { margin-top: var(--s5); padding-top: var(--s4); border-top: 1px solid var(--border); }
  .logs {
    background: var(--surface-sunken); border: 1px solid var(--border); border-radius: var(--radius-sm);
    padding: var(--s3); font: .875rem/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    max-height: 22rem; overflow: auto; white-space: pre-wrap; word-break: break-word;
  }

  /* The name stands on its own: there is no subtitle under it, so the heading carries its
     whole margin and the gap to step 1 is the one deliberate space, not an 8px remnant of
     a paragraph that used to sit between them.

     The name itself is deliberate and is NOT the package's name. This page is the only
     face a parent sees, and it does not carry somebody else's trade mark: "Brightwheel"
     appears here only where it names the service a parent is signing in to, which is what
     a trade mark is for. Do not "fix" this to match the package name. */
  header { margin-bottom: var(--s6); }
  h1 { font-size: 1.875rem; line-height: 1.25; margin: 0; letter-spacing: -.02em; font-weight: 650; }

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

  /* The single link that leaves this page. Underlined as well as coloured, because colour
     is never the only signal (WCAG 1.4.1), and the words "opens in a new tab" are part of
     the link text: the arrow says it to a sighted reader, the words say it to everyone
     else, and a change of context nobody was warned about is the complaint behind WCAG
     3.2.5. Nothing is loaded from the other origin, so the CSP is untouched. */
  a.ext { color: var(--accent-ink); text-underline-offset: 3px; }
  a.ext:hover { color: var(--accent-hover); }
  a.ext .new-tab { font-size: .875rem; }
  a.ext .mark { margin-left: .25em; text-decoration: none; }

  kbd { margin-inline: .15em; }
  .msg li { line-height: 1.9; }
  kbd, code {
    background: var(--surface-sunken); padding: .125rem .4rem; border-radius: 5px;
    font-size: .875rem; color: var(--text);
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
  /* The time field.
     It has always been <input type="time">, which is the operating system's own picker —
     a spinner and a clock on every browser this tool supports, and the only control that
     is already right for somebody using a screen reader or a phone. What it was not was
     recognisable AS a control: at the body font size, in a plain bordered box, it read as
     a text field somebody had typed "19:00" into. So it is now larger than the text around
     it, tabular so the digits do not shift as they change, and given a visible focus ring;
     step="300" makes the spinner move in five-minute jumps, because nobody schedules a
     photo download for 19:03. */
  .time-field {
    font: 600 1.25rem/1.2 ui-monospace, SFMono-Regular, Menlo, monospace;
    font-variant-numeric: tabular-nums;
    padding: .5rem .75rem; min-height: 2.875rem; max-width: 10rem;
    border: 1px solid var(--border-strong); border-radius: var(--radius-sm);
    background: var(--surface); color: var(--text);
  }
  .time-field:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .field-hint { color: var(--text-muted); font-size: .875rem; margin: var(--s2) 0 0; }
  .field-title { margin: 0; font-size: 1rem; }

  textarea, input[type=text], select {
    width: 100%; padding: .6875rem .8125rem;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    font: inherit; font-size: 1rem; line-height: 1.5;
    background: var(--surface); color: var(--text);
    min-height: 2.75rem;
  }
  textarea { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; resize: vertical; }
  #cookie-check { min-height: 1.2em; margin: 6px 0 10px; }
  #cookie-check .good { color: var(--ok); }
  #cookie-check .warn { color: var(--warn-ink); }
  #cookie-check .bad { color: var(--danger); }
  [aria-invalid="true"] { border-color: var(--danger); border-width: 2px; }

  :focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; border-radius: 4px; }
  :focus:not(:focus-visible) { outline: none; }

  /* The label should fill the button it sits in. At .9375rem inside a 2.75rem-tall
     control the text read as small and the padding as accidental; 1.0625rem with a
     slightly tighter line box fills it, and the horizontal padding grows with it so the
     proportions hold rather than the words simply getting bigger in the same box. */
  button {
    background: var(--accent); color: var(--accent-text);
    border: 1px solid transparent; border-radius: var(--radius-sm);
    /* "font: inherit" first and the parts after it, never "font: 600 1rem inherit": a
       CSS-wide keyword cannot share the shorthand with other values, the browser drops
       the whole declaration, and every button falls back to its built-in 13.3px. That
       is what three rounds of "the button text is too small" actually were. */
    padding: .625rem 1.5rem; font: inherit; font-weight: 600; font-size: 1.0625rem; line-height: 1.3;
    cursor: pointer; min-height: 2.875rem; transition: background .15s;
  }
  button:hover:not(:disabled) { background: var(--accent-hover); }
  button:disabled { opacity: .5; cursor: not-allowed; }
  button.secondary { background: var(--surface-sunken); color: var(--text); border-color: var(--border-strong); }
  button.secondary:hover:not(:disabled) { background: var(--border); }
  /* What the hidden attribute means, everywhere. Without this, any rule that sets display —
     .run-actions is flex — quietly beats it, and a control the script hid stays on screen. */
  [hidden] { display: none !important; }
  /* Shown across the top by scripts/demo.js, whose children are invented, and by a
     development copy of the CLI pointed at real settings (cli.ts), so that neither is ever
     mistaken for the production page. */
  .demo-ribbon {
    background: var(--warn-tint); color: var(--warn-ink); border-bottom: 1px solid var(--warn);
    padding: var(--s2) var(--s4); text-align: center; font-weight: 600; font-size: .875rem;
  }
  /* The dashboard has no step numbers, so its notes are not indented under one. */
  .dash .hint { margin-left: 0; }
  /* What the archive is and how it is kept, one plain line each, under the photos. */
  .dash-facts { list-style: none; margin: var(--s4) 0 0; padding: 0; color: var(--text-muted); font-size: .9375rem; }
  .dash-facts li { margin: 0 0 var(--s2); }
  .dash-facts li:empty { display: none; }

  /* Settings: a column of sections on the left, one section showing on the right. The dialog
     has one height, pinned near the top, whichever section shows: re-centring it for each
     section moved the column under the pointer, and a fixed height is also every pixel the
     screen has for the section — the fit rule's whole budget. */
  #dlg-settings { max-width: 64rem; }
  #dlg-settings[open] {
    display: flex; flex-direction: column;
    height: calc(100vh - 2rem); max-height: calc(100vh - 2rem); margin-top: 1rem; margin-bottom: auto;
  }
  .settings-layout { display: grid; grid-template-columns: 13rem minmax(0, 1fr); flex: 1; min-height: 0; }
  #dlg-settings #settings-body { max-height: none; min-height: 0; overflow: auto; overflow-wrap: anywhere; }
  #dlg-settings .hint { max-width: none; }
  .settings-nav {
    display: flex; flex-direction: column; gap: var(--s1);
    padding: var(--s4) var(--s3); border-right: 1px solid var(--border);
  }
  .settings-nav button {
    background: none; color: var(--text); border: 1px solid transparent; text-align: left;
    font-weight: 550; font-size: 1rem; padding: .625rem .875rem; min-height: 2.75rem;
  }
  .settings-nav button:hover:not(:disabled) { background: var(--surface-sunken); }
  /* The current section is marked by more than colour: a bar on its leading edge and bold. */
  .settings-nav button[aria-current="page"] {
    background: var(--accent-tint); color: var(--accent-ink); border-color: var(--accent);
    box-shadow: inset 4px 0 0 var(--accent); font-weight: 700;
  }
  @media (forced-colors: active) {
    .settings-nav button[aria-current="page"] {
      forced-color-adjust: none; background: Highlight; color: HighlightText; border-color: Highlight;
    }
  }
  /* Inside a section the cards lose their own frame: the section is the frame. */
  #dlg-settings .card { border: 0; border-radius: 0; box-shadow: none; padding: 0; margin: 0; background: none; }
  /* A line between the parts of a section — counting only the parts that are showing, or a
     hidden note would leave a line above the first thing on the page — but none between a
     section's heading, its introduction and what it introduces. */
  #dlg-settings .settings-panel > :not([hidden]) ~ :not([hidden]) {
    margin-top: var(--s5); padding-top: var(--s5); border-top: 1px solid var(--border);
  }
  /* The :not([hidden]) repeats are specificity, not logic: they lift these above the rule
     before, whose own :not([hidden]) pair would otherwise win and draw the line anyway. */
  #dlg-settings .settings-panel > .step-head:not([hidden]) + .hint:not([hidden]),
  #dlg-settings .settings-panel > .hint:not([hidden]) + :not([hidden]) { margin-top: var(--s4); padding-top: 0; border-top: 0; }
  /* Step numbers belong to the first-time steps, not to a section of Settings. */
  #dlg-settings .step-head .num { display: none; }
  #dlg-settings .hint, #dlg-settings .body { margin-left: 0; }
  #settings-status:empty { display: none; }
  /* In Settings the steps' first-time explanations make way: the parent has read them, and
     they are what pushed a section past the bottom of the screen. The empty "Advanced options"
     disclosure goes too — its contents are in Save Locations. */
  #dlg-settings .first-run, #dlg-settings details { display: none; }
  /* Also the picture guide, which expands inside Account to several screens: a parent
     reconnecting has the five written steps, and has seen the pictures once already. And
     the screen-reader "Step N of 4" lines, which are about the setup steps, not sections. */
  #dlg-settings .ck-help,
  #dlg-settings #connect-state, #dlg-settings #children-state, #dlg-settings #run-state, #dlg-settings #schedule-state { display: none; }
  /* After a run, the result's sentence says what the three counters say, and the folder it
     offers to open is a button on the dashboard and in Save Locations already. While a run
     is going the counters are the progress, so they stay. */
  #dlg-settings #card-run:not([data-running]) .stats,
  #dlg-settings #card-run:not([data-running]) #run-msg,
  #dlg-settings #card-run:not([data-running]) #bar,
  #dlg-settings #run-result .dir-actions, #dlg-settings #run-result .dir-note { display: none; }
  @media (max-width: 44rem) {
    /* The sections wrap onto a second row rather than scrolling sideways, where the ones
       past the edge could not be seen and a focused one could sit clipped. */
    .settings-layout { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); }
    .settings-nav { flex-direction: row; flex-wrap: wrap; border-right: 0; border-bottom: 1px solid var(--border); }
    .settings-nav button { flex: 0 0 auto; }
  }
  .nowrap { white-space: nowrap; }

  /* A button that opens something on this page, dressed as the link beside it. Still a
     button, so it is reachable and announced as one; it just does not shout. */
  button.linkish {
    background: none; border: 0; padding: 0; min-height: 0; font: inherit;
    color: var(--accent-ink); text-decoration: underline; text-underline-offset: 3px;
  }
  button.linkish:hover:not(:disabled) { background: none; color: var(--accent-hover); }
  .photos-links { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--s2); margin: var(--s4) 0 0; }
  .warn-text { color: var(--warn-ink); font-weight: 600; }

  .msg { margin-top: var(--s4); padding: var(--s3) var(--s4); border-radius: var(--radius-sm); font-size: .9375rem; border: 1px solid transparent; }
  .msg.ok { background: var(--ok-tint); color: var(--ok); border-color: var(--ok); }
  .msg.err { background: var(--danger-tint); color: var(--danger); border-color: var(--danger); }
  .msg.warn { background: var(--warn-tint); color: var(--warn-ink); border-color: var(--warn); }
  .msg b { font-weight: 650; }
  /* The notice across the top when the tool cannot be read (refresh, poll): clear of the
     header above it and of the first card below, which it otherwise sat hard against. */
  #state-error .msg { margin: 0 0 var(--s4); }
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
    cursor: pointer; font-size: 1.0625rem; color: var(--accent-ink); font-weight: 550;
    padding: var(--s2) 0; min-height: 1.5rem;
  }
  details .inner { padding-top: var(--s4); }

  /* The folder field and its three actions. "Choose a folder" sits beside the box because a
     picked path and a typed one are the same setting; saving and opening are separate acts,
     so they get their own row. Everything wraps on a narrow screen rather than squeezing
     the path into a sliver. */
  .dir-row { display: flex; flex-wrap: wrap; gap: var(--s2); align-items: flex-start; }
  .dir-row input[type=text] { flex: 1 1 16rem; width: auto; }
  .dir-row button { flex: 0 0 auto; }
  .dir-actions { display: flex; flex-wrap: wrap; gap: var(--s3); margin-top: var(--s3); }
  /* Kept clear of the buttons above it: a line of small text touching a control reads as
     part of it. The height is reserved so the card does not jump as the note fills. */
  .dir-note { font-size: .875rem; color: var(--text-muted); margin: var(--s3) 0 0; min-height: 1.4em; }
  .dir-note.err { color: var(--danger); font-weight: 550; }

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
  .stat .l { font-size: .875rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: .06em; }

  .path {
    font-family: ui-monospace, Menlo, monospace; font-size: .875rem;
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

  /* Step 1's picture guide. Its rules live in src/web/cookie-help.ts beside the drawings
     they paint, and land here because the page has exactly one stylesheet. */
${COOKIE_HELP_CSS}
</style>
</head>
<body>
<!--__BANNER__-->
<a class="skip" href="#main">Skip to the main content</a>
<div class="wrap">
  <header>
    <h1>Care Album Saver</h1>
    <div class="top-actions">
      <button class="update-pill" id="btn-update" type="button" aria-haspopup="dialog" hidden>
        <span class="dot" aria-hidden="true"></span><span id="update-pill-text">New version</span>
      </button>
      <button class="icon-btn" id="btn-settings" type="button" aria-haspopup="dialog">
        <span class="ico" aria-hidden="true">&#9881;</span> Settings and Maintenance
      </button>
      <button class="icon-btn" id="btn-help" type="button" aria-haspopup="dialog">
        <span class="ico" aria-hidden="true">?</span> FAQ and Docs
      </button>
    </div>
  </header>

  <main id="main">

  <!--
    What this page is for changes the moment setup is finished.

    Until then it is a form, and the four steps below are the whole of it. Afterwards a
    parent opens it for one reason — to find out whether it is still working — and the
    honest answer to that is the photographs that arrived, not a green tick. A tick stays
    green while an archive has been empty since March.

    So the steps move wholesale into Settings once there is a session and a run behind it,
    and this takes their place. Moved, not duplicated: every control keeps its id, its
    handler and its behaviour, and there is exactly one of each in the document.
  -->
  <section class="dash" id="dash" hidden aria-labelledby="h-dash">
    <div class="dash-head">
      <h2 id="h-dash">Your archive</h2>
      <p class="dash-stats" id="dash-stats"></p>
    </div>
    <div class="gallery" id="gallery"></div>
    <div class="pager" id="gallery-pager" hidden>
      <button class="secondary" id="gallery-prev" type="button">&lsaquo; Newer</button>
      <p class="pager-status" id="gallery-status" aria-live="polite"></p>
      <button class="secondary" id="gallery-next" type="button">Older &rsaquo;</button>
    </div>
    <p class="hint" id="dash-empty" hidden>Nothing has been saved yet. Press <b>Save new photos</b> to fetch what is there.</p>
    <div class="dash-actions">
      <button id="btn-dash-run" type="button">Save new photos</button>
      <button class="secondary" id="btn-dash-folder" type="button">Open this folder</button>
      <button class="secondary" id="btn-dash-logs" type="button">View the log</button>
    </div>
    <!-- What used to be the "This is already set up" card, minus its buttons: those are
         Settings' sections now, and every one of them is also a button above or in Settings. -->
    <ul class="dash-facts" aria-label="About your archive">
      <li id="dash-connected"></li>
      <li id="dash-schedule"></li>
      <li id="dash-last"></li>
      <li id="dash-folder"></li>
      <li id="dash-photos" hidden></li>
      <!-- Asked once, then a switch in Settings, under Maintenance. Nothing is sent before the answer. -->
      <li id="ask-updates" hidden><b>Check for new versions once a day?</b> Only GitHub is asked, and nothing about your account or your children is sent.
        <button class="linkish" id="btn-updates-yes" type="button">Yes, check daily</button> <span aria-hidden="true">&middot;</span>
        <button class="linkish" id="btn-updates-no" type="button">No, thanks</button></li>
    </ul>
  </section>

  <div id="setup-flow">
  <ol class="steps-list">
    <li>
      <section class="card" id="card-connect" data-state="active" aria-labelledby="h-connect">
        <div class="step-head">
          <span class="num" aria-hidden="true" id="num-1">1</span>
          <h2 id="h-connect">Connect to your Brightwheel account</h2>
        </div>
        <p class="hint" id="connect-hint">This tool never sees your password. You sign in on Brightwheel&rsquo;s own website, then copy one value across.</p>
        <div class="body">
          <p class="sr-only" id="connect-state">Step 1 of 4. Not started.</p>
          <ol class="howto" id="howto"></ol>
          ${COOKIE_HELP}
          <p class="why-ask first-run">
            <b>Why this is needed:</b> it is how the tool proves to Brightwheel that it is
            you, so it can see your own children&rsquo;s photos. It stays on this computer,
            it is not your password, and signing out of Brightwheel should cancel it
            (Brightwheel does not say how quickly).
          </p>
          <div class="field">
            <label class="field-label" for="cookie">Paste the value here</label>
            <textarea id="cookie" rows="3" aria-describedby="connect-hint cookie-check connect-msg" spellcheck="false" autocomplete="off" autocapitalize="off" autocorrect="off" data-1p-ignore data-lpignore="true"></textarea>
            <div id="cookie-check" class="hint" aria-live="polite"></div>
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
          <p class="sr-only" id="children-state">Step 2 of 4. Waiting for step 1.</p>
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

          <div class="field" id="dir-field">
            <label class="field-label" for="archiveDir">Where to save the photos</label>
            <div class="dir-row">
              <input type="text" id="archiveDir" spellcheck="false" aria-describedby="dir-warn dir-note config-msg">
              <button class="secondary" id="btn-choose-dir" type="button">Choose a folder&hellip;</button>
            </div>
            <p class="why" id="dir-warn" style="color:var(--text-muted);font-size:.875rem;margin:var(--s2) 0 0">Avoid iCloud Drive, Dropbox or OneDrive folders unless you want copies on their servers.</p>
            <div class="dir-actions">
              <button class="secondary" id="btn-dir" type="button">Use this folder</button>
              <button class="secondary" id="btn-open-dir" type="button">Open this folder</button>
            </div>
            <p class="dir-note" id="dir-note" role="status" aria-live="polite"></p>
          </div>

          <details>
            <summary>Advanced options</summary>
            <div class="inner" id="advanced-inner">
              <div class="field">
                <label class="field-label" for="organiseBy">Folder layout</label>
                <select id="organiseBy">
                  <option value="child-then-week">Each child, then a folder per week (recommended)</option>
                  <option value="week">One folder per week, all children together</option>
                  <option value="week-per-child">Each week, then a folder per child</option>
                </select>
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
        <p class="hint first-run">This is the one-time part: the first run fetches everything you already have, so it takes a while. Every run after it only looks for what is new, which takes a moment. You can close this page &mdash; it keeps going in the black window you started it from. Step 4 is what makes it happen without you.</p>
        <div class="body">
          <p class="sr-only" id="run-state">Step 3 of 4. Waiting for step 1.</p>
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

    <li>
      <section class="card" id="card-schedule" aria-labelledby="h-schedule">
        <div class="step-head">
          <span class="num" aria-hidden="true" id="num-4">4</span>
          <h2 id="h-schedule">Keep it up to date on its own</h2>
        </div>
        <p class="hint first-run">Steps 1 to 3 happen once. This one is what turns them into something that looks after itself, so that next month&rsquo;s photos arrive without you remembering to come back here.</p>
        <div class="body">
          <p class="sr-only" id="schedule-state">Step 4 of 4. Optional.</p>
          <p class="why-ask first-run">
            <b>What a scheduled task is:</b> a note in your own computer&rsquo;s diary that says
            &ldquo;run this at seven every evening&rdquo;. Your computer does it &mdash; not a
            website, not a server somewhere &mdash; and it only happens while the computer is
            switched on and you are logged in. If it is asleep or shut at that time the run is
            not lost; it happens the next time the computer is awake.
          </p>
          <div class="field">
            <label class="field-label" for="schedule-time">What time each day?</label>
            <input type="time" id="schedule-time" value="19:00" step="300" aria-describedby="schedule-msg schedule-time-hint" class="time-field">
            <p class="field-hint" id="schedule-time-hint">Evening works well: the nursery day is over, so the day&rsquo;s photos are all there. If the computer is off or asleep then, the run happens the next time it is on.</p>
          </div>
          <div class="run-actions">
            <button id="btn-schedule-on" type="button">Save new photos every day</button>
            <button class="secondary" id="btn-schedule-off" type="button" hidden>Stop saving them automatically</button>
          </div>
          <div id="schedule-msg" role="status" aria-live="polite"></div>
          <p class="first-run" style="color:var(--text-muted);font-size:.9375rem;margin:var(--s4) 0 0">
            <b>You do not have to.</b> Leave this off and nothing changes: whenever you want the
            newest photos, start the tool again and press <b>Start saving</b> in step 3. It only
            ever looks for what is new, so it is quick.
          </p>
        </div>
      </section>
    </li>
  </ol>

  </div>
  </main>

</div>

<!-- Settings and Maintenance, one section at a time, chosen from the column on the left.
     Once setup is done the setup steps are MOVED into these sections, never copied: there is
     one of each control in the document, so a setting cannot be changed in one place and
     left behind in another. Nothing in here folds away; a section is short enough to see
     whole, which is what a dropdown inside a dialog made impossible. -->
<dialog id="dlg-settings" aria-labelledby="h-settings">
  <div class="dlg-head">
    <h2 id="h-settings">Settings and Maintenance</h2>
    <button class="icon-btn" id="btn-settings-close" type="button">Close</button>
  </div>
  <div class="settings-layout">
    <nav class="settings-nav" aria-label="Settings sections">
      <button type="button" data-go="account" aria-current="page">Account</button>
      <button type="button" data-go="children">Children</button>
      <button type="button" data-go="save">Save Locations</button>
      <button type="button" data-go="schedule">Schedule</button>
      <button type="button" data-go="integrations">Integrations</button>
      <button type="button" data-go="maintenance">Maintenance</button>
    </nav>
  <div class="dlg-body" id="settings-body">
    <section class="settings-panel" data-panel="account" aria-label="Account"></section>
    <section class="settings-panel" data-panel="children" aria-label="Children" hidden></section>
    <section class="settings-panel" data-panel="save" aria-labelledby="h-save" hidden>
      <div class="step-head"><h2 id="h-save">Save Locations</h2></div>
      <p class="hint">Where the photos go on this computer, and how the folders inside are laid out.</p>
    </section>
    <section class="settings-panel" data-panel="schedule" aria-label="Schedule" hidden></section>
    <section class="settings-panel" data-panel="integrations" aria-label="Integrations" hidden>
      <p class="hint" id="integrations-none">Nothing to connect to on this computer yet. Adding photos to Apple Photos needs a Mac.</p>

    <!-- Settings-only, never part of the setup steps: it is nobody's first decision, and it
         is the one choice that can send photos off this computer. Hidden where there is
         no Photos app to add to. -->
    <section class="card" id="card-photos" aria-labelledby="h-photos" hidden>
      <div class="step-head">
        <h2 id="h-photos">Also add them to Apple Photos</h2>
      </div>
      <p class="hint">Off unless you turn it on. Your photos are saved in your own folder either way; this also puts a copy of each new one in the Photos app.</p>
      <div class="body">
        <div class="opt">
          <input type="checkbox" id="addToPhotos" aria-describedby="photos-why photos-status photos-msg">
          <label for="addToPhotos">Add new photos to the Photos app after each run
            <span class="why" id="photos-why">They go into a folder called <b>Brightwheel</b> in Photos, with the same folders and weekly albums as on disk. <b>If you use iCloud Photos, Photos then uploads them to your iCloud account</b> &mdash; the one way anything this tool saves leaves your computer. The first time, your Mac asks whether to allow it; choose <b>OK</b>.</span>
          </label>
        </div>
        <p class="hint" id="photos-status" aria-live="polite"></p>
        <p class="hint" id="photos-cloud" hidden></p>
        <div class="run-actions" id="photos-earlier-row" hidden>
          <button class="secondary" id="btn-photos-earlier" type="button">Add the ones saved before you turned this on</button>
        </div>
        <div id="photos-msg" role="status" aria-live="polite"></div>
        <p class="hint photos-links">
          <button class="linkish" id="btn-photos-faq" type="button">How this works</button>
          <span aria-hidden="true">&middot;</span>
          <a class="ext" href="${PHOTOS_SCRIPT_URL}" target="_blank" rel="noopener noreferrer">Read the script it runs <span class="new-tab">(opens in a new tab)</span><span class="mark" aria-hidden="true">&#8599;</span></a>
        </p>
      </div>
    </section>
    </section>

    <section class="settings-panel" data-panel="maintenance" aria-labelledby="h-maint" hidden>
      <div class="step-head"><h2 id="h-maint">Checking on the archive</h2></div>
      <p class="hint">Each of these answers a question and changes nothing on its own. If something needs fixing, it says so and asks first.</p>
      <div class="field">
        <button class="secondary" id="m-children" type="button">Has a child been added or left?</button>
        <p class="field-hint">Asks Brightwheel who is on your account now and compares that with the photos already saved.</p>
        <div id="m-children-out" role="status" aria-live="polite"></div>
      </div>
      <div class="field">
        <button class="secondary" id="m-check" type="button">Check the folder against the list</button>
        <p class="field-hint">The tool keeps a list of everything it has saved. This compares that list with what is really in the folder, and reports anything on one side and not the other.</p>
        <div id="m-check-out" role="status" aria-live="polite"></div>
      </div>
      <div class="field">
        <button class="secondary" id="m-dupes" type="button">Find photos saved twice</button>
        <p class="field-hint">A run that was force-quit can fetch the same photo again under a new name. This finds copies that are identical down to the last byte. It only ever shows them &mdash; nothing is deleted unless you say so.</p>
        <div id="m-dupes-out" role="status" aria-live="polite"></div>
      </div>
      <div class="field">
        <h3 class="field-title">Updates</h3>
        <p class="field-hint" id="version-line">This is Care Album Saver.</p>
        <div class="opt">
          <input type="checkbox" id="checkForUpdates" aria-describedby="updates-why updates-status">
          <label for="checkForUpdates">Check for new versions once a day
            <span class="why" id="updates-why">While this page is open, it asks GitHub which version is the newest. Nothing about your account, your children or your photos is sent, and the daily run never asks.</span>
          </label>
        </div>
        <p class="hint" id="updates-status" aria-live="polite"></p>
        <div class="run-actions">
          <button class="secondary" id="btn-update-check" type="button">Check now</button>
          <button class="secondary" id="btn-update-how" type="button" aria-haspopup="dialog" hidden>How to update</button>
        </div>
      </div>
    </section>
    <!-- The "Saved" line serves every section, so in Settings it sits under whichever shows. -->
    <div id="settings-status"></div>
  </div>
  </div>
</dialog>

<!-- Everything a parent might wonder rather than do. -->
<dialog id="dlg-help" aria-labelledby="h-help">
  <div class="dlg-head">
    <h2 id="h-help">FAQ and Docs</h2>
    <button class="icon-btn" id="btn-help-close" type="button">Close</button>
  </div>
  <div class="dlg-body">
    <h3>Where your photos go</h3>
    <p>From Brightwheel straight onto this computer, into <span class="path" id="p-dir">your chosen folder</span>. Nothing is uploaded anywhere else &mdash; unless you turn on adding them to Apple Photos and use iCloud Photos, which is described below. There is no online account to sign up for, and nothing is collected about you.</p>
    <p>This page is being served by the program running on your own computer &mdash; that is why the address starts with 127.0.0.1, which means <em>this machine only</em>. Nobody else on your network can open it, and it disappears when you stop the program.</p>

    <h3>Why does it want a cookie rather than my password?</h3>
    <p>So that it never has one. You sign in on Brightwheel&rsquo;s own website, and copy across a value that says &ldquo;this browser is already signed in&rdquo;. It is kept on this computer only, in a file only you can open, and it is sent only back to Brightwheel. If you ever think it has leaked, sign out of Brightwheel on their website and change your password.</p>

    <h3>What date do the photos get?</h3>
    <p>The time each one was <b>posted</b> to Brightwheel, which for a nursery is usually minutes after it was taken and nearly always the same day. The moment the shutter clicked is not something Brightwheel gives out &mdash; the photos arrive with nothing inside them at all, which is why a photo saved from the website lands in your photo app stamped with the moment you clicked.</p>

    <h3>Will it download everything again?</h3>
    <p>No. The first run fetches what is already there and takes a while; every run after it looks only for what is new. It keeps its own list, in <span class="path">archive.json</span> at the top of your photos folder.</p>

    <h3>What happens if the computer is off at the scheduled time?</h3>
    <p>The run happens the next time it is on. Each operating system has its own way of catching up on a job it missed, and this uses that rather than a timer of its own.</p>

    <h3 id="faq-photos" tabindex="-1">Can it add them to Apple Photos or iCloud Photos?</h3>
    <p>Yes, on a Mac, if you turn it on under <b>Settings and Maintenance</b>. It is off unless you do. After each run, the new photos are added to the Photos app in a folder called <b>Brightwheel</b>, with the same folders and weekly albums as on disk &mdash; for example <span class="nowrap">Brightwheel &rsaquo; Robin-Maple &rsaquo; 2026-W38</span>.</p>
    <p><b>If iCloud Photos is on, Photos uploads them to your iCloud account</b>, and from there to your iPhone and anything else signed in to it. That is Apple&rsquo;s service rather than this tool&rsquo;s, and it counts against your iCloud storage. The copies in your own folder stay where they are either way, and turning this off again stops new ones being added without removing any.</p>
    <p>Turning it on covers photos saved from then on. The ones already in your folder are only added if you press <b>Add the ones saved before you turned this on</b>, because you may have put some of them into Photos yourself already, and those would then appear twice.</p>
    <p>It works by running one short AppleScript, and that is all it ever asks Photos to do. You can read it before you turn this on:
      <a class="ext" href="${PHOTOS_SCRIPT_URL}" target="_blank" rel="noopener noreferrer">add-to-photos.applescript <span class="new-tab">(opens in a new tab)</span><span class="mark" aria-hidden="true">&#8599;</span></a>.
      The whole explanation, including what to do if your Mac says no, is in
      <a class="ext" href="${PHOTOS_DOC_URL}" target="_blank" rel="noopener noreferrer">docs/PHOTOS.md <span class="new-tab">(opens in a new tab)</span><span class="mark" aria-hidden="true">&#8599;</span></a>.</p>

    <h3>Does it check for new versions?</h3>
    <p>Only if you say yes. The first time you see your archive it asks once; your answer is a switch under <b>Settings and Maintenance &rsaquo; Maintenance &rsaquo; Updates</b>, which also shows which version this is. If you say yes, this page asks GitHub once a day, while it is open, which version is the newest &mdash; the daily run never asks. GitHub learns your computer&rsquo;s internet address and nothing else: no account, no children, no photos. When there is a newer version, a gold button beside Settings shows what is new and the steps for the way you installed it.
      <a class="ext" href="${UPDATING_DOC_URL}" target="_blank" rel="noopener noreferrer">The update guide <span class="new-tab">(opens in a new tab)</span><span class="mark" aria-hidden="true">&#8599;</span></a></p>

    <h3>Where is everything kept?</h3>
    <p>The photos go where you chose. The settings and your saved session live in a folder outside this one, which <span class="path">care-album-saver where</span> will print for you.</p>

    <p class="dlg-foot">This is free software, and the code is there to be read.
      <a class="ext" href="https://github.com/ip2k/care-album-saver" target="_blank" rel="noopener noreferrer">The project on GitHub <span class="new-tab">(opens in a new tab)</span><span class="mark" aria-hidden="true">&#8599;</span></a>
    </p>
  </div>
</dialog>

<!-- The daily run's own log. -->
<dialog id="dlg-logs" aria-labelledby="h-logs">
  <div class="dlg-head">
    <h2 id="h-logs">The daily run&rsquo;s log</h2>
    <button class="icon-btn" id="btn-logs-close" type="button">Close</button>
  </div>
  <div class="dlg-body">
    <p class="hint" id="logs-where"></p>
    <pre class="logs" id="logs-text" tabindex="0"></pre>
    <div class="dash-actions">
      <button class="secondary" id="btn-logs-open" type="button">Open it in this computer&rsquo;s log viewer</button>
    </div>
    <div id="logs-msg" role="status" aria-live="polite"></div>
  </div>
</dialog>

<!-- A newer version: what is in it, and how to update the copy this page is running from. -->
<dialog id="dlg-update" aria-labelledby="h-update">
  <div class="dlg-head">
    <h2 id="h-update">A new version is available</h2>
    <button class="icon-btn" id="btn-update-close" type="button">Close</button>
  </div>
  <div class="dlg-body">
    <p id="update-versions"></p>
    <h3>What&rsquo;s new</h3>
    <pre class="release-notes" id="update-notes" tabindex="0"></pre>
    <p class="hint"><a class="ext" id="update-release-link" href="${UPDATING_DOC_URL}" target="_blank" rel="noopener noreferrer">The release on GitHub <span class="new-tab">(opens in a new tab)</span><span class="mark" aria-hidden="true">&#8599;</span></a></p>
    <h3>How to update</h3>
    <p id="update-installed"></p>
    <p id="update-before"></p>
    <pre class="commands" id="update-commands" tabindex="0"></pre>
    <div class="run-actions" id="update-copy-row">
      <button class="secondary" id="btn-update-copy" type="button">Copy the commands</button>
    </div>
    <p id="update-after"></p>
    <div id="update-copy-msg" role="status" aria-live="polite"></div>
    <p class="hint"><a class="ext" href="${UPDATING_DOC_URL}" target="_blank" rel="noopener noreferrer">Installed some other way? The update guide covers each one <span class="new-tab">(opens in a new tab)</span><span class="mark" aria-hidden="true">&#8599;</span></a></p>
  </div>
</dialog>

<!-- The photo viewer. Arrow keys and the edge buttons step through the last run's photos;
     Escape, the close button, or a click anywhere on the dark area around the photo close it. -->
<dialog id="viewer" class="viewer" aria-label="Photo viewer">
  <div class="viewer-stage">
    <img class="viewer-media" id="viewer-img" alt="">
    <video class="viewer-media" id="viewer-video" controls playsinline preload="metadata" hidden></video>
    <p class="viewer-cap" id="viewer-cap" aria-live="polite"></p>
    <p class="viewer-cap" id="viewer-unplayable" role="status" hidden>This browser cannot play this video. It is saved in your folder, where the computer&rsquo;s own video player can.</p>
  </div>
  <button class="viewer-btn viewer-close" id="viewer-close" type="button" aria-label="Close the photo" title="Close (Esc)" autofocus>
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
  </button>
  <button class="viewer-btn viewer-prev" id="viewer-prev" type="button" aria-label="Previous photo" title="Previous (&larr;)">
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>
  </button>
  <button class="viewer-btn viewer-next" id="viewer-next" type="button" aria-label="Next photo" title="Next (&rarr;)">
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>
  </button>
</dialog>

<!-- The page's one script. It runs because it carries this response's nonce, which the
     Content-Security-Policy names, and nothing else in the page can run: there are no inline
     event-handler attributes, and no 'unsafe-inline' (security review page-3). -->
<script nonce="__NONCE__">
const TOKEN = '__TOKEN__';
const $ = (id) => document.getElementById(id);
// The token goes in the header only. The tool refuses it in the address of any /api/* request;
// only the page's own link and /photo (an <img> cannot send a header) carry it there (Q10).
const api = (path, opts = {}) => fetch(path, {
  ...opts, headers: { 'content-type': 'application/json', 'x-setup-token': TOKEN, ...(opts.headers || {}) }
});

/**
 * An element, its attributes and what goes in it. A string (or a number) among the children
 * is always a text node, so what the tool, Brightwheel or the disk says — a child's name, an
 * error, a folder — is shown as written and never read as markup, whatever it contains.
 * Null, undefined, false and empty strings are left out, so a part can hang on a condition,
 * and arrays are flattened, so a list of parts can be passed as one.
 *
 * This is how anything that did not come from this file reaches the page (security review
 * page-3). It replaced an escaper applied at each call site of innerHTML, which was right at
 * all twenty of them and would have stopped being right the first time one was missed.
 */
const parts = (children) => children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false && c !== '');
const h = (tag, attrs, ...children) => {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs || {})) el.setAttribute(name, value);
  el.append(...parts(children));
  return el;
};
/** Replace what is in el with children, taken as h() takes them. */
const put = (el, ...children) => el.replaceChildren(...parts(children));
const bold = (text) => h('b', null, text);
/** A folder or file name, set in the monospaced pill. */
const pathPill = (text) => h('span', { class: 'path' }, text);
/** A message box whose parts are text or elements from h(): for anything with the tool's words in it. */
const say = (el, kind, ...children) => put(el, h('div', { class: 'msg ' + kind }, ...children));
/** A message box from markup written in this file, and only that: anything else goes through say(). */
const show = (el, kind, html) => { el.innerHTML = '<div class="msg ' + kind + '">' + html + '</div>'; };

/**
 * Browser-specific instructions. The keystroke and the menu path genuinely differ, and a
 * parent following Chrome steps in Safari simply fails — Safari hides the Develop menu
 * until you turn it on, which is a dead end nobody guesses their way out of.
 *
 * Step one is a real link rather than an address to retype: a parent who mistypes it lands
 * on somebody else's site and signs in there. It opens in a new tab so this page, and the
 * box they are about to paste into, stay exactly where they left them. Following it sends
 * nothing away with it — the response carries Referrer-Policy: no-referrer, and the link
 * carries noreferrer too, so the setup token in this page's address never travels.
 */
function howToSteps() {
  const open = BROWSER === 'safari'
    ? 'Turn on the developer menu first: Safari menu &rarr; <b>Settings</b> &rarr; <b>Advanced</b> &rarr; tick <b>Show features for web developers</b>. Then press <kbd>Option</kbd>+<kbd>Cmd</kbd>+<kbd>I</kbd>.'
    : 'Press <kbd>F12</kbd> (or <kbd>Option</kbd>+<kbd>Cmd</kbd>+<kbd>I</kbd> on a Mac).';
  const where = BROWSER === 'chrome'
    ? 'Click <b>Application</b> along the top, then <b>Cookies</b> on the left.'
    : 'Click <b>Storage</b> along the top, then <b>Cookies</b> on the left.';
  return [
    'Open <a class="ext" href="https://schools.mybrightwheel.com/" target="_blank" rel="noopener noreferrer"><b>schools.mybrightwheel.com</b> <span class="new-tab">(opens in a new tab)</span><span class="mark" aria-hidden="true">&#8599;</span></a> and sign in as you normally would.',
    open,
    where,
    'Find the row named <code>_brightwheel_v2</code> and copy what is in its <b>Value</b> column.',
    'Paste it in the box below and press Connect.',
  ];
}
/** The reader's browser, told once, for these steps and for the picture guide below (page-12). */
const BROWSER = /Firefox\//.test(navigator.userAgent) ? 'firefox'
  : /Safari\//.test(navigator.userAgent) && !/Chrome|Chromium|Edg\//.test(navigator.userAgent) ? 'safari' : 'chrome';
$('howto').innerHTML = howToSteps().map((s) => '<li>' + s + '</li>').join('');

/* The picture guide that illustrates those same five steps. Written in
   src/web/cookie-help.ts beside its drawings, and folded in here because the page has
   exactly one script — a test compiles it to prove the whole thing parses. */
${COOKIE_HELP_SCRIPT}

function setStep(card, numEl, srEl, state, srText) {
  // The step's own number, kept the first time, so that a step which has to be done again
  // — a session Brightwheel stopped accepting — shows its number rather than a tick.
  if (!numEl.dataset.n) numEl.dataset.n = numEl.textContent;
  card.dataset.state = state;
  numEl.textContent = state === 'complete' ? '✓' : numEl.dataset.n;
  if (state === 'complete') card.setAttribute('aria-current', 'false');
  else if (state === 'active') card.setAttribute('aria-current', 'step');
  else card.removeAttribute('aria-current');
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
  applySaved(d);
  return true;
}

/**
 * What the whole page does with a settings change the tool accepted. Shared with the folder
 * chooser, so a picked folder lands on screen exactly as a typed one does — same stored
 * path, same cloud-folder warning, same quiet "Saved".
 */
function applySaved(d) {
  savedDir = d.config.archiveDir;
  // The dashboard's "Photos are in" and the end-of-run folder read from state, which is
  // otherwise only refreshed on load — so a folder chosen since would show the old one.
  if (state) {
    state.config.archiveDir = d.config.archiveDir;
    if (d.archiveDirShown) state.archiveDirShown = d.archiveDirShown;
    paintFacts();
  }
  // Always the stored folder, never the typed one: this says where the photos will go.
  $('p-dir').textContent = d.config.archiveDir;
  if (d.warning) say($('config-msg'), 'warn', d.warning);
  else savedNote();
}

function savedNote() {
  const el = $('config-msg');
  // A refused folder shares this box with the note, and the note must never be what
  // removes it: the refusal is the only thing saying the photos are not going where the
  // person just typed. It is put back because it is still true — the tick that saved did
  // not fix it.
  const restore = () => {
    el.textContent = '';
    if (dirError) say(el, 'err', dirError);
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

/** In Settings, the section holding el, brought forward: a refusal is no use behind another section. */
function revealSection(el) {
  const panel = el && el.closest('.settings-panel');
  if (panel && panel.hidden) showSection(panel.dataset.panel);
}

function showSaveError(d, opts) {
  const text = d.error || 'Could not save those settings.';
  if (d.field === 'includeStudents') {
    const st = $('kids-status');
    if (opts && opts.focus) revealSection(st);
    st.classList.add('err');
    st.textContent = text;
    updateRunReady();
    return;
  }
  say($('config-msg'), 'err', text);
  if (d.field === 'archiveDir') {
    dirError = text;
    $('archiveDir').setAttribute('aria-invalid', 'true');
    // Only move focus when the person pressed something; stealing it as they tab away
    // from the field would trap them in it.
    // The field is out in the open now, so there is no disclosure to prise open first.
    if (opts.focus) {
      revealSection($('archiveDir'));
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
  if (!sessionOk) $('run-state').textContent = 'Step 3 of 4. Waiting for step 1.';
  else if (none) $('run-state').textContent = 'Step 3 of 4. Cannot start until at least one child is ticked in step 2.';
  else $('run-state').textContent = 'Step 3 of 4. Ready to start.';
}

/** Settings cannot change under a run that has already read them, so say so. */
function lockSettings(locked) {
  // By the pieces, not by their old card: the folder field and the advanced options leave
  // step 2 for Save Locations once setup is done, and a run must lock them there too.
  const lockable = '#card-children input, #card-children select, #card-children button, ' +
    '#dir-field input, #dir-field button, #advanced-inner input, #advanced-inner select';
  for (const el of document.querySelectorAll(lockable)) {
    el.disabled = locked;
  }
  const msg = $('config-msg');
  if (locked) msg.innerHTML = '<span class="saved" data-note="lock" style="color:var(--text-muted)">Settings are locked while saving is in progress.</span>';
  else if (msg.firstElementChild?.dataset.note === 'lock') msg.textContent = '';
}

/**
 * Which of the two things this page is, right now.
 *
 * Setup when there is no session, or when the last run failed in a way only a new session
 * can cure — that second case is the one that matters, because an expired cookie is the
 * single reason a working archive stops, and a parent who comes back to a dashboard saying
 * "12 photos, three weeks ago" has been told nothing about what to do. Otherwise the
 * dashboard: they are here to see that it is still working.
 */
function needsSetup(s) {
  // No session at all: the first thing to do is the first step. Nor one Brightwheel has
  // stopped accepting, found when the page asked who is on the account (loadChildren).
  if (!s.hasSession || s.sessionRejected) return true;
  // A run Brightwheel refused for its session, which the server marks as such. A field, not
  // words: any error that happened to mention a session used to count.
  if (s.progress && s.progress.phase === 'error' && s.progress.reason === 'session') return true;
  // Connected, but nothing has ever been saved. There is no gallery to show and the steps
  // are not finished — choosing a folder and pressing the button are still ahead. Showing a
  // dashboard here would hide the rest of setup the moment the cookie was pasted.
  return !s.archive || s.archive.totalFiles === 0;
}

/**
 * What moves into which section of Settings once setup is done. Each piece keeps a marker at
 * its place in the steps, so going back to setup — a session that expired — puts every one
 * of them exactly where it was. The folder field and the advanced options leave step 2 for
 * Save Locations; the advanced options leave their dropdown as well, because nothing in
 * Settings folds away.
 */
const MOVED = [
  ['card-connect', 'account'],
  ['card-children', 'children'],
  ['dir-field', 'save'],
  ['advanced-inner', 'save'],
  ['card-run', 'schedule'],
  ['card-schedule', 'schedule'],
  ['config-msg', null],
].map(([id, panel]) => {
  const node = $(id);
  const home = document.createComment(' #' + id + ' lives here during setup ');
  node.before(home);
  return { node, panel, home };
});

const panelFor = (name) => document.querySelector('.settings-panel[data-panel="' + name + '"]');
const sectionButtons = () => [...document.querySelectorAll('.settings-nav button')];
/** The four sections that are the setup steps themselves, shown on the page during setup. */
const STEP_SECTIONS = ['account', 'children', 'save', 'schedule'];

function showSection(name) {
  for (const panel of document.querySelectorAll('.settings-panel')) panel.hidden = panel.dataset.panel !== name;
  // The "Saved" line and the lock note belong to the controls in Children and Save
  // Locations; under any other section they are height with nothing to do with it.
  $('settings-status').hidden = !['children', 'save'].includes(name);
  for (const b of sectionButtons()) {
    if (b.dataset.go === name) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
}

/** Open Settings, at a section when the caller knows which one the parent needs. */
function openSettings(name) {
  if (name) showSection(name);
  openDialog('dlg-settings');
}

for (const b of sectionButtons()) b.onclick = () => showSection(b.dataset.go);
// Messages can point at a section by name; the name is a button that goes there.
document.addEventListener('click', (e) => {
  const to = e.target.closest && e.target.closest('[data-section]');
  if (to) showSection(to.dataset.section);
});

/**
 * Put the setup flow where it belongs for the current view.
 *
 * MOVED between the page and the Settings dialog, never copied. Every control keeps its
 * id and its handler, so there is one archive-folder field in the document and one set of
 * tick boxes, whichever view is showing — which is the only way this could be done without
 * two of everything quietly drifting apart.
 */
function placeSetupFlow(inSettings) {
  for (const m of MOVED) {
    const target = m.panel ? panelFor(m.panel) : $('settings-status');
    // Only when it is not already there: moving a node that holds focus drops the focus,
    // and this runs on every refresh, including while someone is typing in Settings.
    if (inSettings) {
      if (m.node.parentElement !== target) target.appendChild(m.node);
    } else if (m.home.nextSibling !== m.node) {
      m.home.after(m.node);
    }
  }
  // Going back to setup — a session that expired — puts the steps on the page, so a dialog
  // still open over them would be showing the leftovers of something that has moved.
  const wasInSettings = $('setup-flow').hidden;
  if (!inSettings && wasInSettings && $('dlg-settings').open) closeDialog('dlg-settings');
  $('setup-flow').hidden = inSettings;
  $('dash').hidden = !inSettings;
  // During setup those four are on the page itself, so Settings offers only the rest.
  for (const b of sectionButtons()) b.hidden = !inSettings && STEP_SECTIONS.includes(b.dataset.go);
  const current = sectionButtons().find((b) => b.getAttribute('aria-current') === 'page');
  if (!current || current.hidden) showSection(inSettings ? 'account' : 'integrations');
}

const day = (iso) => {
  if (!iso) return 'never';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
};

/** The archive, in one sentence and every photo its last run saved, a page at a time. */
function paintDashboard(s) {
  const a = s.archive;
  if (!a) return;
  const stats = $('dash-stats');
  stats.textContent = a.totalFiles === 0
    ? 'Nothing saved yet.'
    : a.totalFiles + ' photos and videos, ' + a.totalSize +
      ' — newest posted ' + day(a.newestPostedAt) +
      '. Last run saved ' + a.lastRunCount + ', on ' + day(a.lastSavedAt) + '.';

  // A different run from the one on screen starts again at its newest page. The same run —
  // the page repainted after a settings change — stays on the page somebody was looking at.
  const stamp = a.lastSavedAt + '|' + a.lastRunCount;
  if (stamp !== gallery.stamp) {
    gallery.stamp = stamp;
    gallery.cache = new Map([[0, a.recent]]);
    gallery.page = 0;
  }
  gallery.count = a.lastRunCount;
  gallery.pages = a.pages;
  gallery.size = a.pageSize;
  $('dash-empty').hidden = a.lastRunCount > 0;
  paintGallery();
}

/* ------------------------------------------------------------------ the last run's photos

   Every photo the most recent run saved, newest first, twenty-four to a page. The first
   page arrives with /api/state; the others are asked for when somebody pages to them or
   steps past the end of a page in the viewer, and are kept until a different run replaces
   them. An index here is a place in the run (0 is its newest photo), never a manifest id. */
const gallery = { stamp: '', cache: new Map(), page: 0, pages: 1, count: 0, size: 24, painting: 0 };

async function galleryPage(n) {
  if (!gallery.cache.has(n)) {
    const r = await api('/api/gallery?page=' + n);
    if (!r.ok) return [];
    const d = await r.json();
    gallery.cache.set(n, d.recent);
  }
  return gallery.cache.get(n);
}

async function galleryItem(index) {
  if (index < 0 || index >= gallery.count) return null;
  const page = Math.floor(index / gallery.size);
  const items = await galleryPage(page);
  return items[index - page * gallery.size] || null;
}

const photoHref = (item) => '/photo?i=' + item.id + '&token=' + TOKEN;
const postedOn = (item) => item.postedAt
  ? new Date(item.postedAt).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })
  : 'an unknown day';

async function paintGallery() {
  const run = ++gallery.painting;
  const page = gallery.page;
  const items = await galleryPage(page);
  if (run !== gallery.painting) return;
  const g = $('gallery');
  g.innerHTML = '';
  items.forEach((item, i) => {
    const index = page * gallery.size + i;
    const a2 = document.createElement('a');
    // Still a link, so a middle-click or Cmd-click opens the file in a tab of its own; a
    // plain click opens the viewer over the page instead.
    a2.href = photoHref(item);
    a2.target = '_blank';
    a2.rel = 'noopener';
    a2.dataset.index = String(index);
    // The caption is what a screen reader gets, so it is the child and the date rather
    // than a filename. The note is not in it: notes name other people's children.
    const when = item.postedAt ? new Date(item.postedAt).toLocaleDateString() : '';
    a2.title = item.label;
    a2.setAttribute('aria-label', (item.child || 'A photo') + ', ' + when + (item.kind === 'video' ? ', video' : ''));
    a2.onclick = (e) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      openViewer(index);
    };
    if (item.kind === 'video') {
      a2.append(h('span', { class: 'vid', 'aria-hidden': 'true' }, '▶'), h('span', { class: 'cap' }, when));
    } else {
      const img = document.createElement('img');
      img.src = photoHref(item);
      img.alt = '';
      img.loading = 'lazy';
      a2.appendChild(img);
      const cap = document.createElement('span');
      cap.className = 'cap';
      cap.textContent = when;
      a2.appendChild(cap);
    }
    g.appendChild(a2);
  });

  $('gallery-pager').hidden = gallery.pages <= 1;
  $('gallery-prev').disabled = page === 0;
  $('gallery-next').disabled = page >= gallery.pages - 1;
  const first = page * gallery.size + 1;
  const last = Math.min(gallery.count, (page + 1) * gallery.size);
  $('gallery-status').textContent = first + '–' + last + ' of ' + gallery.count + ', newest first';
}

const turnGalleryPage = (delta) => {
  const next = Math.min(Math.max(gallery.page + delta, 0), gallery.pages - 1);
  if (next === gallery.page) return;
  gallery.page = next;
  paintGallery();
};
$('gallery-prev').onclick = () => turnGalleryPage(-1);
$('gallery-next').onclick = () => turnGalleryPage(1);

/* ------------------------------------------------------------------ the photo viewer

   A modal over the dashboard, so it is plainly still this page and not the browser's own
   image tab. The arrows at the edges, or the arrow keys, step through the whole run — past
   the end of one page into the next — and closing it leaves the grid on the page of the
   photo that was last on screen, with that photo's thumbnail focused. */
const viewer = { index: 0, showing: 0, pressedOutside: false };

async function openViewer(index) {
  await showInViewer(index);
  if (!$('viewer').open) openDialog('viewer');
}

async function showInViewer(index) {
  const run = ++viewer.showing;
  const item = await galleryItem(index);
  if (!item || run !== viewer.showing) return;
  viewer.index = index;
  const img = $('viewer-img');
  const video = $('viewer-video');
  video.pause();
  $('viewer-unplayable').hidden = true;
  if (item.kind === 'video') {
    img.hidden = true;
    img.removeAttribute('src');
    video.hidden = false;
    video.src = photoHref(item);
  } else {
    video.hidden = true;
    video.removeAttribute('src');
    img.hidden = false;
    img.src = photoHref(item);
    img.alt = (item.child ? item.child + ', ' : '') + 'posted ' + postedOn(item);
  }
  put($('viewer-cap'), item.child && [bold(item.child), ' · '],
    'posted ' + postedOn(item) + ' · ' + (index + 1) + ' of ' + gallery.count);

  // At either end the arrow goes, rather than sitting there doing nothing. If it had the
  // keyboard focus, the focus moves to the other arrow instead of falling out of the dialog.
  const prev = $('viewer-prev');
  const next = $('viewer-next');
  const hidePrev = index === 0;
  const hideNext = index >= gallery.count - 1;
  if ((hidePrev && document.activeElement === prev) || (hideNext && document.activeElement === next)) {
    (hidePrev ? (hideNext ? $('viewer-close') : next) : prev).focus();
  }
  prev.hidden = hidePrev;
  next.hidden = hideNext;

  // The neighbours, fetched now so stepping to them is instant. Photos only: a video is
  // not worth downloading on the chance that somebody steps onto it.
  for (const n of [index + 1, index - 1]) {
    galleryItem(n).then((it) => { if (it && it.kind === 'image') new Image().src = photoHref(it); });
  }
}

// A format the browser has no decoder for — an older phone's .mov, say — would otherwise be a
// black box with dead controls and no word about why.
$('viewer-video').addEventListener('error', () => {
  if ($('viewer-video').getAttribute('src')) $('viewer-unplayable').hidden = false;
});

const stepViewer = (delta) => {
  const target = viewer.index + delta;
  if (target >= 0 && target < gallery.count) showInViewer(target);
};

$('viewer-prev').onclick = () => stepViewer(-1);
$('viewer-next').onclick = () => stepViewer(1);
$('viewer-close').onclick = () => closeDialog('viewer');
$('viewer').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  // Before the video's own handling, which would otherwise seek it five seconds instead.
  e.preventDefault();
  stepViewer(e.key === 'ArrowLeft' ? -1 : 1);
});
// The dark area is everything that is not the photo, its caption or a button. Where the
// press started counts as well as where it ended, so dragging out of the photo to select
// nothing in particular does not close it.
const outsideThePhoto = (target) => !target.closest('.viewer-media, .viewer-cap, .viewer-btn');
$('viewer').addEventListener('pointerdown', (e) => { viewer.pressedOutside = outsideThePhoto(e.target); });
$('viewer').addEventListener('click', (e) => {
  if (viewer.pressedOutside && outsideThePhoto(e.target)) closeDialog('viewer');
  viewer.pressedOutside = false;
});
// However it closed — Escape, the button, or the scrim — the video stops, and the grid
// shows the page the last photo is on.
$('viewer').addEventListener('close', async () => {
  const video = $('viewer-video');
  video.pause();
  video.removeAttribute('src');
  video.load();
  const page = Math.floor(viewer.index / gallery.size);
  if (page !== gallery.page) {
    gallery.page = page;
    await paintGallery();
  }
  const thumb = document.querySelector('#gallery a[data-index="' + viewer.index + '"]');
  if (thumb) thumb.focus();
});

/* ------------------------------------------------------------------ keeping in touch

   Everything on this page comes from the tool, over /api/state, and the tool is a program on
   this computer that can be closed, restarted or busy. When it does not answer, the page says
   so in words and asks again — after one second, then two, four and so on, never more than
   half a minute apart — rather than freezing on whatever it last showed. A single refused
   /api/state used to leave a run's page saying "running" for good (security review page-1). */

const RETRY_FIRST_MS = 1000;
const RETRY_LONGEST_MS = 30000;
const nextWait = (ms) => Math.min(ms ? ms * 2 : RETRY_FIRST_MS, RETRY_LONGEST_MS);
const inSeconds = (ms) => (Math.round(ms / 1000) === 1 ? 'a second' : Math.round(ms / 1000) + ' seconds');
const KEEPS_ASKING = ' This page keeps asking, and carries on by itself once the tool answers.';

/**
 * /api/state, or why it could not be had, in words. Never throws. Its retry is false only for
 * the one answer that asking again cannot change: a refused setup link, which is what a tool
 * that has been started again says to a page opened from the link it printed last time.
 */
async function readState() {
  let r;
  try {
    r = await api('/api/state');
  } catch {
    return { ok: false, retry: true, error: 'This page cannot reach the tool. It may have been closed, or the computer may be busy.' };
  }
  if (r.status === 403) {
    return {
      ok: false,
      retry: false,
      error: 'The tool no longer accepts this page’s link, which usually means it was started again. Open the new link it printed in the window you started it from.',
    };
  }
  const d = await r.json().catch(() => null);
  if (r.ok && d && d.config) return { ok: true, state: d };
  return { ok: false, retry: true, error: (d && d.error) || 'The tool did not say how things stand (it answered ' + r.status + ').' };
}

/**
 * The notice across the top of the page, or none. Rewritten only when its words change, so
 * that asking again and again is not announced again and again.
 */
function stateNotice(text) {
  let box = $('state-error');
  if (!text) {
    if (box) box.remove();
    return;
  }
  if (!box) {
    $('main').insertAdjacentHTML('afterbegin', '<div id="state-error" role="alert"></div>');
    box = $('state-error');
  }
  if (box.dataset.text === text) return;
  box.dataset.text = text;
  say(box, 'err', text);
}

let refreshWait = 0;

async function refresh() {
  const got = await readState();
  const answer = got.ok ? got.state : { error: got.error };
  // The one failure that stops the whole page: no settings to paint from — settings the tool
  // refuses to guess at (see ConfigUnusableError), or no answer at all. Said at the top of the
  // page, in the server's words, instead of a page that half-paints and then does nothing; and
  // asked again, so that settings put right by hand, or a tool that was only busy, bring the
  // page back without a reload.
  if (!answer.config) {
    const text = answer.error || 'The tool could not read its own settings.';
    stateNotice(got.retry ? text + KEEPS_ASKING : text);
    if (got.retry) {
      refreshWait = nextWait(refreshWait);
      setTimeout(refresh, refreshWait);
    }
    return;
  }
  refreshWait = 0;
  stateNotice(null);
  state = answer;
  const c = state.config;
  for (const k of ['tagChildName','tagNote','stripLocation','incremental','writeSidecar']) $(k).checked = c[k];
  $('organiseBy').value = c.organiseBy;
  $('archiveDir').value = c.archiveDir;
  savedDir = c.archiveDir;
  $('p-dir').textContent = c.archiveDir;

  if (state.hasSession) {
    sessionOk = true;
    // Asked before anything says "Connected": this is where a session Brightwheel has stopped
    // accepting is found out, and loadChildren sends the page back to step 1 when it is.
    await loadChildren();
  }
  if (state.hasSession && !state.sessionRejected) {
    setStep($('card-connect'), $('num-1'), $('connect-state'), 'complete',
      'Step 1 of 4, complete. Connected' + (state.email ? ' as ' + state.email : '') + '.');
    say($('connect-msg'), 'ok', 'Connected', state.email && [' as ', bold(state.email)], '.');
    setStep($('card-run'), $('num-3'), $('run-state'), 'active', 'Step 3 of 4. Ready to start.');
  } else if (state.sessionProblem) {
    say($('connect-msg'), 'err', state.sessionProblem);
  }
  updateRunReady();
  await loadSchedule();
  placeSetupFlow(!needsSetup(state));
  paintDashboard(state);
  paintFacts();
  paintPhotos(state.photos);
  paintUpdate();
  paint(state.progress, state.running, state.lastResult);
  // The update section, once the tool has answered at all: asked here rather than after the
  // first refresh returns, because a first refresh that found the tool unreachable returns
  // early, and the retry that later succeeds would otherwise never ask.
  if (!updateAsked) loadUpdate();
  // A run started before this page was opened (or before a reload) is still going in the
  // terminal. Without restarting the poll here the bar sits motionless, and HIG's
  // progress-indicators guidance is explicit that people read a stationary indicator as a
  // stalled process — so the page would imply a hang that is not happening.
  if (state.running) poll();
}

/**
 * Back to step 1, because Brightwheel has stopped accepting the saved session. It is found
 * out here, when the page asks who is on the account, and the page used to carry on saying
 * "Connected" beside "Connect first to see your children": both untrue, and neither saying
 * what to do (security review page-2). Now step 1 is the step to do, with the reason under
 * it, and the dashboard gives way to the steps (needsSetup).
 */
function sessionRefused(sentence) {
  sessionOk = false;
  if (state) state.sessionRejected = true;
  kids = [];
  put($('kids'), h('li', { class: 'kids-empty' }, 'Connect again to see your children here.'));
  describeSelection();
  setStep($('card-connect'), $('num-1'), $('connect-state'), 'active',
    'Step 1 of 4. Brightwheel no longer accepts the saved session, so connect again.');
  setStep($('card-children'), $('num-2'), $('children-state'), '', 'Step 2 of 4. Waiting for step 1.');
  setStep($('card-run'), $('num-3'), $('run-state'), '', 'Step 3 of 4. Waiting for step 1.');
  say($('connect-msg'), 'err', sentence);
  updateRunReady();
  if (state) {
    placeSetupFlow(!needsSetup(state));
    paintFacts();
  }
}

async function loadChildren() {
  let d = null;
  try {
    d = await (await api('/api/children')).json();
  } catch {
    d = null;
  }
  if (d && d.sessionRejected) {
    sessionRefused(d.error || 'Brightwheel no longer accepts the saved session. Sign in on Brightwheel’s website again, copy the value fresh, and paste it in the box above.');
    return;
  }
  if (!d || !d.ok) {
    // Anything else — Brightwheel out of reach, the tool gone — is said beside the names. The
    // session is left alone, because nothing says it is at fault.
    const st = $('kids-status');
    st.classList.add('err');
    st.textContent = (d && d.error) ||
      'Could not ask Brightwheel who is on this account. Check the tool is still running in the window you started it from, then reload this page.';
    return;
  }
  kids = d.children;
  const included = new Set(d.included);
  // The element id is positional. The Brightwheel id travels in the dataset and the name is a
  // text node beside the box, so neither is ever read as markup.
  put($('kids'), kids.map((k, i) => {
    const box = h('input', { type: 'checkbox', id: 'kid-' + i });
    box.dataset.id = k.id;
    box.checked = included.has(k.id);
    box.addEventListener('change', onChildToggled);
    return h('li', null, h('label', { class: 'kid', for: 'kid-' + i }, box, k.fullName));
  }));
  describeSelection();
  setStep($('card-children'), $('num-2'), $('children-state'), 'complete',
    'Step 2 of 4. Found ' + kids.length + ' child' + (kids.length === 1 ? '' : 'ren') + '. Tick the ones to save photos for.');
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

${PASTE_CLIENT_SOURCE}

// What the person pasted, judged as they paste it. Cleaned where that is safe (a value
// wrapped over lines, a copied row, quotes), refused where it is certainly something else,
// and the box rewritten to the cleaned value so what they see is what will be sent.
let cookieVerdict = null;
function checkCookieField(rewrite) {
  const field = $('cookie');
  const out = $('cookie-check');
  const btn = $('btn-connect');
  if (!field.value.trim()) { cookieVerdict = null; out.textContent = ''; field.removeAttribute('aria-invalid'); btn.disabled = false; return; }
  const v = inspectCookiePaste(field.value);
  cookieVerdict = v;
  if (v.ok && rewrite && v.value !== field.value) field.value = v.value;
  const notes = v.notes.length ? ' (' + v.notes.join('; ') + ')' : '';
  put(out, h('span', { class: v.level === 'err' ? 'bad' : v.level === 'warn' ? 'warn' : 'good' }, v.message), notes);
  field.setAttribute('aria-invalid', v.ok ? 'false' : 'true');
  btn.disabled = !v.ok;
}
/* ------------------------------------------------------- the two ways out of this view */

const openDialog = (id) => $(id).showModal();
const closeDialog = (id) => $(id).close();

$('btn-settings').onclick = () => openSettings();
$('btn-settings-close').onclick = () => closeDialog('dlg-settings');
$('btn-help').onclick = () => openDialog('dlg-help');
$('btn-help-close').onclick = () => closeDialog('dlg-help');
$('btn-logs-close').onclick = () => closeDialog('dlg-logs');

/* ------------------------------------------------------------ adding to Apple Photos

   Only in Settings, and only on a Mac. Turning it on is not stored like the other tick
   boxes: the server first asks the Mac for permission, which can put a macOS question on
   screen and wait for the answer, so the box stays disabled and says what it is waiting for
   rather than looking as if nothing happened. */

/** The last Photos status painted, so the buttons act on what the parent is looking at. */
let photosNow = null;

function paintPhotos(p) {
  photosNow = p || null;
  const card = $('card-photos');
  card.hidden = !p || !p.supported;
  // Integrations says it has nothing to offer only where that is true.
  $('integrations-none').hidden = !card.hidden;
  // One line on the dashboard: that it is on, or — the case that matters — that it has
  // stopped working, since nothing else on the main page would ever say so.
  const dash = $('dash-photos');
  const failing = Boolean(p && p.enabled && ((p.lastAttempt && !p.lastAttempt.ok) || p.problem));
  dash.hidden = !(p && p.enabled);
  dash.textContent = failing
    ? 'The last photos could not be added to Photos. Open Settings and Maintenance to see why.'
    : 'Each run also adds its new photos to Photos, in the Brightwheel folder.';
  dash.classList.toggle('warn-text', failing);
  if (card.hidden) return;
  const box = $('addToPhotos');
  box.checked = p.enabled;

  let status = '';
  if (p.enabled && !p.problem) {
    status = p.pending > 0
      ? p.pending + ' waiting to be added on the next run.'
      : 'Up to date: everything saved since you turned this on is in Photos.';
    const last = p.lastAttempt;
    if (last && last.ok && last.added > 0) status += ' Last added ' + last.added + ' on ' + day(last.at) + '.';
  }
  $('photos-status').textContent = status;
  // What a cloud-synced photos folder means for this step, beside the switch, before it is
  // turned on as well as after: the tool's words, as text.
  $('photos-cloud').hidden = !p.warning;
  $('photos-cloud').textContent = p.warning || '';
  const last = p.lastAttempt;
  if (p.enabled && p.problem) {
    say($('photos-msg'), 'warn', bold('Nothing can be added to Photos until this is sorted out.'), ' ', p.problem);
  } else if (p.enabled && last && !last.ok) {
    say($('photos-msg'), 'warn', bold('The last photos could not be added.'), ' ', last.error);
  }

  const row = $('photos-earlier-row');
  row.hidden = !(p.enabled && p.earlier > 0);
  $('btn-photos-earlier').textContent = 'Add the ' + p.earlier + ' saved before you turned this on';
}

$('addToPhotos').onchange = async (e) => {
  const box = e.target;
  const on = box.checked;
  box.disabled = true;
  show($('photos-msg'), 'ok', on
    ? 'Checking that this Mac allows it&hellip; If a box appears asking to let this control Photos, choose <b>OK</b>.'
    : 'Turning it off&hellip;');
  try {
    const r = await api('/api/photos', { method: 'POST', body: JSON.stringify({ enabled: on }) });
    const d = await r.json();
    if (!d.ok) {
      box.checked = !on;
      say($('photos-msg'), 'err', d.error || 'That did not work.');
      return;
    }
    show($('photos-msg'), 'ok', on
      ? 'On. From now on, each run adds its new photos to Photos, in the <b>Brightwheel</b> folder.'
      : 'Off. Nothing more will be added to Photos. What is already there stays.');
    paintPhotos(d.photos);
  } catch {
    box.checked = !on;
    show($('photos-msg'), 'err', 'Could not reach the tool. Check it is still running in the window you started it from.');
  } finally {
    box.disabled = false;
  }
};

$('btn-photos-earlier').onclick = async () => {
  const btn = $('btn-photos-earlier');
  const n = (photosNow && photosNow.earlier) || 0;
  // A real question, because the answer cannot be taken back from here: once they are in
  // Photos (and iCloud), removing them is done in Photos, one selection at a time.
  if (!window.confirm('Add ' + n + ' earlier photos and videos to Photos?\n\nIf you use iCloud Photos they will be uploaded too. If you already put some of them into Photos yourself, those will appear twice.')) return;
  btn.disabled = true;
  try {
    const r = await api('/api/photos', { method: 'POST', body: JSON.stringify({ earlier: true }) });
    const d = await r.json();
    if (!d.ok) { say($('photos-msg'), 'err', d.error || 'That did not work.'); return; }
    paintPhotos(d.photos);
    // They go in with a run: a quick look for anything new, then Photos. When a run
    // cannot start here, the next one — daily or by hand — picks them up.
    if (!$('btn-run').disabled) {
      show($('photos-msg'), 'ok', 'Adding them now, after a quick look for anything new. This can take a few minutes.');
      $('btn-run').click();
    } else {
      show($('photos-msg'), 'ok', 'They will be added on the next run.');
    }
  } catch {
    show($('photos-msg'), 'err', 'Could not reach the tool. Check it is still running in the window you started it from.');
  } finally {
    btn.disabled = false;
  }
};

$('btn-photos-faq').onclick = () => {
  closeDialog('dlg-settings');
  openDialog('dlg-help');
  $('faq-photos').focus();
};

/**
 * The daily run's log, read into the page.
 *
 * Shown here as well as handed to the platform's own viewer, because "open Console" is not
 * an answer on a machine where the schedule is a systemd timer and the log is the journal —
 * there the button reports the journalctl line instead of pretending to open something.
 */
async function showLogs() {
  openDialog('dlg-logs');
  $('logs-text').textContent = 'Reading\u2026';
  try {
    const d = await (await api('/api/logs')).json();
    $('logs-where').textContent = 'Written to ' + d.path;
    $('logs-text').textContent = d.text || 'Nothing has been written to it yet. A scheduled run adds a line each time it happens.';
  } catch {
    $('logs-text').textContent = 'The log could not be read.';
  }
}
$('btn-dash-logs').onclick = showLogs;
$('btn-logs-open').onclick = async () => {
  try {
    const d = await (await api('/api/open-logs', { method: 'POST', body: '{}' })).json();
    say($('logs-msg'), d.opened ? 'ok' : 'warn', d.opened ? 'Opened.' : d.hint || 'There is no log viewer on this computer.');
  } catch {
    show($('logs-msg'), 'err', 'Could not reach the tool.');
  }
};

/* The dashboard's own buttons reuse the controls that already exist, so there is one
   implementation of "run" and one of "open the folder" rather than two that drift. */
// The run's progress, its counts and its Stop button are in the Schedule section, so a run
// started here opens there: a run with nothing visibly moving reads as one that has hung.
$('btn-dash-run').onclick = () => { openSettings('schedule'); $('btn-run').click(); };
$('btn-dash-folder').onclick = () => $('btn-open-dir').click();

$('cookie').addEventListener('input', () => checkCookieField(false));
$('cookie').addEventListener('paste', () => setTimeout(() => checkCookieField(true), 0));
$('cookie').addEventListener('blur', () => checkCookieField(true));

$('btn-connect').onclick = async () => {
  const btn = $('btn-connect');
  const field = $('cookie');
  checkCookieField(true);
  if (cookieVerdict && !cookieVerdict.ok) { field.focus(); return; }
  btn.disabled = true; btn.textContent = 'Checking…';
  field.setAttribute('aria-invalid', 'false');
  show($('connect-msg'), 'warn', 'Checking with Brightwheel…');
  try {
    const r = await api('/api/session', { method: 'POST', body: JSON.stringify({ cookie: cookieVerdict ? cookieVerdict.value : field.value }) });
    const d = await r.json();
    if (d.ok) {
      field.value = '';
      $('cookie-check').textContent = '';
      await refresh();
      // Move focus forward so a keyboard or screen-reader user is taken to what is next —
      // but only to something on screen. In Settings, Start saving is in another section,
      // and focusing it would drop focus on the page behind the dialog.
      const next = $('btn-run');
      if (next.offsetParent !== null) next.focus();
      else {
        $('connect-msg').tabIndex = -1;
        $('connect-msg').focus();
      }
    } else {
      field.setAttribute('aria-invalid', 'true');
      say($('connect-msg'), 'err', d.error || 'That did not work.');
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
$('archiveDir').addEventListener('change', () => { $('archiveDir').value = cleanPastedPath($('archiveDir').value); persist({ archiveDir: $('archiveDir').value }); });
$('btn-dir').onclick = () => { $('archiveDir').value = cleanPastedPath($('archiveDir').value); persist({ archiveDir: $('archiveDir').value }, { focus: true }); };

/** The small line under the folder buttons. Its own space, never the settings message box,
    which belongs to saving and must not be overwritten by "a chooser is open". */
function setDirNote(text, isError) {
  const el = $('dir-note');
  el.classList.toggle('err', Boolean(isError));
  el.textContent = text;
}

/**
 * Pick the folder instead of typing it.
 *
 * A browser will not give a page a real path — <input webkitdirectory> reports only a
 * folder's name and showDirectoryPicker() hands back a handle with no path in it, both on
 * purpose. So the tool, which is running on this very computer, opens the operating
 * system's own chooser and reports back what was picked. What comes back is then checked
 * exactly as a typed path is: same refusals, same cloud-folder warning.
 */
$('btn-choose-dir').onclick = async () => {
  const btn = $('btn-choose-dir');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Choosing\u2026';
  // The dialog belongs to the operating system, not to this page, so it can open behind the
  // browser window — and a parent staring at a frozen button would have no way to know.
  setDirNote('A folder chooser has opened. It may be behind this window.', false);
  let d;
  try {
    const r = await api('/api/choose-folder', { method: 'POST', body: '{}' });
    d = await r.json();
  } catch {
    d = { ok: false, error: 'Could not reach the tool. Check it is still running in the window you started it from.' };
  }
  btn.disabled = false;
  btn.textContent = label;
  if (d.ok && d.cancelled) {
    setDirNote('No folder was chosen, so nothing changed.', false);
    return;
  }
  if (!d.ok) {
    // A refused folder is marked and explained where a typed refusal is, so that there is
    // one place to look whichever way the path arrived.
    if (d.field === 'archiveDir') {
      setDirNote('', false);
      showSaveError(d, { focus: true });
    } else {
      setDirNote(d.error, true);
    }
    return;
  }
  setDirNote('', false);
  // The picked path is now the stored one, so the field shows it and any earlier refusal
  // is no longer true of what is in the box.
  $('archiveDir').value = d.config.archiveDir;
  clearDirError();
  applySaved(d);
};

/**
 * Show the archive folder in the file manager.
 *
 * This page never sends a path: the tool opens the folder it has stored, and nothing else.
 */
async function openArchiveFolder(btn, note) {
  btn.disabled = true;
  let d;
  try {
    const r = await api('/api/open-folder', { method: 'POST', body: '{}' });
    d = await r.json();
  } catch {
    d = { ok: false, error: 'Could not reach the tool. Check it is still running in the window you started it from.' };
  }
  btn.disabled = false;
  note.classList.toggle('err', !d.ok);
  note.textContent = d.ok ? 'Opened in your file manager. If you cannot see it, look behind this window.' : d.error;
}

/**
 * The same offer at the end of a run. The folder is named as well as opened, because a
 * parent who wants to find it again tomorrow needs to have read where it is, and because
 * the button is useless on a computer with no file manager this tool can reach.
 */
function offerOpenFolder() {
  // The markup is this file's own; the folder goes in as text.
  $('run-result').insertAdjacentHTML('beforeend',
    '<div class="dir-actions" style="align-items:center">' +
    '<button class="secondary" id="btn-open-done" type="button">Open this folder</button>' +
    '<span class="path" id="open-done-path"></span></div>' +
    '<p class="dir-note" id="open-done-note" role="status" aria-live="polite"></p>');
  $('open-done-path').textContent = (state && state.archiveDirShown) || savedDir;
}

$('btn-open-dir').onclick = () => openArchiveFolder($('btn-open-dir'), $('dir-note'));
// Delegated, because the summary the second button sits in is rebuilt each time it is shown.
$('run-result').addEventListener('click', (e) => {
  if (e.target.id === 'btn-open-done') openArchiveFolder(e.target, $('open-done-note'));
});

$('btn-run').onclick = async () => {
  $('btn-run').disabled = true;
  $('run-result').innerHTML = '';
  // What is on screen is what runs. The whole form is sent again here, so a change that
  // was refused earlier, or is still on its way, cannot be left behind by a run that
  // reads its settings from disk.
  if (!(await persist(formState(), { focus: true }))) {
    show($('run-result'), 'err', $('setup-flow').hidden
      ? 'Not started. Fix the setting that is marked, then press Start saving again.'
      : 'Not started. Fix the setting marked in step 2, then press Start saving again.');
    updateRunReady();
    return;
  }
  const r = await api('/api/sync', { method: 'POST', body: '{}' });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    say($('run-result'), 'err', d.error || 'Could not start.');
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
      say($('run-result'), 'err', d.error || 'Could not stop it.');
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
  $('card-run').toggleAttribute('data-running', Boolean(running));
  $('s-saved').textContent = p.saved;
  $('s-skipped').textContent = p.skipped;
  $('s-failed').textContent = p.failed;
  $('run-msg').textContent = p.message;

  const bar = $('bar');
  const fill = $('bar-fill');
  const stopped = p.phase === 'stopped';
  bar.dataset.stopped = stopped ? 'true' : 'false';
  if (running || stopped) {
    // We do not know how many photos there are until the feed has been walked. Showing a
    // percentage here would be an invention, so show motion without a number instead.
    bar.dataset.indeterminate = 'true';
    bar.removeAttribute('aria-valuenow');
    fill.style.width = '';
  } else {
    bar.dataset.indeterminate = 'false';
    const done = p.phase === 'done' ? 100 : 0;
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
    // Not while Brightwheel refuses the saved session: step 3 is waiting for step 1 again
    // (sessionRefused), however the last run ended.
    if (!(state && state.sessionRejected)) setStep($('card-run'), $('num-3'), $('run-state'), 'complete', 'Step 3 of 4, finished.');
    bar.dataset.indeterminate = 'false';
    fill.style.width = '100%';
    // "Nothing new" is the normal outcome of a daily run. It must read as success, not
    // as a zero that looks like failure.
    const ph = result && result.photos;
    // What happened in Photos, as a sentence to add. A run can save nothing new and still
    // add earlier ones to Photos, so this is said whichever way the run itself went.
    const photosLine = !ph ? []
      : ph.ok ? (ph.added > 0 ? [' Added ', bold(ph.added), ' to Photos, in the Brightwheel folder.'] : [])
      : ph.reason === 'busy' ? []
      : [h('br'), h('br'), bold('Not added to Photos:'), ' ', ph.error || 'no reason was given.'];
    const photosFailed = Boolean(ph && !ph.ok && ph.reason !== 'busy');
    if (result && result.saved === 0 && result.failed === 0) {
      say($('run-result'), photosFailed ? 'warn' : 'ok', 'You are up to date — there were no new photos to save.', photosLine);
    } else if (result) {
      say($('run-result'), result.failed > 0 || photosFailed ? 'warn' : 'ok',
        'Saved ', bold(result.saved), ' new item' + (result.saved === 1 ? '' : 's') + '.',
        result.failed > 0 && [' ', bold(result.failed), ' could not be fetched — press Start saving again to retry them.'],
        photosLine);
    }
    // "Where did my photos go" is the question at the end of a run, so answer it with a
    // button rather than a path to copy out.
    if (result) offerOpenFolder();
  }
  if (p.phase === 'stopped') {
    // Neither finished nor failed. Everything already saved is on disk and the next run
    // carries on from there, so this reads as an ordinary outcome, not as a warning.
    setStep($('card-run'), $('num-3'), $('run-state'), 'active', p.message);
    say($('run-result'), 'ok', p.message);
  }
  if (p.phase === 'error') {
    say($('run-result'), 'err', p.message, h('br'), h('br'), 'If your session has expired, paste a fresh value ',
      $('setup-flow').hidden
        ? ['under ', h('button', { class: 'linkish', type: 'button', 'data-section': 'account' }, 'Account'), '.']
        : 'in step 1 above.');
    $('card-run').dataset.state = 'active';
  }
}

/** Which poll is the current one: a newer start takes over from an older one rather than running beside it. */
let polling = 0;
/** How long the poll waited last time /api/state did not answer; 0 while it answers. */
let pollWait = 0;

async function poll() {
  const mine = ++polling;
  const got = await readState();
  if (mine !== polling) return;
  if (!got.ok) {
    // Nothing is known about the run until the tool answers, so the bar holds still rather
    // than implying progress, and the progress line says why and when it will ask again.
    // The card is marked as following a run, because in Settings the progress line is shown
    // only then, and a refusal on the first poll after Start came before any answer said so.
    // Indeterminate as well as still: left as it was, a bar that last showed a finished run
    // stayed full, which says "done" about a run nobody can see.
    $('card-run').toggleAttribute('data-running', true);
    $('bar').dataset.stopped = 'true';
    $('bar').dataset.indeterminate = 'true';
    $('bar').removeAttribute('aria-valuenow');
    $('bar-fill').style.width = '';
    if (!got.retry) {
      $('run-msg').textContent = got.error;
      stateNotice(got.error);
      return;
    }
    pollWait = nextWait(pollWait);
    $('run-msg').textContent = got.error + ' Asking again in ' + inSeconds(pollWait) + '.';
    stateNotice(got.error + KEEPS_ASKING);
    setTimeout(poll, pollWait);
    return;
  }
  pollWait = 0;
  stateNotice(null);
  const s = got.state;
  paint(s.progress, s.running, s.lastResult);
  if (s.running) setTimeout(poll, 700);
  else {
    paintPhotos(s.photos);
    // What the run just saved is now the last run: the stats and the photos catch up.
    paintDashboard(s);
  }
}

/* ------------------------------------------------------------------ step 4, and after it

   The page used to read "connect, choose, run once", which is the wrong shape for what this
   tool is. The run that matters is not this one, it is the one in three weeks' time — and a
   parent who has to remember to come back is a parent whose archive stops in March. Step 4
   hands the job to the scheduler the operating system already has, and says plainly what
   that does and does not do.

   Coming back is then a different task from setting up. Someone who opens the tool a month
   later wants to see that it is still working, so the page opens on the photos and the
   facts under them; everything they might change is a section of Settings, one at a time.
   (An earlier "This is already set up" card sat above the photos with shortcut buttons into
   a folded-away copy of the steps. Its lines are the dashboard's facts now, and its buttons
   are the sections themselves.) */

/** The last answer from /api/schedule. */
let sched = null;
/** What this computer would set up, before anything has been set up. */
let proposed = null;
/** The duplicate report the delete button is allowed to act on, and nothing else. */
let dupes = null;

/** A time of day on this computer's clock, in its own style: "7:00 PM", or "19:00". */
const clockTime = (hhmm) => {
  const [hours, minutes] = String(hhmm).split(':').map(Number);
  const d = new Date();
  d.setHours(hours, minutes, 0, 0);
  return isNaN(d.getTime()) ? String(hhmm) : d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
};
/** When the next run is, the way a person says it: "today at 7:00 PM", "Thursday at 7:00 PM". */
const nextWhen = (iso) => {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const day = d.toDateString() === new Date().toDateString() ? 'today'
    : d.toDateString() === tomorrow.toDateString() ? 'tomorrow'
    : d.toLocaleDateString(undefined, { weekday: 'long' });
  return day + ' at ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
};
const fullWhen = (iso) => {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};

async function loadSchedule() {
  let d;
  try {
    d = await (await api('/api/schedule')).json();
  } catch {
    // The tool has stopped. The run card already says so in its own words; a second
    // complaint about the daily run would only add noise.
    return;
  }
  if (!d || !d.ok) return;
  sched = d.schedule;
  proposed = d.proposed;
  paintSchedule();
  paintFacts();
}

function paintSchedule() {
  if (!sched) return;
  // The dashboard's one line about the daily run: when the next one is, or that there is
  // none — the "when" a parent looks for without opening Settings.
  const lost = sched.installed && sched.registered === false;
  // Set up and still registered, but it has not saved anything since — most often because
  // the Node it points at has moved. The summary says which; this only has to not be green.
  const stalled = sched.installed && !lost && Boolean(sched.overdue);
  $('dash-schedule').textContent = !sched.installed
    ? 'Photos are saved only when you press Save new photos. A daily run can be set up in Settings and Maintenance.'
    : lost
      ? 'A daily run was set up, but this computer no longer has it. Settings and Maintenance says how to put it back.'
      : stalled
        ? 'The daily run is set up but has not saved anything since. Settings and Maintenance says why.'
        : 'Saves new photos every day' + (sched.time ? ' at ' + clockTime(sched.time) : '') +
          (sched.nextRun ? ' — next run ' + nextWhen(sched.nextRun) : '') + '.';
  $('dash-schedule').classList.toggle('warn-text', lost || stalled);
  if (sched.time) $('schedule-time').value = sched.time;
  $('btn-schedule-off').hidden = !sched.installed;
  $('btn-schedule-on').textContent = sched.installed ? 'Change the time' : 'Save new photos every day';
  const box = $('schedule-msg');
  // Where the note would be, or is, written down. Said out loud in both states: something
  // that starts itself every evening should not be a thing a parent cannot find again.
  const where = sched.location || (proposed && proposed.location);
  const found = where
    ? [h('br'), h('span', { style: 'font-size:.875rem' },
        sched.installed ? 'Written down in ' : 'It would be written down in ', pathPill(where))]
    : null;
  if (!sched.installed) {
    // Not a warning. Choosing not to schedule it is a perfectly good answer, and a yellow
    // box would tell a parent they had got something wrong.
    put(box, h('p', { style: 'color:var(--text-muted);font-size:.9375rem;margin:var(--s4) 0 0' },
      'Not set up. Photos are saved only when you press Start saving.', found));
    setStep($('card-schedule'), $('num-4'), $('schedule-state'), 'active', 'Step 4 of 4. Optional, and not set up.');
    return;
  }
  if (sched.registered === false) {
    say(box, 'warn', sched.summary, found);
    setStep($('card-schedule'), $('num-4'), $('schedule-state'), 'active',
      'Step 4 of 4. A daily run was set up but the computer no longer has it.');
    return;
  }
  if (sched.overdue) {
    say(box, 'warn', sched.summary, found);
    setStep($('card-schedule'), $('num-4'), $('schedule-state'), 'active',
      'Step 4 of 4. A daily run is set up but has not saved anything yet.');
    return;
  }
  say(box, 'ok', sched.summary, sched.nextRun && [h('br'), 'Next run: ', bold(nextWhen(sched.nextRun)), '.'], found);
  setStep($('card-schedule'), $('num-4'), $('schedule-state'), 'complete', 'Step 4 of 4, done. ' + sched.summary);
}

/**
 * The archive's facts, on the dashboard under the photos: who it is connected as, when it
 * last ran on its own and how that went, and where the photos are. The daily-run line is
 * paintSchedule's, because it has its own warnings.
 */
function paintFacts() {
  if (!state) return;
  put($('dash-connected'), state.sessionRejected
    ? 'Brightwheel no longer accepts the saved session, so nothing new can be saved until you connect again.'
    : state.hasSession
      ? ['Connected to Brightwheel', state.email && [' as ', bold(state.email)],
        state.sessionSavedAt && ', since ' + fullWhen(state.sessionSavedAt), '.']
      : 'Not connected to Brightwheel.');
  const last = sched && sched.lastRun;
  // Whether it worked is said in words, not only in the presence of a number. Nothing at all
  // when there is nothing to say, so that the empty line is hidden (.dash-facts li:empty).
  put($('dash-last'), last
    ? [last.trigger === 'manual' ? 'Last run, which you started: ' : 'Last run on its own: ',
      bold(fullWhen(last.at)), ' — ' + (last.ok ? 'it worked' : 'it did not work') + '. ', last.message]
    : sched && sched.installed && 'The daily run has not run on its own yet.');
  // No full stop after the path: the pill carries its own padding, so one would sit on its
  // own with a visible gap in front of it.
  put($('dash-folder'), 'Photos are in ', pathPill(state.archiveDirShown || state.config.archiveDir));
}

/** Ask the tool to change the daily run. Returns the refusal, or null when it worked. */
async function postSchedule(path, body) {
  try {
    let d = await (await api(path, { method: 'POST', body: JSON.stringify(body || {}) })).json();
    // Another copy of the tool set up the daily run. Moving it to this copy is the parent's
    // decision, so it is asked, in words, before anything changes (ScheduleOwnedElsewhereError).
    if (!d.ok && d.replaceable && window.confirm(d.error + '\n\nMove the daily run to this copy?')) {
      const again = Object.assign({}, body || {}, { replace: true });
      d = await (await api(path, { method: 'POST', body: JSON.stringify(again) })).json();
    }
    // A refusal still says what is set up now: a change the scheduler refused can leave the
    // old run in place, or none at all, and the page must not go on showing the old one.
    if (d.schedule) sched = d.schedule;
    if (!d.ok) return d.error || 'That could not be changed.';
    return null;
  } catch {
    return 'Could not reach the tool. Check it is still running in the window you started it from.';
  }
}

$('btn-schedule-on').onclick = async () => {
  const btn = $('btn-schedule-on');
  btn.disabled = true;
  btn.textContent = 'Setting it up…';
  const error = await postSchedule('/api/schedule', { time: $('schedule-time').value });
  btn.disabled = false;
  // paintSchedule owns the button's label and the box, so it runs either way; the refusal
  // then goes into the box it just rewrote.
  paintSchedule();
  paintFacts();
  if (error) say($('schedule-msg'), 'err', error);
  else if (!$('setup-flow').hidden) {
    $('schedule-msg').insertAdjacentHTML('beforeend',
      '<p style="color:var(--text-muted);font-size:.875rem;margin:var(--s3) 0 0">' +
      'Next time you open this tool it opens on your photos, and all of this is under Settings and Maintenance.</p>');
  }
};

$('btn-schedule-off').onclick = async () => {
  const btn = $('btn-schedule-off');
  btn.disabled = true;
  const error = await postSchedule('/api/schedule/off');
  btn.disabled = false;
  paintSchedule();
  paintFacts();
  if (error) say($('schedule-msg'), 'err', error);
};

// ---------------------------------------------------------------- looking after the archive

async function maintenance(action, body) {
  const r = await api('/api/maintenance/' + action, { method: 'POST', body: JSON.stringify(body || {}) });
  return await r.json();
}

/** Buttons that do real work say so while they do it, and give their own label back after. */
function busy(btn, label) {
  btn.dataset.label = btn.textContent;
  btn.textContent = label;
  btn.disabled = true;
}
function idle(btn) {
  if (btn.dataset.label) btn.textContent = btn.dataset.label;
  btn.disabled = false;
}

$('m-children').onclick = async () => {
  const btn = $('m-children');
  const out = $('m-children-out');
  busy(btn, 'Asking Brightwheel…');
  try {
    const d = await maintenance('children');
    if (!d.ok) {
      say(out, 'err', d.error || 'That could not be checked.');
    } else {
      const r = d.result;
      say(out, r.added.length > 0 || r.removed.length > 0 ? 'warn' : 'ok', r.summary,
        r.notIncluded.length > 0 && h('div', { style: 'margin-top:var(--s3)' },
          h('button', { class: 'secondary', id: 'm-include', type: 'button' }, 'Save photos for everyone on the account')));
      const include = $('m-include');
      if (include) {
        include.onclick = async () => {
          include.disabled = true;
          const saved = await persist({ includeStudents: r.onAccount.map((c) => c.id) });
          if (!saved) { include.disabled = false; return; }
          await loadChildren();
          show(out, 'ok', 'Everyone on the account is included now. Their photos arrive on the next run.');
        };
      }
    }
  } catch {
    show(out, 'err', 'Could not reach the tool. Check it is still running in the window you started it from.');
  }
  idle(btn);
};

$('m-check').onclick = async () => {
  const btn = $('m-check');
  const out = $('m-check-out');
  busy(btn, 'Checking…');
  try {
    const d = await maintenance('archive');
    if (!d.ok) {
      say(out, 'err', d.error || 'The folder could not be checked.');
    } else {
      const r = d.result;
      const examples = r.unrecorded.slice(0, 6).concat(r.missing.slice(0, 6));
      say(out, r.repairable ? 'warn' : 'ok', r.summary,
        examples.length > 0 && h('ul', { style: 'margin:var(--s3) 0 0;padding-left:1.1rem' },
          examples.map((f) => h('li', null, pathPill(f)))),
        r.repairable && h('div', { style: 'margin-top:var(--s3)' },
          h('button', { class: 'secondary', id: 'm-repair', type: 'button' }, 'Fix the list'),
          h('p', { style: 'font-size:.875rem;margin:var(--s2) 0 0' },
            'This changes only the tool’s own list of what it has saved. No photo is moved, changed or deleted.')));
      const repair = $('m-repair');
      if (repair) {
        repair.onclick = async () => {
          busy(repair, 'Fixing…');
          const fixed = await maintenance('repair');
          say(out, fixed.ok ? 'ok' : 'err', fixed.ok ? fixed.result.summary : fixed.error);
        };
      }
    }
  } catch {
    show(out, 'err', 'Could not reach the tool. Check it is still running in the window you started it from.');
  }
  idle(btn);
};

$('m-dupes').onclick = async () => {
  const btn = $('m-dupes');
  const out = $('m-dupes-out');
  busy(btn, 'Looking…');
  try {
    const d = await maintenance('duplicates');
    if (!d.ok) say(out, 'err', d.error || 'That could not be checked.');
    else { dupes = d.result; renderDupes(); }
  } catch {
    show(out, 'err', 'Could not reach the tool. Check it is still running in the window you started it from.');
  }
  idle(btn);
};

/**
 * Every file that would go, named, before anything is offered. A count on its own is not
 * enough to agree to: these are photographs of a child, and the parent has to be able to
 * see which copy stays and which one does not.
 */
function renderDupes() {
  const out = $('m-dupes-out');
  const some = dupes.files > 0;
  say(out, some ? 'warn' : 'ok', dupes.summary,
    some && h('ul', { style: 'margin:var(--s3) 0 0;padding-left:1.1rem' }, dupes.groups.map((g) =>
      h('li', { style: 'margin-bottom:var(--s3)' }, 'keeping ', pathPill(g.keep),
        g.extra.map((extra) => [h('br'), 'would delete ', pathPill(extra)])))),
    some && h('div', { id: 'm-dupes-actions', style: 'margin-top:var(--s3)' }));
  if (!some) return;
  put($('m-dupes-actions'), h('button', { class: 'secondary', id: 'm-dupes-go', type: 'button' },
    dupes.files === 1 ? 'Delete the extra copy' : 'Delete the ' + dupes.files + ' extra copies'));
  $('m-dupes-go').onclick = confirmDupes;
}

/** The second press. The list above stays on screen while it is asked. */
function confirmDupes() {
  const one = dupes.files === 1;
  put($('m-dupes-actions'),
    h('p', { style: 'margin:0 0 var(--s3)' },
      bold('This deletes ' + dupes.files + ' file' + (one ? '' : 's')),
      ' — exactly the ' + (one ? 'one' : 'ones') + ' marked “would delete” above, and nothing else. ' +
      (one ? 'The photo it is a copy of stays where it is.' : 'The photos they are copies of stay where they are.') +
      ' This cannot be undone.'),
    h('div', { class: 'run-actions' },
      h('button', { id: 'm-dupes-yes', type: 'button' }, 'Yes, delete them'),
      h('button', { class: 'secondary', id: 'm-dupes-no', type: 'button' }, 'Keep them')));
  $('m-dupes-no').onclick = renderDupes;
  $('m-dupes-yes').onclick = async () => {
    const yes = $('m-dupes-yes');
    busy(yes, 'Deleting…');
    // The exact paths that were shown. The tool checks them again on its side and deletes
    // nothing at all if any one of them is no longer a second copy of a photo that is there.
    const paths = dupes.groups.reduce((all, g) => all.concat(g.extra), []);
    const done = await maintenance('duplicates/remove', { paths });
    dupes = null;
    say($('m-dupes-out'), done.ok ? 'ok' : 'err', done.ok ? done.result.summary : done.error);
  };
}

/* ------------------------------------------------------------------ updates

   Whether a newer version exists is the server's to find out (src/updates.ts): it asks
   GitHub, once a day, only after the parent has said yes. This shows the answer — a pill in
   the header when there is something newer, and the steps for the way this copy was
   installed — and asks the question once, under the archive. */
let update = null;
/** Whether /api/update has answered once, either way: see the end of refresh. */
let updateAsked = false;

async function loadUpdate(body) {
  let r;
  try {
    r = await api('/api/update', body ? { method: 'POST', body: JSON.stringify(body) } : {});
  } catch {
    return;
  }
  updateAsked = true;
  const d = await r.json();
  if (!r.ok) {
    $('updates-status').textContent = d.error || 'That did not work.';
    return;
  }
  update = d;
  paintUpdate();
}

const whenChecked = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function paintUpdate() {
  const u = update;
  if (!u) return;
  const version = u.current.version + (u.current.commit ? ' (' + u.current.commit + ')' : '');
  $('version-line').textContent = 'This is version ' + version + '.';
  $('checkForUpdates').checked = u.enabled;
  // Asked on the dashboard only: during first-time setup there is enough to decide.
  $('ask-updates').hidden = u.asked || $('dash').hidden;
  $('btn-update').hidden = !u.available;
  $('btn-update-how').hidden = !u.available;
  $('btn-update-check').disabled = !u.enabled;
  $('updates-status').textContent =
    !u.enabled ? 'Not checking, so nothing is sent to GitHub.'
    : u.available ? 'Version ' + u.latest.version + ' is available. You have ' + u.current.version + '.'
    : u.error ? u.error + (u.checkedAt ? ' The last answer, ' + whenChecked(u.checkedAt) + ', was that this is the newest version.' : '')
    : u.checkedAt ? 'Checked ' + whenChecked(u.checkedAt) + ': this is the newest version.'
    : 'Not checked yet.';
  if (!u.available) return;

  $('update-pill-text').textContent = 'New version ' + u.latest.version;
  $('h-update').textContent = 'Version ' + u.latest.version + ' is available';
  $('update-versions').textContent = 'You have ' + version + '.' +
    (u.latest.publishedAt ? ' ' + u.latest.version + ' was released on ' + new Date(u.latest.publishedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) + '.' : '');
  paintNotes($('update-notes'), u.latest.notes);
  $('update-release-link').href = u.latest.url;
  $('update-installed').textContent = 'This copy was installed as ' + u.how.installedAs + '.';
  $('update-before').textContent = u.how.before;
  $('update-commands').textContent = u.how.commands.join('\n');
  $('update-commands').hidden = u.how.commands.length === 0;
  $('update-copy-row').hidden = u.how.commands.length === 0;
  $('update-after').textContent = u.how.after;
}

/**
 * Release notes, as text. They are somebody else's writing fetched from the internet, so
 * nothing in them is ever parsed as HTML: each line becomes a text node, a Markdown heading
 * a bold line and a list item a bullet. Everything else about Markdown is left as typed.
 */
function paintNotes(el, notes) {
  el.textContent = '';
  const lines = notes.trim() ? notes.trim().split('\n') : ['The release has no notes.'];
  const isHeading = (l) => l !== undefined && /^#{1,6}\s/.test(l);
  lines.forEach((line, i) => {
    // A heading brings its own space; a blank line beside one would double it.
    if (!line.trim() && (isHeading(lines[i - 1]) || isHeading(lines[i + 1]))) return;
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const item = /^\s*[-*]\s+(.*)$/.exec(line);
    if (heading) {
      const b = document.createElement('strong');
      b.textContent = heading[1];
      el.appendChild(b);
    } else {
      el.appendChild(document.createTextNode((item ? '\u2022 ' + item[1] : line) + '\n'));
    }
  });
}

$('btn-updates-yes').onclick = async () => {
  await loadUpdate({ enabled: true });
  $('btn-dash-run').focus();
};
$('btn-updates-no').onclick = async () => {
  await loadUpdate({ enabled: false });
  $('btn-dash-run').focus();
};
$('checkForUpdates').onchange = () => loadUpdate({ enabled: $('checkForUpdates').checked });
$('btn-update-check').onclick = async () => {
  const b = $('btn-update-check');
  b.disabled = true;
  b.textContent = 'Checking…';
  await loadUpdate({ check: true });
  b.textContent = 'Check now';
  b.disabled = !(update && update.enabled);
};
const openUpdate = () => { $('update-copy-msg').textContent = ''; openDialog('dlg-update'); };
$('btn-update').onclick = openUpdate;
$('btn-update-how').onclick = () => { closeDialog('dlg-settings'); openUpdate(); };
$('btn-update-close').onclick = () => closeDialog('dlg-update');
$('btn-update-copy').onclick = async () => {
  try {
    await navigator.clipboard.writeText($('update-commands').textContent);
    $('update-copy-msg').textContent = 'Copied. Paste them into a terminal.';
  } catch {
    $('update-copy-msg').textContent = 'This browser would not copy them; select the commands and copy them by hand.';
  }
};

refresh();
</script>
</body>
</html>`;
