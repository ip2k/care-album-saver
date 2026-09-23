export { BrightwheelClient, DEFAULT_BASE_URL, SESSION_COOKIE, PAGES_PAST_THE_CUT_OFF, type ActivityPage } from './api/client.js';
export {
  ApiShapeError,
  SessionExpiredError,
  parseActivities,
  parseMe,
  parseStudents,
  validateExtraction,
  type MediaActivity,
  type Student,
} from './api/schema.js';
export { Secret, scrub, scrubDeep } from './secrets.js';
export { configDir, legacyConfigDir, configPath, sessionPath, defaultArchiveDir, writeSecureFile } from './paths.js';
export {
  DEFAULT_CONFIG,
  loadConfig,
  saveConfig,
  loadSession,
  saveSession,
  normaliseCookieInput,
  type Config,
} from './config.js';
export { sync, type SyncProgress, type SyncResult } from './sync.js';
export { applyMetadata, buildTags, writeJsonSidecar } from './metadata.js';
export { startWebUi, type WebUiHandle } from './web/server.js';
export { startMockBrightwheel, type MockServer } from './mock/server.js';
export { verify, formatReport, type VerifyReport } from './verify.js';
export { checkArchiveDir, ARCHIVE_DIR_MODE, type PathVerdict } from './safety.js';
export { inspectCookiePaste, cleanPastedPath, PASTE_CLIENT_SOURCE } from './paste.js';
export {
  addToPhotos,
  albumPathFor,
  checkPhotosAccess,
  photosStatus,
  photosSupported,
  PHOTOS_FOLDER,
  PHOTOS_SCRIPT,
  PHOTOS_SCRIPT_URL,
  type PhotosResult,
  type PhotosStatus,
} from './photos.js';
