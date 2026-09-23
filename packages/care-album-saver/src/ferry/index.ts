/**
 * media-ferry — resumable downloads, stable remote identity, content-addressed
 * deduplication, safe filenames and ISO-week foldering.
 *
 * Zero runtime dependencies: everything here is Node standard library.
 *
 * The algorithms descend from Archive Ferry (a private Python project). They are
 * re-implemented here rather than bound, because a TypeScript package cannot be imported
 * by a Python worker. Keeping the two from drifting is an open intention, not a fact:
 * there is no shared fixture yet (see docs/QUESTIONS-FOR-FABLE.md, C2).
 */

export { hashFile, hashBytes } from './hash.js';
export { transferIdentity, sameRemoteFile, signedUrlExpiry } from './url.js';
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
  ManifestUnusableError,
  MANIFEST_SCHEMA,
  MANIFEST_FILENAME,
  MANIFEST_FILE_MODE,
  type ManifestData,
  type ManifestOptions,
  type ManifestRecord,
} from './manifest.js';
