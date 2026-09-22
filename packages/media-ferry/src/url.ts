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
