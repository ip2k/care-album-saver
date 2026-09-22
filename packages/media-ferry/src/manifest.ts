import { chmod, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { transferIdentity } from './url.js';
import type { RemoteValidators } from './download.js';

export const MANIFEST_SCHEMA = 2;
export const MANIFEST_FILENAME = 'archive.json';

/**
 * Default POSIX permissions for the manifest file: owner only.
 *
 * The manifest is not a list of filenames. Every record carries whatever `provenance` the
 * adapter chose to write, and for an archive of personal media that is people — who is in
 * the file, who posted it, what they said about it. A file describing people should not be
 * readable by every account on a shared computer merely because 0644 is what `writeFile`
 * does by default, so the cautious mode is the default here and a caller that wants the
 * manifest shared passes its own.
 *
 * Windows has no POSIX modes; there the file inherits the ACL of the folder it sits in,
 * and `save` skips the mode entirely rather than pretending otherwise.
 */
export const MANIFEST_FILE_MODE = 0o600;

export interface ManifestOptions {
  /**
   * Permissions for the manifest file on POSIX systems. Defaults to
   * {@link MANIFEST_FILE_MODE}, which is owner-only; pass e.g. `0o644` for an archive that
   * is meant to be read by other accounts. Ignored on Windows.
   */
  fileMode?: number;
}

export interface ManifestRecord {
  /**
   * Filename relative to the archive root, using forward slashes on every platform. The
   * manifest travels with the archive — a drive moved from a Windows machine to a Mac —
   * so the one form that every platform's `path.join` accepts is the one stored.
   */
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

const why = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * A manifest exists but cannot be used, so the run refuses to go on.
 *
 * The message is written for the person holding the archive, not for a developer: it names
 * the file, says nothing has been changed, and gives the one safe way forward. Rebuilding
 * from scratch is a real option — it costs a second copy of every photo — so it is offered,
 * but only after moving the existing file somewhere safe, never by overwriting it here.
 */
export class ManifestUnusableError extends Error {
  constructor(public readonly path: string, reason: string) {
    super(
      `The list of what has already been saved (${path}) cannot be used: ${reason}. ` +
        'Nothing has been changed and nothing has been downloaded. Move that file somewhere safe ' +
        'and run again to rebuild the archive — which will download every photo a second time — ' +
        'or ask for help before running again.',
    );
    this.name = 'ManifestUnusableError';
  }
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
  private byPath = new Map<string, ManifestRecord>();
  private records: ManifestRecord[] = [];
  /** Adapter-owned state, persisted with the records. See `ManifestData.state`. */
  readonly state: Record<string, unknown> = {};

  private constructor(
    private readonly root: string,
    private readonly source: string,
    private readonly fileMode: number,
  ) {}

  /**
   * Load the manifest for an archive, or start a new one.
   *
   * Two situations that look alike from here are kept strictly apart, because treating
   * them alike destroys archives. "There is no manifest yet" is the ordinary first run and
   * starts empty. "There is a manifest and it cannot be used" — unreadable, not JSON,
   * truncated by a full disk, or written to a schema this build does not know — is refused
   * outright, and nothing on disk is touched. Starting empty in that case would re-download
   * the whole archive as `-2` duplicates, overwrite the only copy of the file that said
   * what had already been saved, and throw away how far each child's feed had been walked
   * — and then do it all again on the next run.
   */
  static async open(root: string, source: string, options: ManifestOptions = {}): Promise<Manifest> {
    const m = new Manifest(root, source, options.fileMode ?? MANIFEST_FILE_MODE);
    const file = join(root, MANIFEST_FILENAME);

    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      // Only "it is not there" is an ordinary first run. A permission error or a directory
      // in its place means a manifest may well exist and simply cannot be read.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return m;
      throw new ManifestUnusableError(file, why(error));
    }

    let data: ManifestData;
    try {
      data = JSON.parse(raw) as ManifestData;
    } catch (error) {
      throw new ManifestUnusableError(file, `it is not readable as JSON (${why(error)})`);
    }
    if (typeof data !== 'object' || data === null || !Array.isArray(data.files)) {
      throw new ManifestUnusableError(file, 'it does not contain a list of saved files');
    }
    if (typeof data.schema !== 'number' || !Number.isFinite(data.schema)) {
      throw new ManifestUnusableError(file, 'it does not say which format it was written in');
    }
    if (data.schema > MANIFEST_SCHEMA) {
      throw new ManifestUnusableError(
        file,
        `it was written by a newer version of this tool (format ${data.schema}; this one understands ${MANIFEST_SCHEMA}). ` +
          'Updating the tool should be enough',
      );
    }
    if (data.schema !== MANIFEST_SCHEMA) {
      // No migration exists, and guessing at an older layout would mis-index the archive.
      throw new ManifestUnusableError(
        file,
        `it was written in an older format (${data.schema}) that this version cannot read`,
      );
    }

    for (const r of data.files) m.index(r);
    if (data.state && typeof data.state === 'object' && !Array.isArray(data.state)) {
      Object.assign(m.state, data.state);
    }
    return m;
  }

  private index(r: ManifestRecord): void {
    // Normalise on the way in. Storing the raw signed URL here while looking up the
    // stripped form would mean this index silently never matched, and every run would
    // re-download anything whose Brightwheel id had changed.
    if (r.transferId) r.transferId = transferIdentity(r.transferId);
    // Likewise the path: a manifest written on Windows before paths were normalised holds
    // backslashes, and a reader on any platform should see the one documented form.
    r.path = posixPath(r.path);
    this.records.push(r);
    if (r.sourceId) this.bySourceId.set(r.sourceId, r);
    if (r.transferId) this.byTransferId.set(r.transferId, r);
    this.byHash.set(r.sha256, r);
    this.byPath.set(r.path, r);
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

  /** Look up by archive-relative path, written with either kind of slash. */
  findByPath(path: string): ManifestRecord | undefined {
    return this.byPath.get(posixPath(path));
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
      path: posixPath(record.path),
      downloadedAt: record.downloadedAt ?? new Date().toISOString(),
    };
    const existing = full.sourceId ? this.bySourceId.get(full.sourceId) : undefined;
    if (existing) {
      this.byPath.delete(existing.path);
      Object.assign(existing, full);
      this.byPath.set(existing.path, existing);
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
   *
   * The mode goes on the *create*, not on a `chmod` afterwards: doing it in two steps
   * leaves a window, however short, in which a file describing people is readable by every
   * account on the machine. The rename carries the mode across with it, which also means a
   * manifest left at 0644 by an older version is replaced rather than corrected in place.
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
    await writeFile(temp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: this.fileMode });
    if (process.platform !== 'win32') {
      // Re-assert: the create mode is filtered by the process umask, and a temp file left
      // behind by a crashed run is truncated by the write above but keeps its old mode.
      await chmod(temp, this.fileMode);
    }
    await rename(temp, target);
  }
}

/** The forward-slash form of an archive-relative path, whichever separator it arrived with. */
function posixPath(path: string): string {
  return path.replaceAll('\\', '/');
}

export type { RemoteValidators };
