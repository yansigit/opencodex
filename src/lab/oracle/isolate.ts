import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { ensureRestrictedDir, ensureLabDirs, labRoot, labScratchDir } from "../paths";
import { CURSOR_ORACLE_OBSERVATION_SUBDIR, CURSOR_ORACLE_RAW_TTL_MS, CURSOR_ORACLE_SCRATCH_SUBDIR } from "./constants";

export interface IsolatedOracleEnv {
  root: string;
  configDir: string;
  dataDir: string;
  workspaceDir: string;
  homeDir: string;
  cleanup: () => void;
}

function randomSuffix(): string {
  return `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

/**
 * Create isolated config/data/workspace sandboxed under OS tmp.
 * All dirs are 0700. Caller must call cleanup().
 * Never writes to real HOME or real OPENCODEX_HOME.
 */
export function createIsolatedOracleEnv(opts: { configDir?: string } = {}): IsolatedOracleEnv {
  const sysTmp = tmpdir();
  const base = mkdtempSync(join(sysTmp, "ocx-cursor-oracle-"));
  if (process.platform !== "win32") chmodSync(base, 0o700);

  const configDir = join(base, "config");
  const dataDir = join(base, "data");
  const workspaceDir = join(base, "workspace");
  const homeDir = join(base, "home");
  for (const d of [configDir, dataDir, workspaceDir, homeDir]) {
    mkdirSync(d, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(d, 0o700);
  }
  try {
    ensureLabDirs(opts.configDir);
  } catch { /* best-effort */ }

  const cleanup = () => {
    try { rmSync(base, { recursive: true, force: true, maxRetries: 3 }); } catch {}
  };
  return { root: base, configDir, dataDir, workspaceDir, homeDir, cleanup };
}

/** Resolve lab scratch raw dir for opt-in raw capture. Ensures 0700. */
export function ensureOracleRawDir(configDir?: string): string {
  const labBoundary = labRoot(configDir);
  const base = labScratchDir(configDir);
  ensureRestrictedDir(base, labBoundary);
  const dir = join(base, CURSOR_ORACLE_SCRATCH_SUBDIR);
  ensureRestrictedDir(dir, labBoundary);
  return dir;
}

function ensureOracleObservationDir(configDir?: string): string {
  const boundary = labRoot(configDir);
  const dir = join(labScratchDir(configDir), CURSOR_ORACLE_OBSERVATION_SUBDIR);
  ensureRestrictedDir(dir, boundary);
  return dir;
}

function observationPath(runId: string, configDir?: string): string {
  if (!/^cursor-[a-z0-9-]{8,80}$/.test(runId)) throw new Error("invalid cursor oracle run id");
  return join(ensureOracleObservationDir(configDir), `${runId}.json`);
}

/** Immutable, sanitized oracle evidence sidecar. Raw frames are never written here. */
export function writeOracleObservation(runId: string, json: string, configDir?: string): void {
  const path = observationPath(runId, configDir);
  writeFileSync(path, json, { encoding: "utf8", flag: "wx", mode: 0o600 });
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

export function readOracleObservation(runId: string, configDir?: string): string {
  const path = observationPath(runId, configDir);
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 1024 * 1024) throw new Error("invalid cursor oracle observation file");
  return readFileSync(path, "utf8");
}

/** Write raw bytes to scratch with 0600, return path. */
export function writeRawScratch(opts: {
  configDir?: string;
  prefix: string;
  bytes: Uint8Array;
  suffix?: string;
}): string {
  const dir = ensureOracleRawDir(opts.configDir);
  const name = `${opts.prefix}-${randomSuffix()}${opts.suffix ?? ".bin"}`;
  const path = join(dir, name);
  writeFileSync(path, opts.bytes, { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(path, 0o600);
  return path;
}

/** Purge raw files older than TTL. Best-effort. Returns number removed. */
export function purgeExpiredRaw(configDir?: string, now = Date.now()): number {
  let dir: string;
  try { dir = ensureOracleRawDir(configDir); } catch { return 0; }
  if (!existsSync(dir)) return 0;
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return 0; }
  let removed = 0;
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try { st = lstatSync(full); } catch { continue; }
    if (!st.isFile() || st.isSymbolicLink()) continue;
    const age = now - st.mtimeMs;
    if (age > CURSOR_ORACLE_RAW_TTL_MS) {
      try { unlinkSync(full); removed++; } catch {}
    }
  }
  return removed;
}

/** Hardened check that a path is under an expected isolated root. */
export function assertUnderRoot(root: string, target: string): void {
  const absRoot = resolve(root);
  const absTarget = resolve(target);
  if (absTarget !== absRoot && !absTarget.startsWith(absRoot + "/") && !absTarget.startsWith(absRoot + "\\")) {
    throw new Error("oracle path escapes isolation root");
  }
}
