import { randomBytes } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Owner read/write only. Ignored by Windows, where the user profile ACL already applies. */
export const PRIVATE_FILE_MODE = 0o600;
export const PRIVATE_DIR_MODE = 0o700;

export async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
}

/**
 * Writes a file atomically (temp file + rename) so a crash can never leave a
 * half-written config or credential store behind.
 */
export async function writeFileAtomic(
  file: string,
  data: string,
  mode = PRIVATE_FILE_MODE,
): Promise<void> {
  await ensurePrivateDir(path.dirname(file));
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, data, { mode });
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

export async function readJsonFile<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

export async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
