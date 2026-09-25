/**
 * What Brightwheel sends that this tool refuses to hold, even for a moment.
 *
 * Brightwheel does not keep a child's check-in and pickup code behind an endpoint of its own.
 * It embeds it: every activity record carries the child as `target`, with their
 * `raw_passcode`, their `invite_code` and the family's phone numbers, and `/users/me` carries
 * the parent's own (confirmed on a live account, 2026-09-22; SECURITY.md). The photos come in
 * the same answers, so the tool cannot ask for one without being sent the other. Brightwheel's
 * own website is sent them too, by the same endpoint, every time the feed scrolls.
 *
 * What the tool can do is refuse to keep them. Every answer from Brightwheel is parsed by
 * `parseWithheld`, whose reviver drops each withheld field as the text is read, so the parsed
 * object never has it: no parser, log line, error message, report or file can reach it,
 * because by the time any of them runs it does not exist. (The answer's text holds it until
 * the parse is done, and a parse that fails is reported without quoting that text.) The parsers' allowlist of named
 * fields was already a guarantee about disk; this is the same guarantee about memory, and it
 * does not depend on every future parser remembering to be careful (docs/DECISIONS.md A5).
 *
 * Withheld by the words in a field's name rather than by a list of names, so that a code
 * Brightwheel adds under a new name (`checkin_code`, `pickupPin2`, `kioskPasscode`) is dropped
 * too: any word ending in "code", the word "pin", a password, passphrase, passkey or one-time
 * password, a token or a secret, any phone or SMS number, and pairs such as a pickup word, a
 * security key or a check-in number. A name that says none of those is not caught, which is
 * why the parsers behind this still take named fields only. Nothing the tool reads has a name
 * like that; the tests check both halves.
 */

/**
 * The words of a field's name, lower case: `checkInCode2`, `check_in_code_2` and `CHECK-IN-CODE2`
 * are all check, in, code, 2. A number is a word of its own, so `pin1` is still a pin.
 */
function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])([0-9])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** A word that is enough on its own: a code, a PIN, a password or passkey, a token, a secret, a number to call. */
const WITHHELD_WORD = /^(?:.*codes?|pins?|pinnumbers?|pass(?:word|wd|phrase|key)s?|pwd?|otps?|tokens?|secrets?|phones?|sms|mobile)$/;
/** Two words that are one: a pickup word, a security key, a check-in number, a safe phrase. */
const WITHHELD_PAIR = /(?:^|_)(?:safe|security|secret|pickup|pick_up|checkin|check_in|checkout|check_out|kiosk|pass|access)_(?:words?|keys?|numbers?|phrases?)(?:_|$)/;

/** True for a field whose value this tool never needs and must never hold. */
export function isWithheld(name: string): boolean {
  const parts = words(name);
  return parts.some((word) => WITHHELD_WORD.test(word)) || WITHHELD_PAIR.test(parts.join('_'));
}

/**
 * The names of withheld fields as `verify` may print them: field names, never values, and
 * only ones shaped like a field name, so that an answer keyed by something else (an id, say)
 * cannot put that into a report meant to be pasted into a public issue.
 */
function printableName(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(name) ? name : '(a field with an unusual name)';
}

/**
 * JSON.parse, without the withheld fields.
 *
 * `seen`, when given, collects the names of the fields that were dropped, never their values,
 * so that `verify` can still say that Brightwheel sent them.
 */
export function parseWithheld(text: string, seen?: Set<string>): unknown {
  return JSON.parse(text, (name, value: unknown) => {
    // The root is reached with an empty name, and an array's entries with their index.
    if (name !== '' && isWithheld(name)) {
      seen?.add(printableName(name));
      return undefined;
    }
    return value;
  });
}
