export { BrightwheelClient, DEFAULT_BASE_URL, SESSION_COOKIE } from './api/client.js';
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
export { configDir, configPath, sessionPath, defaultArchiveDir, writeSecureFile } from './paths.js';
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
