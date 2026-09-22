/**
 * Making sense of what a parent pastes.
 *
 * The session value is the one thing this tool asks a person to copy by hand, out of a
 * developer-tools panel they have never seen before, and it arrives in every shape a
 * clipboard can produce: the whole row of the cookie table with the domain and the expiry
 * beside it, the cookie's *name* instead of its value, a `Cookie:` header line from a
 * network tab, a line from a saved HAR file, the value wrapped over three lines by a
 * narrow panel, or a value dressed in the curly quotes and non-breaking spaces a word
 * processor adds. Each of those used to be met with "session expired" or a transport
 * error from deep inside the HTTP client, which told the person nothing about what they
 * had actually done.
 *
 * So the same function runs in three places and gives the same answer in each: under the
 * paste box on the setup page, as the person types or pastes, before anything is sent;
 * in the setup server, before the value is tried against Brightwheel; and in the `login`
 * command. It cleans up what can safely be cleaned (whitespace, quotes, the row or header
 * around the value) and says so, refuses what is certainly something else (the name, a
 * web address, an email, a row with no value in it) and says why, and for a value of a
 * shape it does not recognise it warns but lets the person try — the real cookie's exact
 * shape has been seen on one account only, and a check that was wrong would lock every
 * other parent out.
 *
 * What it does NOT do: decode the value. The browser stores a Rails session cookie
 * percent-encoded and sends it that way; the value is passed on exactly as the browser
 * holds it, which is what the one successful run against the live service did.
 *
 * `inspectCookiePaste` is written to be self-contained — no imports, no module-level
 * helpers, no TypeScript-only runtime syntax — because the page embeds its compiled
 * source with `Function.prototype.toString` (`PASTE_CLIENT_SOURCE`). That is how one
 * implementation serves both sides without a bundler or a dependency: the project has
 * neither, by decision, and a validation library would have to be inlined into a page
 * whose policy loads nothing from the network.
 */

export type PasteKind = 'rails' | 'jwt' | 'unknown' | 'none';
export type PasteLevel = 'ok' | 'warn' | 'err';

export interface PasteVerdict {
  /** False means: certainly not a session value; do not send it. */
  ok: boolean;
  /** The cleaned value to use. Empty when `ok` is false. */
  value: string;
  kind: PasteKind;
  /** `err` blocks; `warn` lets the person try; `ok` is a recognised shape. */
  level: PasteLevel;
  /** One sentence for the person, safe to show: it never contains the pasted text. */
  message: string;
  /** What was cleaned up on the way, in words. Empty when nothing was. */
  notes: string[];
}

/**
 * Decide what a pasted string is, clean it if it can be cleaned, and say what happened.
 *
 * Self-contained on purpose: see the header comment. Every character class here is a
 * literal so the function survives `toString()` unchanged.
 */
export function inspectCookiePaste(raw: string): PasteVerdict {
  const notes: string[] = [];
  const refuse = (message: string): PasteVerdict => ({ ok: false, value: '', kind: 'none', level: 'err', message, notes });

  // 1. Invisible characters a word processor or a web page adds. A byte-order mark, the
  //    zero-width family, and non-breaking spaces would otherwise reach the octet check
  //    and produce a refusal the person cannot see the reason for.
  let text = String(raw == null ? '' : raw);
  const invisible = text.replace(/[\u200B-\u200D\u2060\uFEFF]/g, '');
  if (invisible !== text) notes.push('removed invisible characters');
  text = invisible.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ');
  // Curly quotes become straight ones so the quote-stripping below can see them.
  text = text.replace(/[\u2018\u2019\u201A\u201B]/g, "'").replace(/[\u201C\u201D\u201E\u201F]/g, '"');
  text = text.trim();
  if (!text) return refuse('Nothing pasted yet.');

  // 2. A header line from a network panel: "Cookie: a=1; _brightwheel_v2=…; b=2".
  const header = text.replace(/^(?:set-)?cookie\s*:\s*/i, '');
  if (header !== text) notes.push('took the cookie out of a header line');
  text = header;

  // 3. Just the name. The commonest mistake: the Name column copied instead of the Value.
  const bare = text.replace(/^["']+|["']+$/g, '').trim();
  if (bare !== text && !/\s/.test(bare)) notes.push('removed the quotes around it');
  if (/^_?brightwheel(?:_v\d+)?$/i.test(bare)) {
    return refuse("That is the cookie's name. Copy what is in the Value column of that row instead.");
  }

  // 4. The name with something after it: "name=value", a copied table row (name, tab,
  //    value, tab, domain…), a HAR entry ("name": "_brightwheel_v2", "value": "…"), or a
  //    whole cookie header. Take what follows the name.
  const named = text.match(/_brightwheel_v2["']?[\s,:="']*(?:value["']?\s*[:=]\s*["']?)?([^\s;"',]*)/i);
  if (named) {
    const candidate = named[1] ?? '';
    if (!candidate) {
      return refuse('The _brightwheel_v2 name is there but no value follows it. Copy the Value column of that row.');
    }
    if (candidate !== text) notes.push('took the value from beside its name');
    text = candidate;
  } else {
    // 5. No name in sight. Refuse the things that are certainly something else.
    if (/^https?:\/\//i.test(bare)) return refuse('That is a web address, not the cookie value.');
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(bare)) return refuse('That is an email address, not the cookie value.');
    if (/[;=].*;|;.*=/.test(bare) && /=/.test(bare)) {
      return refuse('That is a list of cookies, but _brightwheel_v2 is not among them. Look for that row and copy its Value column.');
    }

    // 6. Whitespace inside. Either the value was wrapped across lines by a narrow panel —
    //    a cookie value never contains whitespace, so joining is safe — or the person
    //    copied a row of the table without the name. Row columns are recognisable:
    //    a domain, a path, a date, a size, or a flag such as Lax or Strict.
    const tokens = bare.split(/\s+/).filter(Boolean);
    if (tokens.length > 1) {
      const column = /^(?:\.?[a-z0-9-]+\.)+[a-z]{2,}$|^\/|^\d{4}-\d{2}-\d{2}|^\d+$|^(?:true|false|\u2713|lax|strict|none|medium|high|session)$/i;
      if (tokens.slice(1).some((t) => column.test(t))) {
        return refuse('That looks like a whole row of the cookie table. Copy only what is in the Value column.');
      }
      const joined = tokens.join('');
      if (joined.length < 40) return refuse('That looks like more than one thing. Copy only the value of the _brightwheel_v2 row.');
      notes.push(`joined ${tokens.length} pieces that had been split by spaces or line breaks`);
      text = joined;
    } else {
      text = tokens[0] ?? '';
    }
  }

  // 7. Quotes around the value, from a HAR or a hand-typed shell line.
  text = text.replace(/^["']+|["']+$/g, '');
  if (!text) return refuse('Nothing was left once the quotes came off.');

  // 8. Only characters a cookie value can hold (RFC 6265 cookie-octet): no control
  //    characters, whitespace, quotes, commas, semicolons or backslashes. This is the
  //    check that keeps a stray character out of the HTTP client, whose own complaint
  //    would quote the whole value back.
  if (!/^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]+$/.test(text)) {
    return refuse('That contains characters a cookie value cannot hold. Copy the Value column again, on its own.');
  }

  // 9. The shape. A Rails session cookie is base64 (percent-encoded, so `%3D` for `=`)
  //    with `--` between its parts: two parts for a signed cookie, three for an encrypted
  //    one. A JWT is three base64url parts joined by dots, and its first part decodes to
  //    JSON naming an algorithm; Brightwheel's session cookie has not looked like one, so
  //    a JWT most likely came from a different site's row.
  const size = `${text.length} characters`;
  if (/^[A-Za-z0-9%+\/=_-]+--[A-Za-z0-9%+\/=_-]+(?:--[A-Za-z0-9%+\/=_-]+)?$/.test(text)) {
    return { ok: true, value: text, kind: 'rails', level: 'ok', message: `Looks like a Brightwheel session (${size}).`, notes };
  }
  const jwt = text.match(/^([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/);
  if (jwt) {
    let isJwt = false;
    try {
      const b64 = (jwt[1] ?? '').replace(/-/g, '+').replace(/_/g, '/');
      const decode = (globalThis as { atob?: (s: string) => string }).atob;
      const head = decode ? decode(b64 + '==='.slice((b64.length + 3) % 4)) : '';
      isJwt = /"alg"\s*:/.test(head);
    } catch {
      isJwt = false;
    }
    if (isJwt) {
      return {
        ok: true,
        value: text,
        kind: 'jwt',
        level: 'warn',
        message: `This is a JWT (a signed token, ${size}). Brightwheel's session cookie does not usually look like one, so check that you copied the _brightwheel_v2 row and not another. You can still try it.`,
        notes,
      };
    }
  }
  if (text.length < 20) {
    return { ok: true, value: text, kind: 'unknown', level: 'warn', message: `That is shorter than a session usually is (${size}). You can try it, but check you copied the whole value.`, notes };
  }
  return { ok: true, value: text, kind: 'unknown', level: 'warn', message: `Not a shape this tool recognises (${size}), but it may still be right. Press Connect to try it.`, notes };
}

/**
 * A folder path as a person pastes it: trimmed, freed of invisible characters, and of
 * the quotes a shell or a "copy path" command wraps around it. Nothing else — resolving
 * and refusing paths is safety.ts's job.
 */
export function cleanPastedPath(raw: string): string {
  let text = String(raw == null ? '' : raw)
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .trim();
  const m = text.match(/^(["'])(.*)\1$/s);
  if (m) text = (m[2] ?? '').trim();
  return text;
}

/**
 * The two functions above as source text, for the setup page's inline script. Built once
 * at import, from the compiled JavaScript, so the page can never drift from the server.
 */
export const PASTE_CLIENT_SOURCE = `${inspectCookiePaste.toString()}\n${cleanPastedPath.toString()}`;
