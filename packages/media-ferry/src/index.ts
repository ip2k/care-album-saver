/**
 * media-ferry — resumable downloads, stable remote identity, content-addressed
 * deduplication, safe filenames and ISO-week foldering.
 *
 * Zero runtime dependencies: everything here is Node standard library.
 *
 * The algorithms descend from Archive Ferry (a private Python project). They are
 * re-implemented here rather than bound, because a TypeScript package cannot be imported
 * by a Python worker. Behaviour is pinned by the shared test vectors in
 * `test/vectors.json`, which both implementations can run against.
 */

export { hashFile, hashBytes } from './hash.js';
export { transferIdentity, sameRemoteFile } from './url.js';
export { safeStem, safeExtension, uniqueName, type SafeNameOptions } from './names.js';
export {
  isoWeek,
  weekFolder,
  weekStart,
  weekEnd,
  weekLabel,
  exifDateTime,
  exifOffset,
  type IsoWeek,
} from './weeks.js';
export {
  download,
  DownloadError,
  redactUrl,
  type DownloadOptions,
  type DownloadResult,
  type RemoteValidators,
} from './download.js';
export {
  Manifest,
  MANIFEST_SCHEMA,
  MANIFEST_FILENAME,
  type ManifestData,
  type ManifestRecord,
} from './manifest.js';
