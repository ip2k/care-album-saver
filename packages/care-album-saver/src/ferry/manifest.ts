import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeAtomically } from './atomic.js';
import { transferIdentity } from './url.js';

const MANIFEST_SCHEMA = 2;
export const MANIFEST_FILENAME = 'archive.json';

/**
 * POSIX permissions for the manifest file: owner only.
 *
 * The manifest is not a list of filenames. Every record carries whatever `provenance` the
 * adapter chose to write, and for an archive of personal media that is people — who is in
 * the file, who posted it, what they said about it. A file describing people should not be
 * readable by every account on a shared computer merely because 0644 is what `writeFile`
 * does by default, so the cautious mode is the only one this module writes.
 *
 * Windows has no POSIX modes; there the file inherits the ACL of the folder it sits in,
 * and `save` skips the mode entirely rather than pretending otherwise.
 */
const MANIFEST_FILE_MODE = 0o600;

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
  /** Free-form provenance from the adapter: posted time, child, note, etc. */
  provenance?: Record<string, unknown>;
}

interface ManifestData {
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

const SHA256 = /^[0-9a-f]{64}$/i;

/**
 * Whether an entry of the list is one this tool can use: THE rule, for every reader of
 * archive.json (security review fs-8, web-9).
 *
 * An object, whose `path` is a non-empty string without a NUL, whose `sha256` is a SHA-256 in
 * hex or empty, and whose `downloadedAt` is a time. Every entry this tool has ever written is
 * one. The list sits in the photos folder, where anything else that can write the folder —
 * a sync peer, a hand edit, a future bug — can put something else, and before this rule an
 * entry such as `null` or `{"path": 5}` threw a raw TypeError out of the run, the gallery,
 * the Photos count and every maintenance action alike.
 *
 * `Manifest.open` refuses a list holding such an entry (see there, for why refusing rather
 * than skipping); the gallery and the Photos count pass over one; maintenance counts them,
 * reports them, and lets the parent's repair set them aside.
 */
export function usableRecord(value: unknown): value is ManifestRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const r = value as Partial<Record<keyof ManifestRecord, unknown>>;
  return (
    typeof r.path === 'string' &&
    r.path !== '' &&
    !r.path.includes('\u0000') &&
    typeof r.sha256 === 'string' &&
    (r.sha256 === '' || SHA256.test(r.sha256)) &&
    typeof r.downloadedAt === 'string' &&
    Number.isFinite(Date.parse(r.downloadedAt))
  );
}

/** The list as it is on disk: its fields, its usable entries, and every entry as found. */
export interface ManifestFile {
  /** Every field of the file, `files` included, untouched. */
  data: Record<string, unknown>;
  /** The entries `usableRecord` accepts, in the file's order. */
  records: ManifestRecord[];
  /** Every entry, usable or not, in the file's order: what a writer carries through. */
  entries: unknown[];
  /** How many entries `usableRecord` refused, and the position (from 1) of the first. */
  unusable: number;
  firstUnusable: number | null;
}

/**
 * A manifest exists but cannot be used, so the run refuses to go on.
 *
 * The message is written for the person holding the archive, not for a developer: it names
 * the file, says nothing has been changed, and gives the one safe way forward. Rebuilding
 * from scratch is a real option — it costs a second copy of every photo — so it is offered,
 * but only after moving the existing file somewhere safe, never by overwriting it here.
 * `advice` replaces that way forward when there is a better one, as there is for a list that
 * is whole but holds entries this tool cannot use.
 */
export class ManifestUnusableError extends Error {
  constructor(public readonly path: string, reason: string, advice?: string) {
    super(
      `The list of what has already been saved (${path}) cannot be used: ${reason}. ` +
        'Nothing has been changed and nothing has been downloaded. ' +
        (advice ??
          'Move that file somewhere safe and run again to rebuild the archive — which will download every photo a ' +
            'second time — or ask for help before running again.'),
    );
    this.name = 'ManifestUnusableError';
  }
}

/**
 * Read an archive's list, or null when it has none: the one judgement of which lists are
 * unusable as a whole (unreadable, not JSON, no list of files, a format this build does not
 * know), each refused with ManifestUnusableError. Entries are sorted, not judged: whether an
 * unusable entry is a refusal is the caller's decision (see `Manifest.open` and maintenance).
 */
export async function readManifestFile(root: string): Promise<ManifestFile | null> {
  const file = join(root, MANIFEST_FILENAME);

  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    // Only "it is not there" is an ordinary first run. A permission error or a directory
    // in its place means a manifest may well exist and simply cannot be read.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
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

  const entries: unknown[] = data.files;
  const records: ManifestRecord[] = [];
  let firstUnusable: number | null = null;
  for (const [i, entry] of entries.entries()) {
    if (usableRecord(entry)) records.push(entry);
    else firstUnusable ??= i + 1;
  }
  return {
    data: data as unknown as Record<string, unknown>,
    records,
    entries,
    unusable: entries.length - records.length,
    firstUnusable,
  };
}

/**
 * The archive manifest: the tool's memory of what it has already saved.
 *
 * This is what makes a daily run cheap. Without it, every run would re-download
 * everything — and because CDN URLs are signed and change every time, naive URL
 * comparison cannot substitute for it.
 *
 * `has` looks a record up by two keys, in order of trustworthiness:
 *   1. sourceId   - the service's own media id. Authoritative when present.
 *   2. transferId - the URL with signature parameters stripped.
 *
 * `sha256` is not a key for finding duplicates. It is an integrity checksum of the file as
 * saved, taken after the tags are embedded, so it describes the bytes on disk rather than
 * the photo as the service holds it.
 */
export class Manifest {
  private bySourceId = new Map<string, ManifestRecord>();
  private byTransferId = new Map<string, ManifestRecord>();
  private byPath = new Map<string, ManifestRecord>();
  private records: ManifestRecord[] = [];
  /** Adapter-owned state, persisted with the records. See `ManifestData.state`. */
  readonly state: Record<string, unknown> = {};

  private constructor(
    private readonly root: string,
    private readonly source: string,
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
   *
   * A list that is whole but holds an entry `usableRecord` refuses is refused too, rather
   * than read without that entry (security review fs-8). Skipping it would be silent twice
   * over: the run saves the list whole every 25 photos, so the entry would be gone from the
   * file after the first save, and whatever post it stood for would be fetched again as a
   * `-2` copy. The refusal names the way out that loses nothing — checking the folder against
   * the list and fixing it, which sets those entries aside and lists again every file that is
   * on disk, from the `.json` saved beside it — and is a failure the daily run records.
   */
  static async open(root: string, source: string): Promise<Manifest> {
    const m = new Manifest(root, source);
    const found = await readManifestFile(root);
    if (!found) return m;
    if (found.unusable > 0) {
      const n = found.unusable;
      throw new ManifestUnusableError(
        join(root, MANIFEST_FILENAME),
        `${n === 1 ? 'one of its entries is' : `${n} of its entries are`} not in the form this tool writes ` +
          `(the first is entry ${found.firstUnusable} of ${found.entries.length})`,
        'Check the folder against the list and fix the list — on the setup page, under "Checking on the archive", or ' +
          'with `care-album-saver check --repair` — which sets those entries aside and lists again every photo that is ' +
          'on disk, without downloading anything. Then run again.',
      );
    }

    for (const r of found.records) m.index(r);
    const state = found.data.state;
    if (state && typeof state === 'object' && !Array.isArray(state)) {
      Object.assign(m.state, state);
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
    this.byPath.set(r.path, r);
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

  add(record: Omit<ManifestRecord, 'downloadedAt'>): ManifestRecord {
    const full: ManifestRecord = {
      ...record,
      path: posixPath(record.path),
      downloadedAt: new Date().toISOString(),
    };
    this.index(full);
    return full;
  }

  get size(): number {
    return this.records.length;
  }

  /**
   * Persist atomically: write a temp file then rename over the target. A half-written
   * manifest after a crash would make the tool forget files it actually has and
   * re-download them, so the rename (which is atomic on POSIX) matters.
   *
   * The mode is set on the temporary file before anything is written into it, so a file
   * describing people is never readable by every account on the machine, not even briefly.
   * The rename carries the mode across with it, which also means a manifest left at 0644 by
   * an older version is replaced rather than corrected in place. See writeAtomically for
   * why the temporary file's name is not `archive.json.tmp` any more.
   */
  async save(): Promise<void> {
    const data: ManifestData = {
      schema: MANIFEST_SCHEMA,
      source: this.source,
      updatedAt: new Date().toISOString(),
      notes:
        'downloadedAt is when this tool fetched the file. provenance.postedAt is when the ' +
        'photo was posted to Brightwheel; the photographs carry no capture time of their ' +
        'own, so that is also the date written into the file EXIF/XMP metadata. etag and ' +
        'lastModified are verbatim HTTP response headers; null means the server did not ' +
        'supply one. Local filesystem timestamps are never used as validators.',
      state: this.state,
      files: this.records,
    };
    await writeAtomically(join(this.root, MANIFEST_FILENAME), JSON.stringify(data, null, 2), MANIFEST_FILE_MODE);
  }
}

/** The forward-slash form of an archive-relative path, whichever separator it arrived with. */
function posixPath(path: string): string {
  return path.replaceAll('\\', '/');
}
