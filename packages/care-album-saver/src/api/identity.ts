import { platform as osPlatform } from 'node:os';

/**
 * What this tool calls itself when it talks to Brightwheel: nothing of its own.
 *
 * It used to send `care-album-saver (+https://github.com/)` on every request. That named the
 * project to the one party most likely to want it gone, on every request, from every parent
 * using it — a single line in a log query away from blocking all of them at once. The
 * requests carry a parent's own session to that parent's own account, so there is nothing
 * about them that needs a name of their own.
 *
 * WHICH IDENTITY. The session is a *web* session: a browser's cookie, sent to the website's
 * own API with `X-Client-Name: web`, exactly as the website's scripts send it. So the
 * identity that fits it is a browser's — and best of all the very browser the session came
 * from, which the setup page sees on its own requests (`acceptableUserAgent`). Requests then
 * look as they would from that browser, and the session and the identity carrying it agree.
 * The mobile app's identity would not fit: it does not use this cookie or this header, and
 * pairing them would stand out more than either alone.
 *
 * Where no browser was involved — a session typed into `login` in a terminal, one passed to
 * Docker in an environment variable, or one saved before this existed — `browserUserAgent`
 * stands in: an ordinary desktop Chrome, in the frozen "reduced" form that every Chrome has
 * sent since 2023, with a version that keeps pace with the calendar rather than ageing into
 * something rare.
 */

/**
 * Chrome's stable releases, as a line. Calibrated against a real one rather than remembered
 * dates: on 23 September 2026 the stable Chrome installed on the development Mac was
 * 153.0.8010.54, and Chrome ships a version every four weeks, so 153 is dated to the start
 * of that month. A version every 28.5 days rather than 28 allows for the occasional skipped
 * release, so that over the years the estimate drifts behind the real one, never ahead of it.
 */
const ANCHOR_VERSION = 153;
const ANCHOR_DATE = Date.UTC(2026, 8, 1);
const DAYS_PER_VERSION = 28.5;

/**
 * The Chrome major version most people are on at `now`: the estimated current one, less one,
 * because a browser a version behind is common and one ahead of the stable channel is not.
 */
export function chromeMajor(now: Date = new Date()): number {
  const days = (now.getTime() - ANCHOR_DATE) / 86_400_000;
  return Math.max(ANCHOR_VERSION, ANCHOR_VERSION + Math.floor(days / DAYS_PER_VERSION) - 1);
}

/**
 * A stock desktop Chrome, as it identifies itself on this kind of computer.
 *
 * These are the reduced strings Chrome froze in 2023: the operating system part is the same
 * for every Mac, every 64-bit Windows and every Linux desktop, and only the major version
 * moves. So there is nothing here that tells one machine from another — which is the point.
 */
export function browserUserAgent(now: Date = new Date(), platform: NodeJS.Platform = osPlatform()): string {
  const system =
    platform === 'darwin'
      ? 'Macintosh; Intel Mac OS X 10_15_7'
      : platform === 'win32'
        ? 'Windows NT 10.0; Win64; x64'
        : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${system}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor(now)}.0.0.0 Safari/537.36`;
}

/** Every browser in use today starts this way; `curl`, `node` and scripts do not. */
const BROWSER_SHAPE = /^Mozilla\/5\.0 \([^()]+\)[\x20-\x7e]*$/;

/**
 * A User-Agent header worth keeping from the setup page's own request, or null.
 *
 * Only a browser's: anything else — a script calling the setup API, the test suite's own
 * fetch — is not the identity the session came from, and the stand-in is better than it.
 * Printable ASCII and a sane length only, since it goes back out as a header on every
 * request and a header cannot carry anything else.
 */
export function acceptableUserAgent(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const ua = value.trim();
  if (ua.length === 0 || ua.length > 512 || !BROWSER_SHAPE.test(ua)) return null;
  return ua;
}
