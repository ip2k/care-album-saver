import { inspect } from 'node:util';
import { SIGNATURE_PARAMS } from './ferry/url.js';

/**
 * A string that must never be printed.
 *
 * The single most likely way a parent leaks their Brightwheel session is not an attacker —
 * it is pasting a log, a crash stack or a screenshot into a GitHub issue. Relying on every
 * future call site to remember not to log the cookie is a control that fails the first time
 * someone adds a `console.log(config)` while debugging.
 *
 * So the secret is made *unprintable by construction*. `Secret` wraps the value and
 * overrides every path Node uses to turn an object into text:
 *
 *   - `toString()`         - string concatenation, template literals
 *   - `toJSON()`           - JSON.stringify, which is how most log shippers serialise
 *   - `util.inspect.custom` - console.log, and therefore every crash dump and REPL echo
 *
 * Reading the real value requires calling `.expose()`, which is greppable. An auditor can
 * run one search and see every place the plaintext is touched.
 */
export class Secret {
  /**
   * A true ECMAScript private field, not a Symbol-keyed property.
   *
   * This matters and was measured. `util.inspect(secret, { customInspect: false })`
   * bypasses the custom inspector below, and a Symbol-keyed property is still visible
   * under `{ showHidden: true }`. A `#private` field is reachable from none of it:
   * not `inspect` (with any options), not object spread, not `Object.keys`,
   * not `JSON.stringify`, not `structuredClone`.
   */
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  /** Deliberately explicit. Grep for `.expose()` to audit every use of the plaintext. */
  expose(): string {
    return this.#value;
  }

  get length(): number {
    return this.#value.length;
  }

  /**
   * A stable, non-reversible fingerprint, safe to log. Lets a user confirm "yes, that is
   * the session I saved on Tuesday" without ever revealing the session itself.
   */
  fingerprint(): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < this.#value.length; i++) {
      h ^= this.#value.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0').slice(0, 8);
  }

  toString(): string {
    return '[redacted]';
  }

  /** Closes numeric and template-literal coercion, which bypass toString in some paths. */
  [Symbol.toPrimitive](): string {
    return '[redacted]';
  }

  toJSON(): string {
    return '[redacted]';
  }

  [inspect.custom](): string {
    return `Secret(${this.fingerprint()} … redacted)`;
  }
}

/**
 * Patterns that look like credentials, used as a last-resort scrub on any text about to
 * be shown to the user or written to a log file.
 *
 * This is defence in depth, not the primary control — the primary control is `Secret`.
 * It exists because third-party code (and our own mistakes) can put a raw cookie into an
 * error message before it reaches us.
 *
 * The signed-URL parameters are not listed here: they are `SIGNATURE_PARAMS`, the list
 * ferry/url.ts strips to tell one file from another. This file used to keep seven names of
 * its own while that one grew to twenty-two, so an `X-Amz-Signature` or `X-Goog-Credential`
 * in an error went out whole (security review outbound-8). Longest first, so a name is never
 * cut short by another that begins it; `=` must follow either way.
 */
const SIGNED_URL_PARAMETER = new RegExp(
  `([?&](?:${[...SIGNATURE_PARAMS]
    .sort((a, b) => b.length - a.length)
    .map((name) => name.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&'))
    .join('|')})=)[^&\\s"']+`,
  'gi',
);

const SCRUB_PATTERNS: [RegExp, string][] = [
  [/_brightwheel_v2=[^;\s"']+/gi, '_brightwheel_v2=[redacted]'],
  [/(set-cookie|cookie)\s*:\s*[^\n]+/gi, '$1: [redacted]'],
  [/(authorization)\s*:\s*[^\n]+/gi, '$1: [redacted]'],
  [SIGNED_URL_PARAMETER, '$1[redacted]'],
  [/\b\d{6}\b(?=\s*(?:is\s+)?(?:your\s+)?(?:2fa|code|verification))/gi, '[redacted-2fa-code]'],
];

/**
 * Remove anything that looks like a credential from arbitrary text.
 * Applied to every error message and progress line the CLI prints and the setup page is
 * shown.
 *
 * Note what it can and cannot recognise. It matches a value still attached to its
 * `_brightwheel_v2=` prefix and unbroken by whitespace — a BARE value is invisible to it,
 * and a value containing a newline is redacted only as far as that newline. Neither is a
 * gap to close with a cleverer pattern: a "long base64-ish blob" rule would redact half
 * the archive's own filenames. It is the reason the real control is refusing impossible
 * characters at the paste boundary, in `src/paste.ts`, so that nothing shaped like that
 * ever reaches a log to be scrubbed.
 */
export function scrub(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SCRUB_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** Scrub recursively through an object before it is serialised into a log. */
export function scrubDeep(value: unknown): unknown {
  if (value instanceof Secret) return '[redacted]';
  if (typeof value === 'string') return scrub(value);
  if (Array.isArray(value)) return value.map(scrubDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = /cookie|token|secret|password|session|auth/i.test(k) ? '[redacted]' : scrubDeep(v);
    }
    return out;
  }
  return value;
}
