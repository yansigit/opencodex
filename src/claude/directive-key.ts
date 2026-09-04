import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "../config/atomic-write";
import { getConfigDir } from "../config/paths";
import { tokenCollidesWithAdmin } from "../lib/admin-secrets";

export const DIRECTIVE_KEY_FILE = "claude-agent-directive-key";

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
        // best-effort chmod before verifying
      }
      const refreshed = lstatSync(keyPath);
      if ((refreshed.mode & 0o777) !== 0o600) {
        throw new Error(`directive key file permissions are not owner-only (0600): ${keyPath}`);
      }
    }
    const existing = readFileSync(keyPath, "utf8");
    const key = validateKeyFormat(existing, keyPath);
    if (tokenCollidesWithAdmin(key, process.env, configDir)) {
      throw new Error(`directive signing key collides with admin token in ${keyPath}`);
    }
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  mkdirSync(configDir, { recursive: true });
  let candidate: string;
  do {
    candidate = randomBytes(32).toString("hex").toLowerCase();
  } while (tokenCollidesWithAdmin(candidate, process.env, configDir));

  atomicWriteFile(keyPath, candidate + "\n");

  // Deterministic convergence: re-read authoritative on-disk key
  const onDisk = readFileSync(keyPath, "utf8");
  return validateKeyFormat(onDisk, keyPath);
}

/**
 * Atomically rotate the directive signing key with owner-only 0600 permissions.
 */
export function rotateDirectiveSigningKey(configDir = getConfigDir()): { oldKey: string; newKey: string } {
  const oldKey = getOrCreateDirectiveSigningKey(configDir);
  const keyPath = getDirectiveKeyPath(configDir);
  mkdirSync(configDir, { recursive: true });

  let newKey: string;
  do {
    newKey = randomBytes(32).toString("hex").toLowerCase();
  } while (newKey === oldKey || tokenCollidesWithAdmin(newKey, process.env, configDir));

  atomicWriteFile(keyPath, newKey + "\n");
  const finalKey = validateKeyFormat(readFileSync(keyPath, "utf8"), keyPath);
  return { oldKey, newKey: finalKey };
}
