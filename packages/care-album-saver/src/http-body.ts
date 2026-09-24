/**
 * Reading an answer's body with a limit on how much of it is read.
 *
 * `response.text()` reads everything the other end sends before it returns, so a limit
 * checked afterwards — the update check's 1 MB was — protects nothing: an answer of a
 * gigabyte is a gigabyte in memory first, and a compressed one decodes to as much as it
 * likes. Brightwheel's client had no limit at all. Both now read through this, which stops
 * reading, and closes the connection, as soon as the answer passes the limit (security
 * review outbound-7).
 *
 * The limit counts the bytes as they arrive after decoding, which is what ends up in
 * memory, so a small compressed answer that unpacks into a large one is caught too.
 */

/** The answer was longer than the caller is prepared to hold. Nothing of it is returned. */
export class BodyTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`The answer was larger than ${limit} bytes, so it was not read.`);
    this.name = 'BodyTooLargeError';
  }
}

/**
 * The body as text, as `response.text()` would give it — UTF-8, a leading byte-order mark
 * dropped — or a BodyTooLargeError once more than `limit` bytes have arrived.
 */
export async function readBodyText(response: Response, limit: number): Promise<string> {
  // An answer that says in advance it is too long is refused before a byte of it is read.
  // Only when it is not compressed: then the length is of the compressed form, and the
  // count below is the one that decides.
  const declared = response.headers.get('content-length')?.trim() ?? '';
  if (!response.headers.get('content-encoding') && /^\d+$/.test(declared) && Number(declared) > limit) {
    await response.body?.cancel().catch(() => {});
    throw new BodyTooLargeError(limit);
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      // Cancelling tells the other end to stop sending, rather than leaving the rest to
      // arrive into a buffer nobody reads.
      await reader.cancel().catch(() => {});
      throw new BodyTooLargeError(limit);
    }
    chunks.push(value);
  }
  // Decoded once, at the end, so a character split across two chunks is read whole.
  return new TextDecoder('utf-8').decode(Buffer.concat(chunks, size));
}
