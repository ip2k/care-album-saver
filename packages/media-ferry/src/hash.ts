import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/**
 * Streaming SHA-256 of a file, as lowercase hex.
 *
 * Archive Ferry (the Python project this library descends from) uses XXH3-128 for speed.
 * We deliberately use SHA-256 instead: it ships in Node's standard library, so this package
 * keeps a zero-dependency install. For a family photo archive the throughput difference is
 * irrelevant next to network time, and a stdlib hash is one fewer supply-chain risk.
 */
export async function hashFile(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) {
    h.update(chunk as Buffer);
  }
  return h.digest('hex');
}

export function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
