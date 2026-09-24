/**
 * Query parameters that carry a short-lived signature rather than identity.
 *
 * CDNs hand out signed, expiring URLs: the same underlying file gets a different URL on
 * every page load. Comparing raw URLs would therefore make every previously-downloaded
 * file look brand new on the next run, and the tool would re-download the whole archive
 * every day. Stripping these parameters yields a URL that stays stable across signature
 * renewals, so "have I already got this?" has a correct answer.
 *
 * Ported from Archive Ferry's `transfer_identity()`.
 *
 * Exported because it is also the list `scrub()` (secrets.ts) redacts from any text about to
 * be shown or logged. It used to keep its own seven names while this list had twenty-two, so
 * an `X-Amz-Signature` in an error message went out whole (security review outbound-8). One
 * list, read by both, cannot drift.
 */
export const SIGNATURE_PARAMS: ReadonlySet<string> = new Set([
  'token', 'signature', 'sig', 'expires', 'expiry', 'ex', 'e', 't', 'auth',
  'x-amz-signature', 'x-amz-credential', 'x-amz-date', 'x-amz-expires',
  'x-amz-security-token', 'x-amz-signedheaders', 'x-amz-algorithm',
  'x-goog-signature', 'x-goog-credential', 'x-goog-date', 'x-goog-expires',
  'key-pair-id', 'policy', 'awsaccesskeyid',
]);

/**
 * A stable identity for a remote file, ignoring signature/expiry query parameters
 * and the URL fragment. Two URLs with the same transfer identity refer to the same file.
 */
export function transferIdentity(rawUrl: string): string {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  const kept: [string, string][] = [];
  for (const [k, v] of u.searchParams) {
    if (!SIGNATURE_PARAMS.has(k.toLowerCase())) kept.push([k, v]);
  }
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const qs = new URLSearchParams(kept).toString();
  return `${u.origin}${u.pathname}${qs ? '?' + qs : ''}`;
}

/** True when two URLs point at the same remote file, ignoring signature churn. */
export function sameRemoteFile(a: string, b: string): boolean {
  return transferIdentity(a) === transferIdentity(b);
}

/**
 * When a signed URL stops working, if its query string says so.
 *
 * Understood: `expires` / `expiry` as a Unix time — seconds, or milliseconds when the
 * number is far too large to be seconds — and the AWS / GCS form where `X-Amz-Expires`
 * is a lifetime in seconds counted from `X-Amz-Date`. Anything else, or no expiry at all,
 * is null. Null must not be read as "still valid": the CDN's own 401/403 remains the final
 * word, and this is only a way to skip a request that is known to be doomed.
 *
 * A number too large to be a date — past the year 275760, which is where JavaScript's dates
 * end — is unreadable too, and so null: it used to come back as an Invalid Date, which the
 * type promised it never would (security review outbound-12).
 */
export function signedUrlExpiry(rawUrl: string): Date | null {
  const when = declaredExpiry(rawUrl);
  return when && Number.isFinite(when.getTime()) ? when : null;
}

function declaredExpiry(rawUrl: string): Date | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  const params = new Map<string, string>();
  for (const [k, v] of u.searchParams) params.set(k.toLowerCase(), v);

  const absolute = params.get('expires') ?? params.get('expiry');
  if (absolute && /^\d+$/.test(absolute)) {
    const n = Number(absolute);
    // Seconds will not reach 1e11 until the year 5138; milliseconds passed it in 1973.
    return new Date(n >= 1e11 ? n : n * 1000);
  }

  for (const vendor of ['x-amz', 'x-goog']) {
    const lifetime = params.get(`${vendor}-expires`);
    const issued = params.get(`${vendor}-date`);
    // The date is ISO 8601 basic format: 20260918T120000Z.
    const m = issued?.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
    if (lifetime && /^\d+$/.test(lifetime) && m) {
      const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number];
      return new Date(Date.UTC(y, mo - 1, d, h, mi, s) + Number(lifetime) * 1000);
    }
  }
  return null;
}

/**
 * Why this tool will not fetch a media file from `rawUrl`, in words for a message — or null
 * when it will.
 *
 * The address of every photo comes from Brightwheel's answer, and nothing used to check it:
 * any non-empty string was a media URL, so the API — or anything able to answer in its
 * name — could point the parent's own computer at any address it can reach: the router's
 * admin page, a printer, a service listening only on this machine (security review, the
 * outbound verifier's "media URL anywhere"). Brightwheel's media lives on a public CDN behind
 * https, so that is what is required:
 *
 *  - an address that parses, over https, with no user name or password in it;
 *  - not a literal address of this computer, the local network, a link-local range or
 *    anything else no CDN answers from — in every spelling, since the URL parser has already
 *    turned `0x7f.1`, `2130706433` and `[::ffff:127.0.0.1]` into their plain forms by the
 *    time this looks;
 *  - not a name that means the local network: a name with no dot in it (`router`,
 *    `localhost`), or one under a suffix reserved or commonly used for private names
 *    (`.local`, `.localhost`, `.internal`, `.home.arpa`, `.lan`, …).
 *
 * What it cannot see is a public-looking name whose DNS answer is a private address. Closing
 * that needs the address the connection is actually made to, which Node's built-in fetch
 * does not let a caller vet without a dependency this project does not take. The https
 * requirement narrows it (a service on the local network rarely holds a certificate for a
 * public name), and download() applies this same check to every redirect that leaves the
 * address it was given.
 *
 * `trustedOrigin` is the one exception, and it exists for the mock server, the demo and the
 * tests, which serve media from the same `http://127.0.0.1:<port>` they answer the API from.
 * A media URL on exactly that origin is accepted. The client passes one only when the API
 * address it was given is itself on this computer (`loopbackOrigin`), which the default
 * address never is — so a normal install cannot reach it, and a `--base-url` naming this
 * computer lets media come only from the very server that already holds the session.
 */
export function mediaUrlRefusal(rawUrl: string, trustedOrigin?: string | null): string | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return 'its address could not be read';
  }
  if (trustedOrigin && u.origin === trustedOrigin) return null;
  if (u.protocol !== 'https:') return 'it is not an https address';
  if (u.username || u.password) return 'its address carries a user name or password';
  if (isNonPublicHost(u.hostname)) return 'it points at this computer or the local network';
  return null;
}

/**
 * The origin of `baseUrl` when that address is this computer (127.0.0.0/8, ::1, localhost),
 * or null. What the client hands `mediaUrlRefusal` as its one trusted origin; see there.
 */
export function loopbackOrigin(baseUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/\.$/, '').toLowerCase();
  const v4 = ipv4(host);
  const v6 = host.startsWith('[') ? ipv6(host.slice(1, -1)) : null;
  const loopback =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    (v4 !== null && v4[0] === 127) ||
    (v6 !== null && v6.slice(0, 7).every((w) => w === 0) && v6[7] === 1);
  return loopback ? u.origin : null;
}

/**
 * Suffixes that name something on the local network rather than on the internet: the
 * special-use names of RFC 6761 and RFC 8375 (`localhost`, `local`, `home.arpa`), ICANN's
 * private-use `internal`, and the ones home and office routers hand out by habit. None is a
 * delegated top-level domain, so no public CDN can live under one.
 */
const LOCAL_SUFFIXES = ['localhost', 'local', 'internal', 'home.arpa', 'lan', 'home', 'intranet', 'corp', 'private', 'localdomain'];

/** A hostname, as `new URL()` leaves it, that is not a public internet address. */
function isNonPublicHost(hostname: string): boolean {
  const host = hostname.replace(/\.$/, '').toLowerCase();
  if (host.startsWith('[')) {
    const words = ipv6(host.slice(1, -1));
    return words === null || isNonPublicV6(words);
  }
  const v4 = ipv4(host);
  if (v4) return isNonPublicV4(v4);
  // A single label is looked up on the local network (search domains, mDNS, NetBIOS).
  if (!host.includes('.')) return true;
  return LOCAL_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

type V4 = [number, number, number, number];

/** The four numbers of a dotted IPv4 address, the form the URL parser gives every IPv4 host. */
function ipv4(host: string): V4 | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number) as V4;
  return parts.every((n) => n <= 255) ? parts : null;
}

/**
 * "This network", private (RFC 1918), shared (carrier-grade NAT), loopback, link-local, IETF
 * protocol assignments, benchmarking, multicast, reserved and broadcast: every IPv4 range no
 * CDN serves the public from.
 */
function isNonPublicV4([a, b, c]: V4): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/**
 * The eight 16-bit words of an IPv6 address in the form the URL parser writes it: lower-case
 * hex, at most one `::`, never a dotted IPv4 tail (it writes `::ffff:1.2.3.4` as
 * `::ffff:102:304`). Null for anything else.
 */
function ipv6(text: string): number[] | null {
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const words = (part: string | undefined): number[] | null => {
    if (!part) return [];
    const out = part.split(':').map((w) => (/^[0-9a-f]{1,4}$/.test(w) ? Number.parseInt(w, 16) : Number.NaN));
    return out.every(Number.isFinite) ? out : null;
  };
  const head = words(halves[0]);
  const tail = words(halves[1]);
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const gap = 8 - head.length - tail.length;
  return gap >= 1 ? [...head, ...new Array<number>(gap).fill(0), ...tail] : null;
}

/**
 * Unspecified, loopback, link-local, site-local, unique-local (IPv6's private range) and
 * multicast — and an IPv4 address carried inside an IPv6 one (compatible, mapped, NAT64,
 * 6to4), judged as that IPv4 address.
 */
function isNonPublicV6(w: number[]): boolean {
  const first = w[0]!;
  if ((first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0) return true;
  if ((first & 0xfe00) === 0xfc00 || (first & 0xff00) === 0xff00) return true;
  const carried = (hi: number, lo: number): V4 => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
  const zeros = (from: number, to: number) => w.slice(from, to).every((x) => x === 0);
  // ::a.b.c.d (compatible — which takes in :: and ::1 as 0.0.0.0 and 0.0.0.1) and ::ffff:a.b.c.d.
  if (zeros(0, 5) && (w[5] === 0 || w[5] === 0xffff)) return isNonPublicV4(carried(w[6]!, w[7]!));
  // 64:ff9b::a.b.c.d, the NAT64 well-known prefix.
  if (first === 0x64 && w[1] === 0xff9b && zeros(2, 6)) return isNonPublicV4(carried(w[6]!, w[7]!));
  // 2002:aabb:ccdd::/48, 6to4.
  if (first === 0x2002) return isNonPublicV4(carried(w[1]!, w[2]!));
  return false;
}
