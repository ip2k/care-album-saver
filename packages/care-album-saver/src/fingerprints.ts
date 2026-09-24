import { readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Config } from './config.js';
import { hashFile, MANIFEST_FILENAME, type ManifestRecord } from './ferry/index.js';
import { containedFile } from './contain.js';
import { configDir, readJsonFile, UnreadableFileError, writeSecureFile } from './paths.js';

/**
 * The SHA-256 of every file this tool saved, kept where nothing but this tool writes.
 *
 * Adding to Photos hands files to Apple, and with iCloud Photos on, to iCloud, so it hands
 * over only files this tool saved (security review processes-5). The first check of that
 * compared each file with the SHA-256 in archive.json — which sits in the photos folder, and
 * anything that can replace a photo there can rewrite its line in the list to match. So the
 * reference lives here instead, in the config folder, which is this account's alone and never
 * synced: sync notes each file's hash as it puts the file in place, and the Photos step hands
 * over only bytes whose hash is here.
 *
 * WHAT WAS SAVED BEFORE THIS EXISTED is taken as it is on disk, once per archive folder: the
 * first time a run (or the Photos step) meets a folder the record has not covered, every file
 * the list names is hashed as it is now and written down (`savedFingerprints`). The list's own hashes cannot serve, because until 2026-09-22
 * sync hashed each file before writing the tags into it, so every photo saved then carries a
 * hash of bytes that no longer exist; checked against those, a parent's whole archive read as
 * tampered with. Trusting the folder at that one moment is the price of not failing every
 * archive that predates the record, and it is paid once, at the first run after upgrading. A
 * folder this tool starts from empty needs no trust at all: its baseline is empty, and every
 * file in it is noted as it is saved.
 */

interface Stored {
  /** The archive folders (real paths) whose earlier contents a baseline has covered. */
  baselined?: unknown;
  sha256?: unknown;
}

const HEX = /^[0-9a-f]{64}$/;

const fingerprintsPath = (): string => join(configDir(), 'fingerprints.json');

/**
 * The record could not be read. The Photos step stops on this rather than taking it for
 * empty, which would leave out every photo, or for a fresh start, which would baseline
 * whatever the folder holds now.
 */
export class FingerprintsUnusableError extends Error {
  constructor(error: UnreadableFileError) {
    super(
      `The record of which photos this tool saved (${error.path}) cannot be read: ${error.reason}. ` +
        'Nothing was added to Photos. Moving that file somewhere safe makes a new record from the photos in your folder as they are now.',
    );
    this.name = 'FingerprintsUnusableError';
  }
}

interface Record_ {
  hashes: Set<string>;
  baselined: Set<string>;
}

async function read(): Promise<Record_> {
  let stored: Stored | null;
  try {
    stored = await readJsonFile<Stored>(fingerprintsPath());
  } catch (error) {
    if (error instanceof UnreadableFileError) throw new FingerprintsUnusableError(error);
    throw error;
  }
  const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);
  return {
    hashes: new Set(strings(stored?.sha256).filter((h) => HEX.test(h))),
    baselined: new Set(strings(stored?.baselined)),
  };
}

async function write(record: Record_): Promise<void> {
  await writeSecureFile(fingerprintsPath(), JSON.stringify({ baselined: [...record.baselined].sort(), sha256: [...record.hashes].sort() }));
}

/**
 * Note files sync has just put in place. Merged with what is on disk at the moment of writing,
 * so a baseline being written at the same time loses nothing of its own, nor this.
 */
export async function rememberSaved(sha256: Iterable<string>): Promise<void> {
  const fresh = [...sha256].map((h) => h.toLowerCase()).filter((h) => HEX.test(h));
  if (fresh.length === 0) return;
  const record = await read();
  const before = record.hashes.size;
  for (const h of fresh) record.hashes.add(h);
  if (record.hashes.size !== before) await write(record);
}

/** The list's entries, read as found: anything this does not understand names no file. */
async function listed(archiveDir: string): Promise<ManifestRecord[]> {
  try {
    const data = JSON.parse(await readFile(join(archiveDir, MANIFEST_FILENAME), 'utf8')) as { files?: unknown };
    return Array.isArray(data.files) ? (data.files as ManifestRecord[]) : [];
  } catch {
    return [];
  }
}

/**
 * What this tool saved: the record, with the baseline taken first if this archive folder has
 * none yet (see the top of this file). Sync calls this at the start of every run, so for any
 * folder it has run against since this record began, the baseline was taken before anything
 * could be changed and holds nothing at all for a folder it started. The Photos step calls it
 * too, for the one case where it runs before sync has: straight after an upgrade.
 * `onBaseline` is told when the one-off hashing is about to start, as it can take a while.
 */
export async function savedFingerprints(config: Config, onBaseline?: () => void): Promise<ReadonlySet<string>> {
  const record = await read();
  const root = await realpath(resolve(config.archiveDir)).catch(() => null);
  if (!root || record.baselined.has(root)) return record.hashes;
  const files = await listed(root);
  if (files.length > 0) onBaseline?.();
  for (const entry of files) {
    if (typeof entry?.path !== 'string') continue;
    const file = await containedFile(root, entry.path);
    if (!file) continue;
    const hash = await hashFile(file).catch(() => null);
    if (hash) record.hashes.add(hash);
  }
  // Merged with anything sync noted while this was hashing, then written as covering this folder.
  const now = await read();
  for (const h of now.hashes) record.hashes.add(h);
  for (const b of now.baselined) record.baselined.add(b);
  record.baselined.add(root);
  await write(record);
  return record.hashes;
}
