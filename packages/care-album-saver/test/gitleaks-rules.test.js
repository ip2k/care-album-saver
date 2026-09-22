// First, before anything that can read the config directory (see scripts/test-env.js).
import { assertIsolatedConfigDir } from '../../../scripts/test-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

assertIsolatedConfigDir();

/**
 * The secret scanner's own rules, tested.
 *
 * `.gitleaks.toml` is the control that is meant to catch a real Brightwheel session
 * committed by mistake, and nothing has ever checked that it does. It did not: the
 * signed-URL rule matched lowercase `signature=` only, while the live CDN is CloudFront
 * and spells it `Signature=`. A rule that recognises the mock's URLs and none of the real
 * ones is worse than no rule, because it is cited as a control.
 *
 * gitleaks is a Go program using RE2, and these are JavaScript regexes, so this is a close
 * reading rather than a proof. The two differ mainly in what they refuse to compile;
 * neither engine changes what `(?i)` or a character class means, which is what is asserted
 * here. The inline `(?i)` flag is the one piece of syntax JavaScript does not share, so it
 * is translated rather than ignored.
 */
const TOML = new URL('../../../.gitleaks.toml', import.meta.url);

/** The rules and the allowlist, read out of the TOML without a parser dependency. */
async function rules() {
  const text = await readFile(TOML, 'utf8');
  const out = { rules: [], allowlist: [] };
  let inAllowlist = false;
  let id = null;
  for (const line of text.split('\n')) {
    if (/^\[\[rules\]\]/.test(line)) { inAllowlist = false; id = null; continue; }
    if (/^\[allowlist\]/.test(line)) { inAllowlist = true; continue; }
    const idMatch = line.match(/^id\s*=\s*"([^"]+)"/);
    if (idMatch) { id = idMatch[1]; continue; }
    const re = line.match(/'''(.*)'''/);
    if (!re) continue;
    (inAllowlist ? out.allowlist : out.rules).push({ id, source: re[1] });
  }
  return out;
}

/** `(?i)` is a Go inline flag; JavaScript spells it as the `i` modifier. */
const compile = ({ source }) => {
  const insensitive = source.startsWith('(?i)');
  return new RegExp(insensitive ? source.slice(4) : source, insensitive ? 'i' : '');
};

const CLOUDFRONT =
  'https://media.example.invalid/photo/act-123.jpg' +
  '?Expires=1790000000&Signature=NotARealSignature~aBcD-eF_gH1234567890abcdefgh__&Key-Pair-Id=APKAEXAMPLE';
const LOWERCASE = 'https://cdn.example.invalid/x.jpg?signature=NotARealSignature0123456789abcdef&expires=1790000000';
const COOKIE = '_brightwheel_v2=NotARealSession' + 'q'.repeat(180) + '%3D%3D--' + 'b'.repeat(40);

const fires = (rs, text) => rs.some((r) => compile(r).test(text));

test('every rule and allowlist entry in .gitleaks.toml compiles', async () => {
  const { rules: rs, allowlist } = await rules();
  assert.ok(rs.length >= 3, `expected the project's own rules, found ${rs.length}`);
  assert.ok(allowlist.length >= 4, `expected the synthetic-value allowlist, found ${allowlist.length}`);
  for (const r of [...rs, ...allowlist]) assert.doesNotThrow(() => compile(r), `${r.id ?? 'allowlist'}: ${r.source}`);
});

test('the signed-URL rule catches the shape the live service actually uses', async () => {
  const { rules: rs } = await rules();
  const signed = rs.filter((r) => r.id === 'signed-media-url');
  assert.equal(signed.length, 1, 'the rule is still there');

  // CloudFront: capital S, and a signature that may contain `~`. This is the case the rule
  // was written for and did not match until 2026-09-22.
  assert.ok(fires(signed, CLOUDFRONT), 'a CloudFront-signed media URL is caught');
  assert.ok(fires(signed, LOWERCASE), 'and so is the lowercase form the mock mints');
});

test('a pasted session cookie is caught, in a source file or a HAR', async () => {
  const { rules: rs } = await rules();
  assert.ok(fires(rs, COOKIE), 'a bare _brightwheel_v2= assignment');
  assert.ok(fires(rs, `Cookie: ${COOKIE}; other=1`), 'a header line copied from a network panel');
  assert.ok(fires(rs, `"cookie": "NotARealSession${'z'.repeat(60)}"`), 'a saved session.json payload');
});

test('the invented values this repository commits on purpose are allowlisted', async () => {
  const { allowlist } = await rules();
  for (const value of ['test-session-value', 'super-secret-cookie-value', 'signature=deadbeef', 'signature=not-a-real-signature']) {
    assert.ok(fires(allowlist, value), `${value} is exempt, so the scanner stays quiet about the fixtures`);
  }
  // And the allowlist is case-insensitive where the rules are, or a fixture rewritten to
  // CloudFront's spelling would be reported as a leak on every run.
  assert.ok(fires(allowlist, 'Signature=not-a-real-signature'), 'including when spelled as CloudFront spells it');
});

test('the allowlist exempts only the invented values, not any session-shaped one', async () => {
  const { allowlist, rules: rs } = await rules();

  // Assembled at runtime from repeats, so this file contains no long literal for the
  // scanner to find, and carries none of the markers the allowlist exempts. It stands in
  // for the thing the whole config exists to catch: somebody's real session, pasted into
  // a test while debugging and committed.
  const unmarked = '_brightwheel_v2=' + 'A'.repeat(140) + '%3D%3D--' + 'f'.repeat(40);
  const unmarkedUrl = 'https://media.example.invalid/p.jpg?Expires=1790000000&Signature=' + 'k'.repeat(43) + '&Key-Pair-Id=APKAEXAMPLE';

  assert.ok(fires(rs, unmarked), 'the rules catch a session-shaped value');
  assert.ok(!fires(allowlist, unmarked), 'and nothing in the allowlist waves it through');
  assert.ok(fires(rs, unmarkedUrl), 'the rules catch a signed media URL');
  assert.ok(!fires(allowlist, unmarkedUrl), 'and nothing in the allowlist waves that through either');

  // The allowlist earns its keep only if it is narrower than the rules: every entry must
  // be a value, never a path. A path entry switched the rules off across the whole test
  // tree once already, which is where a real session gets pasted.
  for (const entry of allowlist) {
    // A path contains a separator; the invented values do not. That is the whole tell, and
    // it is enough: the entry that caused the trouble was `packages/.*/test/.*`.
    assert.ok(
      !entry.source.includes('/'),
      `allowlist entries must be values, never paths: ${entry.source}`,
    );
  }
});
