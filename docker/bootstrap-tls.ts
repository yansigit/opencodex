import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import {
  atomicWriteFile,
  getConfigDir,
  getConfigPath,
  withConfigMutationLockSync,
} from "../src/config";

export const CONTAINER_TLS_IDENTITY_DIR_NAME = "container-tls";
export const CONTAINER_TLS_CERT_NAME = "cert.pem";
export const CONTAINER_TLS_KEY_NAME = "key.pem";
export const CONTAINER_TLS_CERT_PATH = "/home/bun/.opencodex/container-tls/cert.pem";
export const CONTAINER_TLS_KEY_PATH = "/home/bun/.opencodex/container-tls/key.pem";

const STAGE_PREFIX = ".container-tls-stage-";
const MAX_TLS_FILE_BYTES = 128 * 1024;
const MAX_CONFIG_BYTES = 8 * 1024 * 1024;

export type OpenSslResult = Readonly<{ exitCode: number; stdout: string }>;
export type OpenSslRunner = (argv: string[]) => OpenSslResult;

const runOpenSsl: OpenSslRunner = argv => {
  const result = Bun.spawnSync(argv, { stdout: "pipe", stderr: "ignore" });
  return { exitCode: result.exitCode, stdout: result.stdout.toString("utf8") };
};

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function currentUid(): number | null {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function assertOwnedPrivateDirectory(path: string, label: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} is not a regular directory`);
  const uid = currentUid();
  if (uid !== null && stat.uid !== uid) throw new Error(`${label} is not owned by the current user`);
  if (process.platform !== "win32" && (stat.mode & 0o777) !== 0o700) throw new Error(`${label} is not owner-only`);
}

function ensureSecureStateDirectory(configDir: string): void {
  try {
    const stat = lstatSync(configDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("container state path is not a regular directory");
    const uid = currentUid();
    if (uid !== null && stat.uid !== uid) throw new Error("container state path is not owned by the current user");
    chmodSync(configDir, 0o700);
  } catch (error) {
    if (!isMissing(error)) throw error;
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
  }
  assertOwnedPrivateDirectory(configDir, "container state path");
}

function assertBoundedRegularFile(path: string, label: string): void {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (isMissing(error)) throw new Error(`container TLS ${label} is not a bounded regular file`);
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size === 0 || stat.size > MAX_TLS_FILE_BYTES) {
    throw new Error(`container TLS ${label} is not a bounded regular file`);
  }
  const uid = currentUid();
  if (uid !== null && stat.uid !== uid) throw new Error(`container TLS ${label} is not owned by the current user`);
}

function assertIdentityPermissions(identityDir: string, cert: string, key: string): void {
  assertOwnedPrivateDirectory(identityDir, "container TLS identity directory");
  assertBoundedRegularFile(cert, "certificate");
  assertBoundedRegularFile(key, "private key");
  if (process.platform !== "win32") {
    if ((lstatSync(key).mode & 0o077) !== 0) throw new Error("container TLS private key is not owner-only");
    if ((lstatSync(cert).mode & 0o022) !== 0) throw new Error("container TLS certificate is writable by another user");
  }
}

function requireOpenSsl(run: OpenSslRunner, argv: string[], purpose: string): string {
  const result = run(argv);
  if (result.exitCode !== 0) throw new Error(`OpenSSL could not ${purpose} (exit ${result.exitCode})`);
  return result.stdout;
}

function validateIdentity(identityDir: string, run: OpenSslRunner): void {
  const cert = join(identityDir, CONTAINER_TLS_CERT_NAME);
  const key = join(identityDir, CONTAINER_TLS_KEY_NAME);
  assertIdentityPermissions(identityDir, cert, key);
  requireOpenSsl(run, ["/usr/bin/openssl", "x509", "-checkend", "0", "-noout", "-in", cert], "validate the container TLS certificate");
  const certPublicKey = requireOpenSsl(run, ["/usr/bin/openssl", "x509", "-pubkey", "-noout", "-in", cert], "read the container TLS certificate public key").trim();
  const privateKeyPublicKey = requireOpenSsl(run, ["/usr/bin/openssl", "pkey", "-pubout", "-in", key], "read the container TLS private-key public key").trim();
  if (!certPublicKey || certPublicKey !== privateKeyPublicKey) {
    throw new Error("container TLS certificate and private key do not match");
  }
}

function syncPath(path: string): void {
  // Windows rejects fsync on a read-only handle; owner-writable generated files use r+.
  const fd = openSync(path, "r+");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function removeAbandonedStages(configDir: string): void {
  for (const entry of readdirSync(configDir, { withFileTypes: true })) {
    if (!entry.name.startsWith(STAGE_PREFIX)) continue;
    const path = join(configDir, entry.name);
    assertOwnedPrivateDirectory(path, "abandoned container TLS staging directory");
    rmSync(path, { recursive: true });
  }
}

/** Create or validate one crash-atomic per-volume identity. Caller serializes this operation. */
export function ensureContainerTls(
  configDir = getConfigDir(),
  run: OpenSslRunner = runOpenSsl,
): "created" | "present" {
  ensureSecureStateDirectory(configDir);
  removeAbandonedStages(configDir);
  const identityDir = join(configDir, CONTAINER_TLS_IDENTITY_DIR_NAME);
  let identityAbsent = false;
  try {
    lstatSync(identityDir);
  } catch (error) {
    if (isMissing(error)) identityAbsent = true;
    else throw error;
  }
  if (!identityAbsent) {
    validateIdentity(identityDir, run);
    return "present";
  }

  const stage = mkdtempSync(join(configDir, STAGE_PREFIX));
  chmodSync(stage, 0o700);
  assertOwnedPrivateDirectory(stage, "container TLS staging directory");
  const cert = join(stage, CONTAINER_TLS_CERT_NAME);
  const key = join(stage, CONTAINER_TLS_KEY_NAME);
  try {
    requireOpenSsl(run, [
      "/usr/bin/openssl", "req", "-x509", "-newkey", "rsa:3072", "-sha256",
      "-days", "825", "-nodes", "-subj", "/CN=localhost",
      "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-keyout", key, "-out", cert,
    ], "generate the container TLS identity");
    chmodSync(cert, 0o644);
    chmodSync(key, 0o600);
    validateIdentity(stage, run);
    syncPath(cert);
    syncPath(key);
    if (process.platform !== "win32") syncDirectory(stage);
    renameSync(stage, identityDir);
    if (process.platform !== "win32") syncDirectory(configDir);
    return "created";
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}

function configuredPublicOrigin(env: NodeJS.ProcessEnv): { origin: string; explicit: boolean } {
  const explicit = env["OCX_CONTAINER_PUBLIC_ORIGIN"]?.trim();
  if (explicit) {
    const parsed = new URL(explicit);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password
      || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      throw new Error("OCX_CONTAINER_PUBLIC_ORIGIN must be an HTTPS origin without path, credentials, query, or fragment");
    }
    return { origin: parsed.origin, explicit: true };
  }
  const rawPort = env["OCX_CONTAINER_PUBLIC_PORT"]?.trim() || "10100";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || String(port) !== rawPort) {
    throw new Error("OCX_CONTAINER_PUBLIC_PORT must be an integer from 1 to 65535");
  }
  return { origin: new URL(`https://localhost:${port}`).origin, explicit: false };
}

function isManagedLocalOrigin(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.hostname === "localhost"
      && parsed.username === "" && parsed.password === "" && parsed.pathname === "/"
      && parsed.search === "" && parsed.hash === "" && parsed.origin === value;
  } catch {
    return false;
  }
}

function readConfigObject(configPath: string): Record<string, unknown> {
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  const fd = openSync(configPath, flags);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_CONFIG_BYTES) throw new Error("container config is not a bounded regular file");
    const parsed: unknown = JSON.parse(readFileSync(fd, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("container config must contain a JSON object");
    return parsed as Record<string, unknown>;
  } finally {
    closeSync(fd);
  }
}

type ContainerTlsBootstrapState = "created" | "present" | "custom";

/** Migrate retained non-TLS config and initialize the managed identity under one process lock. */
export function bootstrapContainerTls(
  configDir = getConfigDir(),
  configPath = getConfigPath(),
  env: NodeJS.ProcessEnv = process.env,
  run: OpenSslRunner = runOpenSsl,
): ContainerTlsBootstrapState {
  ensureSecureStateDirectory(configDir);
  return withConfigMutationLockSync(() => {
    const config = readConfigObject(configPath);
    const tls = config["tls"];
    if (tls !== undefined) {
      if (!tls || typeof tls !== "object" || Array.isArray(tls)) throw new Error("container config contains an invalid TLS setting");
      const current = tls as Record<string, unknown>;
      const managed = current["certFile"] === CONTAINER_TLS_CERT_PATH && current["keyFile"] === CONTAINER_TLS_KEY_PATH;
      if (!managed) return "custom";
    }

    const identity = ensureContainerTls(configDir, run);
    const configured = configuredPublicOrigin(env);
    const currentTls = tls as Record<string, unknown> | undefined;
    const publicOrigin = !configured.explicit && currentTls && !isManagedLocalOrigin(currentTls["publicOrigin"])
      ? currentTls["publicOrigin"]
      : configured.origin;
    if (typeof publicOrigin !== "string" || !publicOrigin) {
      throw new Error("managed container TLS configuration has no valid public origin");
    }
    const nextTls = {
      certFile: CONTAINER_TLS_CERT_PATH,
      keyFile: CONTAINER_TLS_KEY_PATH,
      publicOrigin,
    };
    if (JSON.stringify(tls) !== JSON.stringify(nextTls)) {
      atomicWriteFile(configPath, `${JSON.stringify({ ...config, tls: nextTls }, null, 2)}\n`);
    }
    return identity;
  });
}

if (import.meta.main) {
  try {
    const state = bootstrapContainerTls();
    console.log(state === "created"
      ? "Initialized the per-volume container TLS identity and configuration."
      : state === "custom"
        ? "Preserved the operator-managed container TLS configuration."
        : "Validated the existing per-volume container TLS identity and configuration.");
  } catch (error) {
    console.error(`TLS initialization failed: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  }
}
