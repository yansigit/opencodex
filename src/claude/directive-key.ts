import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigMutationLockError, withConfigMutationLockSync } from "../config";
import { atomicWriteFile } from "../config/atomic-write";
import { getConfigDir } from "../config/paths";
import { tokenCollidesWithAdmin } from "../lib/admin-secrets";

export const DIRECTIVE_KEY_FILE = "claude-agent-directive-key";
const KEY_LOCK_WAIT_MS = 5_000;
const KEY_LOCK_POLL_MS = 10;
const keyLockWaitCell = new Int32Array(new SharedArrayBuffer(4));

export function getDirectiveKeyPath(configDir = getConfigDir()): string {
  return join(configDir, DIRECTIVE_KEY_FILE);
}

function validateKeyFormat(key: string, path: string): string {
  const trimmed = key.trim();
  if (!/^[0-9a-f]{64}$/i.test(trimmed)) {
    throw new Error(`invalid directive signing key format in ${path}: must be 64 hex characters`);
  }
  return trimmed.toLowerCase();
}

function withDirectiveKeyMutationLock<T>(work: () => T): T {
  const deadline = Date.now() + KEY_LOCK_WAIT_MS;
  for (;;) {
    try {
      return withConfigMutationLockSync(work);
    } catch (error) {
      const cause = error && typeof error === "object" && "cause" in error
        ? (error as { cause?: unknown }).cause
        : error;
      const code = cause && typeof cause === "object" && "code" in cause
        ? String((cause as { code?: unknown }).code)
        : "";
      const message = cause instanceof Error
        ? cause.message
        : error instanceof Error ? error.message : "";
      const lockBusy = error instanceof ConfigMutationLockError
        || code === "SQLITE_BUSY"
        || code === "SQLITE_LOCKED"
        || /database (?:is|table is) locked/i.test(message);
      if (!lockBusy || Date.now() >= deadline) throw error;
      Atomics.wait(keyLockWaitCell, 0, 0, Math.min(KEY_LOCK_POLL_MS, deadline - Date.now()));
    }
  }
}

function readExistingDirectiveKey(keyPath: string, configDir: string): string {
  const stat = lstatSync(keyPath);
  if (stat.isSymbolicLink()) {
    throw new Error(`refusing to follow symlinked directive key file: ${keyPath}`);
  }
  if (!stat.isFile()) {
    throw new Error(`directive key path is not a regular file: ${keyPath}`);
  }
  if (process.platform !== "win32" && (stat.mode & 0o777) !== 0o600) {
    try {
      chmodSync(keyPath, 0o600);
    } catch {
      // Re-read below; filesystems that cannot enforce the mode still fail closed.
    }
    if ((lstatSync(keyPath).mode & 0o777) !== 0o600) {
      throw new Error(`directive key file permissions are not owner-only (0600): ${keyPath}`);
    }
  }
  const key = validateKeyFormat(readFileSync(keyPath, "utf8"), keyPath);
  if (tokenCollidesWithAdmin(key, process.env, configDir)) {
    throw new Error(`directive signing key collides with admin token in ${keyPath}`);
  }
  return key;
}

function createDirectiveSigningKeyUnderLock(configDir: string, keyPath: string): string {
  try {
    return readExistingDirectiveKey(keyPath, configDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  mkdirSync(configDir, { recursive: true });
  let candidate: string;
  do {
    candidate = randomBytes(32).toString("hex").toLowerCase();
  } while (tokenCollidesWithAdmin(candidate, process.env, configDir));
  atomicWriteFile(keyPath, candidate + "\n");
  return readExistingDirectiveKey(keyPath, configDir);
}

/**
 * Return the owner-only HMAC-SHA256 signing key used for Claude Code agent directives.
 *
 * If absent, generates 32 cryptographically secure random bytes and writes them
 * atomically with owner-only (0600) permissions under OPENCODEX_HOME.
 *
 * Cross-process rotation observation: does not memoize in a process-lifetime cache,
 * ensuring verification immediately observes external on-disk rotations.
 *
 * Concurrent creation safety: re-reads the authoritative on-disk file after atomic
 * writing so all concurrent creators converge on the single disk winner.
 */
export function getOrCreateDirectiveSigningKey(configDir = getConfigDir()): string {
  const keyPath = getDirectiveKeyPath(configDir);
  try {
    return readExistingDirectiveKey(keyPath, configDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  return withDirectiveKeyMutationLock(() => createDirectiveSigningKeyUnderLock(configDir, keyPath));
}

/**
 * Atomically rotate the directive signing key with owner-only 0600 permissions.
 */
export function rotateDirectiveSigningKey(configDir = getConfigDir()): { oldKey: string; newKey: string } {
  return withDirectiveKeyMutationLock(() => {
    const keyPath = getDirectiveKeyPath(configDir);
    const oldKey = createDirectiveSigningKeyUnderLock(configDir, keyPath);
    mkdirSync(configDir, { recursive: true });

    let newKey: string;
    do {
      newKey = randomBytes(32).toString("hex").toLowerCase();
    } while (newKey === oldKey || tokenCollidesWithAdmin(newKey, process.env, configDir));

    atomicWriteFile(keyPath, newKey + "\n");
    return { oldKey, newKey: readExistingDirectiveKey(keyPath, configDir) };
  });
}
