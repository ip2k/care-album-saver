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
  /** Content-Length, if known. */
  size?: number | null;
}

export interface DownloadResult {
  path: string;
  bytes: number;
  resumed: boolean;
  validators: RemoteValidators;
}

export interface DownloadOptions {
  url: string;
  destination: string;
  headers?: Record<string, string>;
  /** Validators saved from a previous partial attempt, used to make resuming safe. */
  previous?: RemoteValidators;
  signal?: AbortSignal;
  onProgress?: (received: number, total: number | null) => void;
  fetchImpl?: typeof fetch;
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
 * Download a file, resuming a previous partial transfer when it is provably safe.
 *
 * The safety rule, inherited from Archive Ferry: never resume without a validator.
 * If we have bytes on disk but no ETag or Last-Modified from the original response, we
 * cannot prove the remote file is still the same one — resuming would splice two different
 * files together and produce a corrupt image that still looks like a valid download. In
 * that case we start over. A wasted transfer is cheap; a silently corrupted photo is not.
 *
 * `If-Range` makes this atomic on the server side: if the validator no longer matches,
 * the server ignores our Range and sends the whole file with 200, and we restart cleanly.
 */
export async function download(options: DownloadOptions): Promise<DownloadResult> {
  const { url, destination, headers = {}, previous, signal, onProgress } = options;
  const doFetch = options.fetchImpl ?? fetch;
  const partPath = `${destination}.part`;

  await mkdir(dirname(destination), { recursive: true });

  let offset = 0;
  const validator = previous?.etag || previous?.lastModified;
  if (validator) {
    try {
      offset = (await stat(partPath)).size;
    } catch {
      offset = 0;
    }
  } else {
    // No validator: any partial bytes are unverifiable. Discard them.
    await unlink(partPath).catch(() => {});
  }

  const requestHeaders: Record<string, string> = { ...headers };
  if (offset > 0 && validator) {
    requestHeaders['Range'] = `bytes=${offset}-`;
    requestHeaders['If-Range'] = validator;
  }

  const response = await doFetch(url, { headers: requestHeaders, signal, redirect: 'follow' });

  if (!response.ok && response.status !== 206) {
    throw new DownloadError(`HTTP ${response.status} for ${redactUrl(url)}`, response.status);
  }
  if (!response.body) {
    throw new DownloadError(`Empty response body for ${redactUrl(url)}`, response.status);
  }

  // A 200 in reply to a Range request means the server declined to resume — start over.
  let resumed = response.status === 206;
  if (offset > 0 && !resumed) {
    await unlink(partPath).catch(() => {});
    offset = 0;
  }

  const validators = readValidators(response.headers);
  const total = validators.size !== null && validators.size !== undefined
    ? validators.size + (resumed ? offset : 0)
    : null;

  let received = offset;
  const out = createWriteStream(partPath, resumed ? { flags: 'a' } : { flags: 'w' });
  const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);

  if (onProgress) {
    source.on('data', (chunk: Buffer) => {
      received += chunk.length;
      onProgress(received, total);
    });
  }

  await pipeline(source, out);

  const finalSize = (await stat(partPath)).size;
  if (total !== null && finalSize !== total) {
    throw new DownloadError(
      `Truncated download: expected ${total} bytes, got ${finalSize}. The partial file was kept for retry.`,
      response.status,
    );
  }

  await rename(partPath, destination);
  return { path: destination, bytes: finalSize, resumed, validators };
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
export function redactUrl(raw: string): string {
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
