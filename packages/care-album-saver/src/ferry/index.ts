/**
 * src/ferry — the part of this tool that neither talks to Brightwheel nor knows its API:
 * signed-URL identity, downloading to a `.part` file and renaming it into place only when
 * complete, SHA-256 integrity checksums, safe filenames, ISO-week folders and the archive
 * manifest.
 *
 * Zero runtime dependencies: everything here is Node standard library.
 *
 * Several of the algorithms descend from Archive Ferry (a private Python project), and say
 * so where they do. That is provenance only: they are re-implemented here, not bound, and no
 * behavioural pinning between the two is intended (docs/DECISIONS.md, C2).
 */

export { hashFile } from './hash.js';
export { writeAtomically } from './atomic.js';
export { transferIdentity, sameRemoteFile, signedUrlExpiry } from './url.js';
export { safeStem, safeExtension, uniqueName } from './names.js';
export {
  isoWeek,
  weekFolder,
  weekLabel,
  exifDateTime,
  exifOffset,
  type IsoWeek,
} from './weeks.js';
export {
  download,
  DownloadError,
  type DownloadOptions,
  type DownloadResult,
  type RemoteValidators,
} from './download.js';
export {
  Manifest,
  ManifestUnusableError,
  MANIFEST_FILENAME,
  type ManifestRecord,
} from './manifest.js';
