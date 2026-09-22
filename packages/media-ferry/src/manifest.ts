import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { transferIdentity } from './url.js';
import type { RemoteValidators } from './download.js';

export const MANIFEST_SCHEMA = 2;
export const MANIFEST_FILENAME = 'archive.json';

export interface ManifestRecord {
  /** Filename relative to the archive root, using forward slashes. */
  path: string;
  /** Stable identity supplied by the source service, e.g. "brightwheel:<media-id>". */
  sourceId: string | null;
  /** Remote URL with signature parameters stripped — stable across signed-URL renewal. */
  transferId: string | null;
  bytes: number;
  sha256: string;
  /** HTTP Last-Modified / ETag as reported by the server. Never a local mtime. */
  etag?: string | null;
  lastModified?: string | null;
  /** When this tool downloaded it (ISO 8601). Not the capture time. */
  downloadedAt: string;
  /** Free-form provenance from the adapter: capture time, child, note, etc. */
  provenance?: Record<string, unknown>;
}

export interface ManifestData {
  schema: number;
  source: string;
  updatedAt: string;
  /**
   * Policy note kept in the file itself so a reader years later knows what the
   * timestamps mean without reading this source code.
   */
  notes: string;
  /**
   * Facts the adapter needs to carry between runs that describe no single file — for
   * instance how far a previous run got. Optional, so manifests written before this field
   * existed still load; an adapter treats its absence as "nothing known".
   */
  state?: Record<string, unknown>;
  files: ManifestRecord[];
}

/**
 * The archive manifest: the tool's memory of what it has already saved.
 *
 * This is what makes a daily run cheap. Without it, every run would re-download
 * everything — and because CDN URLs are signed and change every time, naive URL
 * comparison cannot substitute for it.
 *
 * Lookups are by three independent keys, in order of trustworthiness:
 *   1. sourceId   - the service's own media id. Authoritative when present.
 *   2. transferId - the URL with signature parameters stripped.
 *   3. sha256     - content identity, which also catches the same photo posted twice.
 */
export class Manifest {
  private bySourceId = new Map<string, ManifestRecord>();
  private byTransferId = new Map<string, ManifestRecord>();
  private byHash = new Map<string, ManifestRecord>();
  private records: ManifestRecord[] = [];
  /** Adapter-owned state, persisted with the records. See `ManifestData.state`. */
  readonly state: Record<string, unknown> = {};

  private constructor(private readonly root: string, private readonly source: string) {}

  static async open(root: string, source: string): Promise<Manifest> {
    const m = new Manifest(root, source);
    try {
      const raw = await readFile(join(root, MANIFEST_FILENAME), 'utf8');
      const data = JSON.parse(raw) as ManifestData;
      // An unknown future schema is not something we can safely merge into. Start clean
      // rather than corrupt an archive written by a newer version.
      if (data.schema === MANIFEST_SCHEMA && Array.isArray(data.files)) {
        for (const r of data.files) m.index(r);
        if (data.state && typeof data.state === 'object' && !Array.isArray(data.state)) {
          Object.assign(m.state, data.state);
        }
      }
    } catch {
      // No manifest yet, or it is unreadable. Either way we start from empty.
    }
    return m;
  }

  private index(r: ManifestRecord): void {
    // Normalise on the way in. Storing the raw signed URL here while looking up the
    // stripped form would mean this index silently never matched, and every run would
    // re-download anything whose Brightwheel id had changed.
    if (r.transferId) r.transferId = transferIdentity(r.transferId);
    this.records.push(r);
    if (r.sourceId) this.bySourceId.set(r.sourceId, r);
    if (r.transferId) this.byTransferId.set(r.transferId, r);
    this.byHash.set(r.sha256, r);
  }

  /** Look up an already-downloaded file by service media id. */
  findBySourceId(id: string): ManifestRecord | undefined {
    return this.bySourceId.get(id);
  }

  /** Look up by URL, ignoring signature/expiry parameters. */
  findByUrl(url: string): ManifestRecord | undefined {
    return this.byTransferId.get(transferIdentity(url));
  }

  /** Look up by content hash — catches the identical photo posted twice. */
  findByHash(sha256: string): ManifestRecord | undefined {
    return this.byHash.get(sha256);
  }

  /** True when any key already matches, meaning there is nothing to download. */
  has(opts: { sourceId?: string | null; url?: string | null }): boolean {
    if (opts.sourceId && this.bySourceId.has(opts.sourceId)) return true;
    if (opts.url && this.byTransferId.has(transferIdentity(opts.url))) return true;
    return false;
  }

  add(record: Omit<ManifestRecord, 'downloadedAt'> & { downloadedAt?: string }): ManifestRecord {
    const full: ManifestRecord = {
      ...record,
      downloadedAt: record.downloadedAt ?? new Date().toISOString(),
    };
    const existing = full.sourceId ? this.bySourceId.get(full.sourceId) : undefined;
    if (existing) {
      Object.assign(existing, full);
      return existing;
    }
    this.index(full);
    return full;
  }

  get all(): readonly ManifestRecord[] {
    return this.records;
  }

  get size(): number {
    return this.records.length;
  }

  /**
   * Persist atomically: write a temp file then rename over the target. A half-written
   * manifest after a crash would make the tool forget files it actually has and
   * re-download them, so the rename (which is atomic on POSIX) matters.
   */
  async save(): Promise<void> {
    const data: ManifestData = {
      schema: MANIFEST_SCHEMA,
      source: this.source,
      updatedAt: new Date().toISOString(),
      notes:
        'downloadedAt is when this tool fetched the file. Capture time lives in ' +
        'provenance.capturedAt and in the file EXIF/XMP metadata. etag and lastModified ' +
        'are verbatim HTTP response headers; null means the server did not supply one. ' +
        'Local filesystem timestamps are never used as validators.',
      state: this.state,
      files: this.records,
    };
    const target = join(this.root, MANIFEST_FILENAME);
    const temp = `${target}.tmp`;
    await writeFile(temp, JSON.stringify(data, null, 2), 'utf8');
    await rename(temp, target);
  }
}

export type { RemoteValidators };
