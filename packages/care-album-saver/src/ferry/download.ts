import { createWriteStream } from 'node:fs';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface RemoteValidators {
  /** HTTP ETag, if the server supplied one. */
  etag?: string | null;
  /** HTTP Last-Modified, verbatim. Never a local mtime. */
  lastModified?: string | null;
  /**
   * The file's length in bytes, from Content-Length — or null when the server gave none, or
   * when the body came compressed in transit, since Content-Length then counts the
   * compressed bytes rather than the file's.
   */
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
  // fetch undoes gzip, deflate and br before a byte reaches us, so what lands on disk is
  // the decoded file while Content-Length measured the encoded one. Compared anyway, every
  // compressed download failed as "truncated" (security review outbound-3).
  const encoding = h.get('content-encoding')?.trim().toLowerCase();
  const encoded = Boolean(encoding) && encoding !== 'identity';
  return {
    etag: h.get('etag'),
    lastModified: h.get('last-modified'),
    size: len && !encoded ? Number(len) : null,
  };
}

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

  await mkdir(dirname(destination), { recursive: true });
  await unlink(partPath).catch(() => {});

  // Asked for uncompressed: photographs and videos are compressed already, so gzip gains
  // nothing, and an uncompressed body is one whose length can be checked. A server that
  // compresses anyway is handled in readValidators.
  const response = await fetch(url, { headers: { 'Accept-Encoding': 'identity', ...headers }, redirect: 'follow' });

  if (!response.ok) {
    throw new DownloadError(`HTTP ${response.status} for ${redactUrl(url)}`, response.status);
  }
  if (!response.body) {
    throw new DownloadError(`Empty response body for ${redactUrl(url)}`, response.status);
  }

  const validators = readValidators(response.headers);
  const total = validators.size ?? null;

  // `wx`: the name is predictable, and the unlink above is not a guarantee — something could
  // put a symlink there in between. Opening exclusively refuses it rather than following it.
  const out = createWriteStream(partPath, { flags: 'wx' });
  const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);

  await pipeline(source, out);

  const finalSize = (await stat(partPath)).size;
  if (total !== null && finalSize !== total) {
    throw new DownloadError(
      `Truncated download: expected ${total} bytes, got ${finalSize}. It will be fetched again from the start next time.`,
      response.status,
    );
  }

  await rename(partPath, destination);
  return { path: destination, bytes: finalSize, validators };
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
