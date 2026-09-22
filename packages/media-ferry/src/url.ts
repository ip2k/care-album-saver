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
 */
const SIGNATURE_PARAMS = new Set([
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
 */
export function signedUrlExpiry(rawUrl: string): Date | null {
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
