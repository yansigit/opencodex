import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { ConfigMutationLockError, getConfigDir, withConfigMutationLockSync } from "../config";

export const RESPONSE_CONTINUATION_KEYRING_SERVICE = "opencodex.response-continuation.v1";
export const RESPONSE_CONTINUATION_CIPHER = "aes-256-gcm";
export const RESPONSE_CONTINUATION_KEY_BYTES = 32;
export const RESPONSE_CONTINUATION_NONCE_BYTES = 12;
export const RESPONSE_CONTINUATION_TAG_BYTES = 16;
export const RESPONSE_CONTINUATION_AAD_VERSION = "opencodex.response-continuation.v1";
export const MAX_RESPONSE_CONTINUATION_CIPHERTEXT_BYTES = 256 * 1024 * 1024;
export const KEYRING_READ_TIMEOUT_MS = 5_000;

export interface ResponseContinuationEncryptedEnvelope {
  version: 1;
  cipher: "aes-256-gcm";
  keyId: string;
  nonce: string;
  tag: string;
  ciphertext: string;
}

export interface ResponseContinuationAsyncKeyringEntry {
  getSecret(signal?: AbortSignal): Promise<Uint8Array | null | undefined>;
  setSecret(secret: Uint8Array, signal?: AbortSignal): Promise<void>;
}

export interface ResponseContinuationSyncKeyringEntry {
  getSecret(): number[] | Uint8Array | null;
  setSecret(secret: Uint8Array): void;
}

const nodeRequire = createRequire(import.meta.url);

function defaultAsyncEntry(service: string, account: string): ResponseContinuationAsyncKeyringEntry {
  const { AsyncEntry } = nodeRequire("@napi-rs/keyring") as {
    AsyncEntry: new (s: string, a: string) => ResponseContinuationAsyncKeyringEntry;
  };
  return new AsyncEntry(service, account);
}

function defaultSyncEntry(service: string, account: string): ResponseContinuationSyncKeyringEntry {
  const { Entry } = nodeRequire("@napi-rs/keyring") as {
    Entry: new (s: string, a: string) => ResponseContinuationSyncKeyringEntry;
  };
  return new Entry(service, account);
}

let asyncEntryFactory: (service: string, account: string) => ResponseContinuationAsyncKeyringEntry = defaultAsyncEntry;
let syncEntryFactory: (service: string, account: string) => ResponseContinuationSyncKeyringEntry = defaultSyncEntry;

const cachedKeysByHomeId = new Map<string, Buffer>();
const KEYRING_RETRY_AFTER_MS = 30_000;
const keyUnavailableUntilByHomeId = new Map<string, number>();
const keyFlightsByHomeId = new Map<string, Promise<Buffer | null>>();
let keyLifecycleGeneration = 0;
const keyGenerationByHomeId = new Map<string, number>();

interface KeyLifecycleToken {
  global: number;
  home: number;
}

function captureKeyLifecycleToken(homeId: string): KeyLifecycleToken {
  return {
    global: keyLifecycleGeneration,
    home: keyGenerationByHomeId.get(homeId) ?? 0,
  };
}

function isCurrentKeyLifecycleToken(homeId: string, token: KeyLifecycleToken): boolean {
  return token.global === keyLifecycleGeneration
    && token.home === (keyGenerationByHomeId.get(homeId) ?? 0);
}

function keyringTemporarilyUnavailable(homeId: string): boolean {
  const until = keyUnavailableUntilByHomeId.get(homeId);
  if (until === undefined) return false;
  if (Date.now() < until) return true;
  keyUnavailableUntilByHomeId.delete(homeId);
  return false;
}

function noteKeyringUnavailable(homeId: string): void {
  keyUnavailableUntilByHomeId.set(homeId, Date.now() + KEYRING_RETRY_AFTER_MS);
}

export function canonicalConfigDir(dir = getConfigDir()): string {
  try {
    return realpathSync(dir);
  } catch {
    return resolve(dir);
  }
}

export function responseContinuationHomeId(dir = getConfigDir()): string {
  const canonical = canonicalConfigDir(dir);
  return createHash("sha256")
    .update("opencodex.response-continuation.v1:home:")
    .update(canonical)
    .digest("hex");
}

export function responseContinuationKeyringAccount(dir = getConfigDir()): string {
  const canonical = canonicalConfigDir(dir);
  return createHash("sha256")
    .update("opencodex.response-continuation.v1:account:")
    .update(canonical)
    .digest("hex");
}

export type KeyringTestFactorySeam =
  | {
      async?: (service: string, account: string) => ResponseContinuationAsyncKeyringEntry;
      sync?: (service: string, account: string) => ResponseContinuationSyncKeyringEntry;
      getSecret?: (account: string) => Uint8Array | null;
      setSecret?: (account: string, secret: Uint8Array) => void;
    }
  | null;

export function setResponseContinuationKeyringFactoryForTests(factory: KeyringTestFactorySeam): void {
  if (!factory) {
    asyncEntryFactory = defaultAsyncEntry;
    syncEntryFactory = defaultSyncEntry;
  } else if ("getSecret" in factory || "setSecret" in factory) {
    const memory = new Map<string, Uint8Array>();
    asyncEntryFactory = (_s, a) => ({
      async getSecret(_signal?: AbortSignal) {
        if (factory.getSecret) {
          const value = factory.getSecret(a);
          return value ? new Uint8Array(value) : null;
        }
        const val = memory.get(a);
        return val ? Uint8Array.from(val) : null;
      },
      async setSecret(secret, _signal?: AbortSignal) {
        if (factory.setSecret) factory.setSecret(a, Uint8Array.from(secret));
        else memory.set(a, Uint8Array.from(secret));
      },
    });
    syncEntryFactory = (_s, a) => ({
      getSecret() {
        if (factory.getSecret) {
          const value = factory.getSecret(a);
          return value ? new Uint8Array(value) : null;
        }
        const val = memory.get(a);
        return val ? Uint8Array.from(val) : null;
      },
      setSecret(secret) {
        if (factory.setSecret) factory.setSecret(a, Uint8Array.from(secret));
        else memory.set(a, Uint8Array.from(secret));
      },
    });
  } else {
    if (factory.async) asyncEntryFactory = factory.async;
    if (factory.sync) syncEntryFactory = factory.sync;
  }
  releaseResponseContinuationKey();
  keyUnavailableUntilByHomeId.clear();
}

export function releaseResponseContinuationKey(homeId?: string): void {
  if (homeId !== undefined) {
    keyGenerationByHomeId.set(homeId, (keyGenerationByHomeId.get(homeId) ?? 0) + 1);
    const key = cachedKeysByHomeId.get(homeId);
    if (key) {
      try { key.fill(0); } catch { /* best-effort */ }
      cachedKeysByHomeId.delete(homeId);
    }
    keyFlightsByHomeId.delete(homeId);
  } else {
    keyLifecycleGeneration += 1;
    keyGenerationByHomeId.clear();
    for (const key of cachedKeysByHomeId.values()) {
      try { key.fill(0); } catch { /* best-effort */ }
    }
    cachedKeysByHomeId.clear();
    keyFlightsByHomeId.clear();
  }
}

export function resetResponseContinuationKeyForTests(): void {
  releaseResponseContinuationKey();
  keyUnavailableUntilByHomeId.clear();
  asyncEntryFactory = defaultAsyncEntry;
  syncEntryFactory = defaultSyncEntry;
}

type KeySecret = number[] | Uint8Array | null | undefined;

function secretByteLength(secret: KeySecret): number {
  return Array.isArray(secret) ? secret.length : secret?.byteLength ?? 0;
}

function wipeBuffer(buf: KeySecret): void {
  if (!buf) return;
  try { buf.fill(0); } catch { /* best-effort */ }
}

/** Zero a caller-owned continuation-key copy once its cryptographic operation completes. */
export function wipeResponseContinuationKeyCopy(key: Uint8Array | null | undefined): void {
  wipeBuffer(key);
}

/** `@napi-rs/keyring` reports an absent credential as an exception, not only `null`. */
function isKeyringNoEntry(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const rec = error as { code?: unknown; name?: unknown; message?: unknown };
  const code = typeof rec.code === "string" ? rec.code.toLowerCase() : "";
  const name = typeof rec.name === "string" ? rec.name.toLowerCase() : "";
  const message = typeof rec.message === "string" ? rec.message.toLowerCase() : "";
  return code === "noentry"
    || code === "no_entry"
    || name === "noentry"
    || message.includes("no entry")
    || message.includes("no matching entry");
}

function copyKeySecret(secret: KeySecret): Buffer | null {
  if (!secret || secretByteLength(secret) !== RESPONSE_CONTINUATION_KEY_BYTES) {
    wipeBuffer(secret);
    return null;
  }
  const key = Buffer.from(secret);
  wipeBuffer(secret);
  return key;
}

function loadOrCreateKeySync(configDir: string, lifecycleToken: KeyLifecycleToken): Buffer | null {
  const homeId = responseContinuationHomeId(configDir);
  if (!isCurrentKeyLifecycleToken(homeId, lifecycleToken)) return null;
  const cached = cachedKeysByHomeId.get(homeId);
  if (cached) return cached;
  if (keyringTemporarilyUnavailable(homeId)) return null;

  const account = responseContinuationKeyringAccount(configDir);
  let syncEntry: ResponseContinuationSyncKeyringEntry;
  try {
    syncEntry = syncEntryFactory(RESPONSE_CONTINUATION_KEYRING_SERVICE, account);
  } catch {
    noteKeyringUnavailable(homeId);
    return null;
  }

  let existingSecret: KeySecret = null;
  try {
    existingSecret = syncEntry.getSecret();
  } catch (error) {
    if (!isKeyringNoEntry(error)) {
      noteKeyringUnavailable(homeId);
      return null;
    }
  }
  if (existingSecret && secretByteLength(existingSecret) !== RESPONSE_CONTINUATION_KEY_BYTES) {
    wipeBuffer(existingSecret);
    noteKeyringUnavailable(homeId);
    return null;
  }

  const existingKey = copyKeySecret(existingSecret);
  if (existingKey) {
    if (!isCurrentKeyLifecycleToken(homeId, lifecycleToken)) {
      wipeBuffer(existingKey);
      return null;
    }
    cachedKeysByHomeId.set(homeId, existingKey);
    return existingKey;
  }

  try {
    const key = withConfigMutationLockSync(() => {
      let underLockSecret: KeySecret = null;
      try {
        underLockSecret = syncEntry.getSecret();
      } catch (error) {
        if (!isKeyringNoEntry(error)) {
          throw new Error("Response continuation keyring recheck failed");
        }
      }
      if (underLockSecret && secretByteLength(underLockSecret) !== RESPONSE_CONTINUATION_KEY_BYTES) {
        wipeBuffer(underLockSecret);
        throw new Error("Response continuation keyring contains an invalid key");
      }
      const underLockKey = copyKeySecret(underLockSecret);
      if (underLockKey) return underLockKey;

      const freshKey = randomBytes(RESPONSE_CONTINUATION_KEY_BYTES);
      try {
        syncEntry.setSecret(freshKey);
      } catch (err) {
        wipeBuffer(freshKey);
        throw err;
      }

      let readbackSecret: KeySecret = null;
      try {
        readbackSecret = syncEntry.getSecret();
      } catch (err) {
        wipeBuffer(freshKey);
        throw err;
      }

      if (!readbackSecret || secretByteLength(readbackSecret) !== RESPONSE_CONTINUATION_KEY_BYTES) {
        wipeBuffer(freshKey);
        wipeBuffer(readbackSecret);
        throw new Error("Response continuation keyring readback verification failed: invalid length");
      }

      const readbackBuf = Buffer.from(readbackSecret);
      wipeBuffer(readbackSecret);

      if (!timingSafeEqual(freshKey, readbackBuf)) {
        wipeBuffer(freshKey);
        wipeBuffer(readbackBuf);
        throw new Error("Response continuation keyring readback verification failed: content mismatch");
      }

      wipeBuffer(readbackBuf);
      return freshKey;
    });

    if (!isCurrentKeyLifecycleToken(homeId, lifecycleToken)) {
      wipeBuffer(key);
      return null;
    }
    cachedKeysByHomeId.set(homeId, key);
    return key;
  } catch (error) {
    // The shared mutation lock is deliberately fail-fast. A competing config write
    // is transient and must not suppress a retry on the next sensitive turn.
    if (!(error instanceof ConfigMutationLockError)) noteKeyringUnavailable(homeId);
    return null;
  }
}

export async function getResponseContinuationKey(configDir = getConfigDir()): Promise<Buffer | null> {
  const homeId = responseContinuationHomeId(configDir);
  const cached = cachedKeysByHomeId.get(homeId);
  if (cached) return Buffer.from(cached);
  if (keyringTemporarilyUnavailable(homeId)) return null;

  const existingFlight = keyFlightsByHomeId.get(homeId);
  if (existingFlight) return existingFlight.then(key => key ? Buffer.from(key) : null);

  const lifecycleToken = captureKeyLifecycleToken(homeId);
  const operation = Promise.resolve().then(async () => {
    try {
      if (!isCurrentKeyLifecycleToken(homeId, lifecycleToken)) return null;
      const account = responseContinuationKeyringAccount(configDir);
      let asyncEntry: ResponseContinuationAsyncKeyringEntry;
      try {
        asyncEntry = asyncEntryFactory(RESPONSE_CONTINUATION_KEYRING_SERVICE, account);
      } catch {
        noteKeyringUnavailable(homeId);
        return null;
      }

      let secret: Uint8Array | null | undefined = null;
      try {
        secret = await asyncEntry.getSecret(AbortSignal.timeout(KEYRING_READ_TIMEOUT_MS));
      } catch (error) {
        if (!isCurrentKeyLifecycleToken(homeId, lifecycleToken)) return null;
        if (!isKeyringNoEntry(error)) {
          // timeout or keyring error: mark unavailable and degrade to memory-only
          noteKeyringUnavailable(homeId);
          return null;
        }
      }

      if (!isCurrentKeyLifecycleToken(homeId, lifecycleToken)) {
        wipeBuffer(secret);
        return null;
      }

      if (secret) {
        const key = copyKeySecret(secret);
        if (key) {
          if (!isCurrentKeyLifecycleToken(homeId, lifecycleToken)) {
            wipeBuffer(key);
            return null;
          }
          cachedKeysByHomeId.set(homeId, key);
          return key;
        }
        noteKeyringUnavailable(homeId);
        return null;
      }

      // Only clean null (key not found) enters sync locked creation
      return loadOrCreateKeySync(configDir, lifecycleToken);
    } catch (error) {
      if (!isCurrentKeyLifecycleToken(homeId, lifecycleToken)) return null;
      throw error;
    }
  });

  const flight = operation.finally(() => {
    if (keyFlightsByHomeId.get(homeId) === flight) keyFlightsByHomeId.delete(homeId);
  });

  keyFlightsByHomeId.set(homeId, flight);
  return flight.then(key => key ? Buffer.from(key) : null);
}

export function getResponseContinuationKeySync(configDir = getConfigDir()): Buffer | null {
  // Response completion and synchronous replay must never open the OS credential
  // store. Turn setup prepares encrypted state asynchronously; an unexpected
  // sensitive output safely degrades to memory-only when no key is already cached.
  const cached = cachedKeysByHomeId.get(responseContinuationHomeId(configDir));
  return cached ? Buffer.from(cached) : null;
}

export function buildResponseContinuationAAD(
  homeId: string,
  responseId: string,
  createdAt: number,
  clientThreadId?: string | null,
  providerOutputStart?: number | null,
): Buffer {
  return Buffer.from(
    JSON.stringify([
      RESPONSE_CONTINUATION_AAD_VERSION,
      homeId,
      responseId,
      createdAt,
      clientThreadId ?? null,
      providerOutputStart ?? null,
    ]),
    "utf8",
  );
}

function decodeCanonicalBase64(
  encoded: string,
  expectedLen?: number,
  maxLen?: number,
): Buffer | null {
  if (typeof encoded !== "string" || encoded.length === 0) return null;
  const decodedBound = expectedLen ?? maxLen;
  if (decodedBound !== undefined && encoded.length > 4 * Math.ceil(decodedBound / 3)) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;
  try {
    const buf = Buffer.from(encoded, "base64");
    if (buf.toString("base64") !== encoded) return null;
    if (expectedLen !== undefined && buf.byteLength !== expectedLen) {
      wipeBuffer(buf);
      return null;
    }
    if (maxLen !== undefined && buf.byteLength > maxLen) {
      wipeBuffer(buf);
      return null;
    }
    return buf;
  } catch {
    return null;
  }
}

export function encryptResponseContinuation(
  payload: { items: unknown[]; providers?: unknown },
  aad: Buffer,
  key: Buffer,
): ResponseContinuationEncryptedEnvelope {
  const keyId = createHash("sha256").update(key).digest("hex").slice(0, 16);
  const nonce = randomBytes(RESPONSE_CONTINUATION_NONCE_BYTES);
  let plaintext: Buffer | null = null;
  try {
    plaintext = Buffer.from(JSON.stringify(payload), "utf8");
    const cipher = createCipheriv(RESPONSE_CONTINUATION_CIPHER, key, nonce);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    const result: ResponseContinuationEncryptedEnvelope = {
      version: 1,
      cipher: "aes-256-gcm",
      keyId,
      nonce: nonce.toString("base64"),
      tag: tag.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
    wipeBuffer(ciphertext);
    wipeBuffer(tag);
    wipeBuffer(nonce);
    return result;
  } finally {
    wipeBuffer(plaintext);
  }
}

export function decryptResponseContinuation(
  envelope: ResponseContinuationEncryptedEnvelope,
  aad: Buffer,
  key: Buffer,
): { items: unknown[]; providers?: unknown } | null {
  if (
    !envelope
    || envelope.version !== 1
    || envelope.cipher !== "aes-256-gcm"
    || typeof envelope.keyId !== "string"
    || typeof envelope.nonce !== "string"
    || typeof envelope.tag !== "string"
    || typeof envelope.ciphertext !== "string"
  ) {
    return null;
  }

  const expectedKeyId = createHash("sha256").update(key).digest("hex").slice(0, 16);
  if (envelope.keyId !== expectedKeyId) {
    return null;
  }

  const nonce = decodeCanonicalBase64(envelope.nonce, RESPONSE_CONTINUATION_NONCE_BYTES);
  if (!nonce) return null;

  const tag = decodeCanonicalBase64(envelope.tag, RESPONSE_CONTINUATION_TAG_BYTES);
  if (!tag) {
    wipeBuffer(nonce);
    return null;
  }

  const ciphertext = decodeCanonicalBase64(envelope.ciphertext, undefined, MAX_RESPONSE_CONTINUATION_CIPHERTEXT_BYTES);
  if (!ciphertext) {
    wipeBuffer(nonce);
    wipeBuffer(tag);
    return null;
  }

  let plaintext: Buffer | null = null;
  try {
    const decipher = createDecipheriv(RESPONSE_CONTINUATION_CIPHER, key, nonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const parsed = JSON.parse(plaintext.toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { items?: unknown }).items)) {
      return null;
    }
    const providers = (parsed as { providers?: unknown }).providers;
    if (providers !== undefined && (!providers || typeof providers !== "object" || Array.isArray(providers))) {
      return null;
    }
    return parsed as { items: unknown[]; providers?: unknown };
  } catch {
    return null;
  } finally {
    wipeBuffer(nonce);
    wipeBuffer(tag);
    wipeBuffer(ciphertext);
    wipeBuffer(plaintext);
  }
}

const DELEGATION_MESSAGE_OPS = new Set(["spawn_agent", "send_message", "followup_task"]);

export function hasPlaintextDelegationHistory(value: unknown): boolean {
  if (!value) return false;
  if (Array.isArray(value)) {
    return value.some(hasPlaintextDelegationHistory);
  }
  if (typeof value !== "object") return false;
  const rec = value as Record<string, unknown>;

  if (rec.type === "agent_message") return true;
  if (rec.namespace === "ocx_agents") return true;

  if (typeof rec.name === "string") {
    if (rec.name.startsWith("ocx_agents:") || rec.name.startsWith("ocx_agents.")) return true;
    if (rec.name === "ocx_agents") return true;
    const nameWithoutNs = rec.name.includes(":")
      ? rec.name.slice(rec.name.lastIndexOf(":") + 1)
      : rec.name.includes(".")
        ? rec.name.slice(rec.name.lastIndexOf(".") + 1)
        : rec.name;
    const isCallRecord = rec.type === "function_call"
      || typeof rec.arguments === "string"
      || typeof rec.call_id === "string";
    const isCollabOp = isCallRecord && DELEGATION_MESSAGE_OPS.has(nameWithoutNs) && (
      rec.namespace === "collaboration"
      || rec.name.startsWith("collaboration:")
      || rec.name.startsWith("collaboration.")
      || rec.namespace === undefined
    );
    if (isCollabOp && (
      rec.encrypted_function_args === undefined
      || (Array.isArray(rec.encrypted_function_args) && rec.encrypted_function_args.length === 0)
    )) {
      return true;
    }
  }

  if (Array.isArray(rec.tools) && rec.tools.some(hasPlaintextDelegationHistory)) return true;
  if (Array.isArray(rec.input) && rec.input.some(hasPlaintextDelegationHistory)) return true;
  if (Array.isArray(rec.content) && rec.content.some(hasPlaintextDelegationHistory)) return true;
  if (Array.isArray(rec.output) && rec.output.some(hasPlaintextDelegationHistory)) return true;
  if (rec.item && typeof rec.item === "object" && hasPlaintextDelegationHistory(rec.item)) return true;

  if (typeof rec.arguments === "string" && rec.arguments.includes("encrypted_function_args")) {
    try {
      const parsedArgs = JSON.parse(rec.arguments) as unknown;
      if (hasPlaintextDelegationHistory(parsedArgs)) return true;
    } catch {
      // not JSON
    }
  }

  return false;
}
