import { createWriteStream } from 'node:fs';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { mediaUrlRefusal } from './url.js';

export interface RemoteValidators {
  /** HTTP ETag, if the server supplied one. */
  etag?: string | null;
  /** HTTP Last-Modified, verbatim. Never a local mtime. */
  lastModified?: string | null;
  /** The file's length in bytes, from Content-Length, when the server gave one. */
  size?: number | null;
}

export interface DownloadResult {
  path: string;
  bytes: number;
  validators: RemoteValidators;
}

export interface DownloadOptions {
  url: string;
  destination: string;
  headers?: Record<string, string>;
}

function readValidators(h: Headers): RemoteValidators {
  const len = h.get('content-length');
  return {
    etag: h.get('etag'),
    lastModified: h.get('last-modified'),
    size: len ? Number(len) : null,
  };
}

/**
 * What downloads ask for: the file as it is, never compressed in transit.
 *
 * Compression is where "is this the whole file?" stops having an answer. Content-Length then
 * counts the compressed bytes, not the file's, so comparing them failed every compressed
 * download as truncated (security review outbound-3). And fetch decompresses leniently — a
 * gzip or brotli stream cut off in the middle, inside a response that is otherwise complete,
 * comes out as a shorter file with no error at all, which would be saved, hashed, listed and
 * never fetched again. So compression is refused both ways: asked against here, and a
 * response that is compressed anyway is not saved (see download). Photographs and videos are
 * compressed already, so nothing is lost, and CDNs do not compress them.
 *
 * The value is the one a browser sends for a video: the photo requests otherwise carry the
 * browser identity the setup was given (BrightwheelClient.mediaHeaders), and a bare
 * `identity`, which is what wget sends, would stand out in a log where this does not.
 */
const MEDIA_ACCEPT_ENCODING = 'identity;q=1, *;q=0';

/**
 * Download a file to `<destination>.part` and rename it into place only once it is complete,
 * so a file under its real name is never a half-written one.
 *
 * A `.part` file left behind by an earlier, interrupted attempt is discarded rather than
 * resumed: nothing on disk proves it came from the same remote file, and splicing two
 * different files together would produce a corrupt image that still looks like a valid
 * download. A wasted transfer is cheap; a silently corrupted photo is not.
 */
export async function download(options: DownloadOptions): Promise<DownloadResult> {
  const { url, destination, headers = {} } = options;
  const partPath = `${destination}.part`;

  // Parsed here, before fetch sees it: an address fetch cannot parse comes back as "Failed to
  // parse URL from <the whole address>", signature and all, and that text went on into the
  // run's warnings and the daily log before anything could redact it (security review
  // outbound-8). Refused here, it is never quoted.
  let address: URL;
  try {
    address = new URL(url);
  } catch {
    throw new DownloadError(`The address of this file could not be read (${redactUrl(url)}), so it was not fetched.`);
  }

  await mkdir(dirname(destination), { recursive: true });
  await unlink(partPath).catch(() => {});

  const response = await fetchFollowingSafeRedirects(address, { 'Accept-Encoding': MEDIA_ACCEPT_ENCODING, ...headers });

  if (!response.ok) {
    throw new DownloadError(`HTTP ${response.status} for ${redactUrl(url)}`, response.status);
  }
  if (!response.body) {
    throw new DownloadError(`Empty response body for ${redactUrl(url)}`, response.status);
  }

  const encoding = response.headers.get('content-encoding')?.trim().toLowerCase();
  if (encoding && encoding !== 'identity') {
    // Not saved, so it is fetched again next time: a compressed body cannot be checked for
    // having arrived whole. See MEDIA_ACCEPT_ENCODING.
    await response.body.cancel().catch(() => {});
    throw new DownloadError(
      `The server sent ${redactUrl(url)} compressed (${encoding.slice(0, 40)}) although it was asked not to, so it ` +
        'could not be checked for having arrived whole and was not saved. It will be tried again next time.',
      response.status,
    );
  }

  const validators = readValidators(response.headers);
  const total = validators.size ?? null;

  // `wx`: the name is predictable, and the unlink above is not a guarantee — something could
  // put a symlink there in between. Opening exclusively refuses it rather than following it.
  // Its mode is the umask's; sync saves into a 0700 staging folder and makes each file
  // owner-only as it moves it into the archive (saveStaged, security review fs-10).
  const out = createWriteStream(partPath, { flags: 'wx' });
  const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);

  try {
    await pipeline(source, out);
  } catch (error) {
    // A connection that ends short of Content-Length is caught here, by fetch itself, which
    // calls it only "terminated". Said in words, and the half-file is not left to be found.
    await unlink(partPath).catch(() => {});
    throw new DownloadError(
      `The download of ${redactUrl(url)} stopped part-way (${error instanceof Error ? error.message : String(error)}). ` +
        'Nothing was kept; it will be fetched again from the start next time.',
      response.status,
    );
  }

  // Belt and braces: through Node's fetch, a body shorter than its Content-Length ends in the
  // catch above instead. Kept for any fetch that does not check.
  const finalSize = (await stat(partPath)).size;
  if (total !== null && finalSize !== total) {
    await unlink(partPath).catch(() => {});
    throw new DownloadError(
      `Truncated download: expected ${total} bytes, got ${finalSize}. It will be fetched again from the start next time.`,
      response.status,
    );
  }

  await rename(partPath, destination);
  return { path: destination, bytes: finalSize, validators };
}

/** The redirect statuses fetch would follow on its own. */
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
/** As many as fetch follows by default. */
const MAX_REDIRECTS = 20;

/**
 * `fetch`, following redirects itself so that each one can be looked at first.
 *
 * The address a download starts from has been checked (`mediaUrlRefusal`, applied where the
 * feed is parsed). A redirect used to be followed wherever it led, which would have made
 * that check a formality: a CDN address answering 302 to `http://192.168.1.1/` sends the
 * parent's computer there all the same. So a redirect that stays on the origin it came from
 * is followed as before, and one that leaves it must pass the same test as a media address
 * from the feed — https, and not this computer or the local network. The only headers are the
 * ones every media request carries (never the session: see BrightwheelClient.mediaHeaders),
 * so nothing is handed to the new origin that the old one was not given.
 */
async function fetchFollowingSafeRedirects(start: URL, headers: Record<string, string>): Promise<Response> {
  let current = start;
  for (let hops = 0; ; hops += 1) {
    const response = await fetch(current, { headers, redirect: 'manual' });
    if (!REDIRECTS.has(response.status)) return response;
    await response.body?.cancel().catch(() => {});
    const status = response.status;
    const location = response.headers.get('location');
    let next: URL;
    try {
      if (!location) throw new Error('no location');
      next = new URL(location, current);
    } catch {
      throw new DownloadError(`HTTP ${status} for ${redactUrl(current.href)} led nowhere this tool could read.`, status);
    }
    if (hops >= MAX_REDIRECTS) {
      throw new DownloadError(`${redactUrl(start.href)} redirected more than ${MAX_REDIRECTS} times, so it was not fetched.`, status);
    }
    if (next.origin !== current.origin) {
      const refused = mediaUrlRefusal(next.href);
      if (refused) {
        throw new DownloadError(
          `${redactUrl(current.href)} redirected to an address this tool does not fetch from, because ${refused} ` +
            `(${redactUrl(next.href)}). Nothing was fetched from it; it will be tried again next time.`,
          status,
        );
      }
    }
    current = next;
  }
}

export class DownloadError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'DownloadError';
  }
}

/**
 * Strip signed-URL query parameters before a URL appears in an error message or log.
 * A signed CDN URL is a bearer credential for that file; it must not end up in a log the
 * user might paste into a bug report.
 */
function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if ([...u.searchParams.keys()].length > 0) {
      return `${u.origin}${u.pathname}?<redacted>`;
    }
    return `${u.origin}${u.pathname}`;
  } catch {
    return '<unparseable url>';
  }
}
