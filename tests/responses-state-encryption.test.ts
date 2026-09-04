import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeWithRetry } from "./helpers/remove-tree";
import {
  buildResponseContinuationAAD,
  clearResponseStateForTests,
  clearResponseStateMemoryForTests,
  copyPreviousResponseReplayProvenance,
  decryptResponseContinuation,
  evictOldestResponseContinuationForBudget,
  encryptResponseContinuation,
  expandPreviousResponseInput,
  flushResponseState,
  getResponseContinuationKey,
  getResponseContinuationKeySync,
  getResponseStateDurability,
  hasPlaintextDelegationHistory,
  isMemoryOnlyBody,
  markBodyResponseStateDurability,
  prepareResponseStateReplay,
  prepareSensitiveResponsePersistence,
  previousResponseReplayFailure,
  releaseResponseContinuationKey,
  rememberResponseState,
  resetResponseContinuationKeyForTests,
  responseContinuationHomeId,
  responseContinuationKeyringAccount,
  responseStateMetrics,
  runPendingLegacyResponseStateRetirementForTests,
  setResponseContinuationKeyringFactoryForTests,
  setResponseStateByteCapForTests,
} from "../src/responses/state";
import {
  readResponseSpill,
  responseSpillDirectory,
  setSpillIoForTest,
} from "../src/responses/spill-store";

const canSymlink = (() => {
  const probeDir = mkdtempSync(join(tmpdir(), "ocx-state-enc-symlink-probe-"));
  try {
    symlinkSync(join(probeDir, "target"), join(probeDir, "link"));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return false;
    throw error;
  } finally {
    removeTreeWithRetry(probeDir);
  }
})();
import { wipeResponseContinuationKeyCopy } from "../src/responses/continuation-crypto";

describe("Selective encrypted continuation state for Routed V2", () => {
  let home: string;
  const savedHome = process.env.OPENCODEX_HOME;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ocx-state-enc-test-"));
    process.env.OPENCODEX_HOME = home;
    clearResponseStateForTests();
  });

  afterEach(async () => {
    try {
      await flushResponseState();
    } catch {
      // ignore
    }
    clearResponseStateForTests();
    resetResponseContinuationKeyForTests();
    setSpillIoForTest(null);
    if (savedHome !== undefined) process.env.OPENCODEX_HOME = savedHome;
    else delete process.env.OPENCODEX_HOME;
    removeTreeWithRetry(home);
  });

  test("memory-only durability stays in RAM and never writes to disk snapshot or spill", async () => {
    const sensitivePayload = "super-confidential-task-instruction";
    const request = {
      model: "chatgpt/gpt-5.6-luna",
      input: [{ role: "user", content: "spawn worker" }],
    };
    const response = {
      id: "resp_mem_only_1",
      status: "completed",
      output: [
        {
          type: "function_call",
          namespace: "collaboration",
          name: "spawn_agent",
          arguments: JSON.stringify({ message: sensitivePayload }),
          encrypted_function_args: [],
        },
      ],
    };

    rememberResponseState(request, response, undefined, { durability: "memory-only" });

    // Verify it is in memory
    const expanded = expandPreviousResponseInput({
      previous_response_id: "resp_mem_only_1",
      input: [{ role: "user", content: "continue" }],
    }) as { input: Array<Record<string, unknown>> };
    expect(JSON.stringify(expanded)).toContain(sensitivePayload);

    // Flush to disk
    await flushResponseState();

    // Verify snapshot on disk does NOT contain the state or sensitive payload
    const snapshotPath = join(home, "responses-state.json");
    if (existsSync(snapshotPath)) {
      const content = readFileSync(snapshotPath, "utf8");
      expect(content).not.toContain("resp_mem_only_1");
      expect(content).not.toContain(sensitivePayload);
    }

    // Verify no spill files exist
    const spillDir = responseSpillDirectory(home);
    if (existsSync(spillDir)) {
      expect(readdirSync(spillDir)).toEqual([]);
    }

    // Simulate restart: memory is cleared, entry is deliberately lost
    clearResponseStateMemoryForTests();
    const afterRestart = expandPreviousResponseInput({
      previous_response_id: "resp_mem_only_1",
      input: [{ role: "user", content: "continue" }],
    });
    expect(previousResponseReplayFailure(afterRestart)).toBeUndefined();
    expect(JSON.stringify(afterRestart)).not.toContain(sensitivePayload);
  });

  test("encrypted durability encrypts state with AES-256-GCM and persists stable envelope in snapshot v3", async () => {
    const memoryKeyring = new Map<string, Uint8Array>();
    setResponseContinuationKeyringFactoryForTests({
      getSecret: account => memoryKeyring.get(account) ?? null,
      setSecret: (account, secret) => { memoryKeyring.set(account, Uint8Array.from(secret)); },
    });

    const sensitivePayload = "secret-subagent-instructions-xyz";
    const request = {
      model: "chatgpt/gpt-5.6-luna",
      input: [{ role: "user", content: "run task" }],
    };
    const response = {
      id: "resp_enc_1",
      status: "completed",
      output: [
        {
          type: "function_call",
          namespace: "ocx_agents",
          name: "spawn_agent",
          arguments: JSON.stringify({ message: sensitivePayload }),
        },
      ],
    };

    expect(await prepareSensitiveResponsePersistence(request)).toBe("encrypted");
    rememberResponseState(request, response, undefined, { durability: "encrypted" });
    await flushResponseState();

    const snapshotPath = join(home, "responses-state.json");
    expect(existsSync(snapshotPath)).toBe(true);
    const rawSnapshot = readFileSync(snapshotPath, "utf8");

    // Plaintext sensitive string must NEVER appear in snapshot file
    expect(rawSnapshot).not.toContain(sensitivePayload);
    expect(rawSnapshot).not.toContain("ocx_agents");

    // Snapshot is version 3 with encrypted-resident entry
    const parsedSnapshot = JSON.parse(rawSnapshot) as { version: number; states: Array<[string, Record<string, unknown>]> };
    expect(parsedSnapshot.version).toBe(3);
    const entry = parsedSnapshot.states.find(([id]) => id === "resp_enc_1")?.[1];
    expect(entry).toBeDefined();
    expect(entry?.kind).toBe("encrypted-resident");
    expect(entry?.envelope).toMatchObject({
      version: 1,
      cipher: "aes-256-gcm",
      keyId: expect.any(String),
      nonce: expect.any(String),
      tag: expect.any(String),
      ciphertext: expect.any(String),
    });

    // Simulate process restart
    clearResponseStateMemoryForTests();

    // Replay after restart: prepareResponseStateReplay preloads key and expandPreviousResponseInput decrypts successfully
    const replayReq = { previous_response_id: "resp_enc_1", input: [{ role: "user", content: "hello" }] };
    await prepareResponseStateReplay(replayReq);
    const decryptedReplay = expandPreviousResponseInput(replayReq) as { input: Array<Record<string, unknown>> };

    expect(JSON.stringify(decryptedReplay)).toContain(sensitivePayload);
    expect(previousResponseReplayFailure(replayReq)).toBeUndefined();
  });

  test("ordinary standard replay does not access keyring", async () => {
    let keyringAccessCount = 0;
    setResponseContinuationKeyringFactoryForTests({
      getSecret: () => {
        keyringAccessCount += 1;
        return null;
      },
      setSecret: () => {
        keyringAccessCount += 1;
      },
    });

    const request = {
      model: "openai/gpt-4o",
      input: [{ role: "user", content: "ordinary prompt" }],
    };
    const response = {
      id: "resp_standard_1",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: "ordinary answer" }],
    };

    rememberResponseState(request, response, undefined, { durability: "standard" });
    await flushResponseState();

    expect(keyringAccessCount).toBe(0);

    const replayReq = { previous_response_id: "resp_standard_1", input: [{ role: "user", content: "next" }] };
    await prepareResponseStateReplay(replayReq);
    expect(keyringAccessCount).toBe(0);

    const expanded = expandPreviousResponseInput(replayReq);
    expect(keyringAccessCount).toBe(0);
    expect(JSON.stringify(expanded)).toContain("ordinary answer");
  });

  test("detects resubmitted plaintext delegation histories and marks body as encrypted without previous_response_id", async () => {
    let keyringAccessCount = 0;
    const secrets = new Map<string, Uint8Array>();
    setResponseContinuationKeyringFactoryForTests({
      getSecret: account => { keyringAccessCount += 1; return secrets.get(account) ?? null; },
      setSecret: (account, secret) => {
        keyringAccessCount += 1;
        secrets.set(account, new Uint8Array(secret));
      },
    });

    const bodyWithOcxAgents = {
      model: "chatgpt/gpt-5.6-luna",
      input: [
        {
          type: "function_call",
          namespace: "ocx_agents",
          name: "spawn_agent",
          arguments: JSON.stringify({ message: "child assignment" }),
        },
      ],
    };

    expect(hasPlaintextDelegationHistory(bodyWithOcxAgents.input)).toBe(true);

    // Sensitive full-history replay must prepare secure storage even without an id.
    await prepareResponseStateReplay(bodyWithOcxAgents);
    expect(keyringAccessCount).toBeGreaterThan(0);
    expect(getResponseStateDurability(bodyWithOcxAgents)).toBe("encrypted");
    const accessesAfterCreation = keyringAccessCount;

    const bodyWithCollabEmptyArgs = {
      model: "chatgpt/gpt-5.6-luna",
      input: [
        {
          type: "function_call",
          namespace: "collaboration",
          name: "send_message",
          arguments: JSON.stringify({ message: "update" }),
          encrypted_function_args: [],
        },
      ],
    };

    expect(hasPlaintextDelegationHistory(bodyWithCollabEmptyArgs.input)).toBe(true);
    await prepareResponseStateReplay(bodyWithCollabEmptyArgs);
    expect(keyringAccessCount).toBe(accessesAfterCreation);
    expect(getResponseStateDurability(bodyWithCollabEmptyArgs)).toBe("encrypted");

    expect(hasPlaintextDelegationHistory([{
      type: "function_call",
      namespace: "collaboration",
      name: "spawn_agent",
      arguments: JSON.stringify({ message: "unencrypted by omission" }),
    }])).toBe(true);
    expect(hasPlaintextDelegationHistory([{
      type: "function_call",
      namespace: "collaboration",
      name: "followup_task",
      arguments: JSON.stringify({ message: "client-controlled marker cannot declassify this" }),
      encrypted_function_args: ["message"],
    }])).toBe(true);
    expect(hasPlaintextDelegationHistory([{
      type: "agent_message",
      author: "/root",
      recipient: "/root/child",
      content: [{ type: "input_text", text: "plaintext task" }],
    }])).toBe(true);
    expect(hasPlaintextDelegationHistory([{
      type: "namespace",
      name: "collaboration",
      tools: [{ type: "function", name: "spawn_agent", parameters: { type: "object" } }],
    }])).toBe(false);

    // Ordinary request without delegation history
    const ordinaryBody = {
      model: "openai/gpt-4o",
      input: [{ role: "user", content: "just text" }],
    };
    expect(hasPlaintextDelegationHistory(ordinaryBody.input)).toBe(false);
    await prepareResponseStateReplay(ordinaryBody);
    expect(keyringAccessCount).toBe(accessesAfterCreation);
    expect(getResponseStateDurability(ordinaryBody)).toBeUndefined();
  });

  test("delegation-history scanning fails closed when traversal budgets are exceeded", () => {
    let deeplyNested: Record<string, unknown> = { role: "user", content: "ordinary" };
    for (let depth = 0; depth < 10_000; depth += 1) deeplyNested = { item: deeplyNested };

    expect(hasPlaintextDelegationHistory(deeplyNested)).toBe(true);
    expect(hasPlaintextDelegationHistory(
      Array.from({ length: 20_000 }, () => ({ role: "user", content: "ordinary" })),
    )).toBe(true);
  });

  test("taint propagation: turn 2 inherits durability from replayed turn 1", async () => {
    const memoryKeyring = new Map<string, Uint8Array>();
    setResponseContinuationKeyringFactoryForTests({
      getSecret: a => memoryKeyring.get(a) ?? null,
      setSecret: (a, s) => { memoryKeyring.set(a, new Uint8Array(s)); },
    });

    const turn1Request = { model: "chatgpt/gpt-5.6-luna", input: "turn 1" };
    const turn1Response = {
      id: "resp_turn_1",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: "turn 1 answer" }],
    };
    expect(await prepareSensitiveResponsePersistence(turn1Request)).toBe("encrypted");
    rememberResponseState(turn1Request, turn1Response, undefined, { durability: "encrypted" });

    // Turn 2 expands turn 1
    const turn2Request = { previous_response_id: "resp_turn_1", input: "turn 2 prompt" };
    await prepareResponseStateReplay(turn2Request);
    const turn2Expanded = expandPreviousResponseInput(turn2Request) as Record<string, unknown>;

    // Turn 2 should inherit "encrypted" durability
    expect(getResponseStateDurability(turn2Expanded)).toBe("encrypted");

    // Remember Turn 2 without explicit options -> should record as encrypted
    const turn2Response = {
      id: "resp_turn_2",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: "turn 2 answer" }],
    };
    rememberResponseState(turn2Expanded, turn2Response);
    await flushResponseState();

    const snapshot = JSON.parse(readFileSync(join(home, "responses-state.json"), "utf8")) as {
      version: number;
      states: Array<[string, Record<string, unknown>]>;
    };
    const rowTurn2 = snapshot.states.find(([id]) => id === "resp_turn_2")?.[1];
    expect(rowTurn2?.kind).toBe("encrypted-resident");
  });

  test("clean miss on tampering, wrong key, or wrong home ID without server crash", async () => {
    const memoryKeyring = new Map<string, Uint8Array>();
    setResponseContinuationKeyringFactoryForTests({
      getSecret: a => memoryKeyring.get(a) ?? null,
      setSecret: (a, s) => { memoryKeyring.set(a, new Uint8Array(s)); },
    });

    const request = { model: "chatgpt/gpt-5.6-luna", input: "test" };
    const response = {
      id: "resp_tamper_1",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: "sensitive payload to tamper" }],
    };
    expect(await prepareSensitiveResponsePersistence(request)).toBe("encrypted");
    rememberResponseState(request, response, undefined, { durability: "encrypted" });
    await flushResponseState();

    const snapshotPath = join(home, "responses-state.json");
    const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as {
      version: number;
      states: Array<[string, Record<string, unknown>]>;
    };
    const entry = snapshot.states.find(([id]) => id === "resp_tamper_1")?.[1];
    const envelope = entry?.envelope as Record<string, string>;

    // 1. Tamper ciphertext
    const tamperedCiphertext = Buffer.from(envelope.ciphertext, "base64");
    tamperedCiphertext[0] = (tamperedCiphertext[0]! ^ 0xff);
    envelope.ciphertext = tamperedCiphertext.toString("base64");
    writeFileSync(snapshotPath, JSON.stringify(snapshot));

    clearResponseStateMemoryForTests();
    const replayReq = { previous_response_id: "resp_tamper_1", input: "next" };
    await prepareResponseStateReplay(replayReq);
    const replayResult = expandPreviousResponseInput(replayReq);

    // Must be a clean miss with failure reason spill_corrupt, no crash
    expect(previousResponseReplayFailure(replayReq)).toEqual({
      code: "previous_response_not_found",
      reason: "spill_corrupt",
    });
    expect(JSON.stringify(replayResult)).not.toContain("sensitive payload to tamper");

    // 2. Wrong key simulation
    memoryKeyring.clear(); // key missing / rotated
    clearResponseStateMemoryForTests();
    const replayWrongKey = { previous_response_id: "resp_tamper_1", input: "next" };
    await prepareResponseStateReplay(replayWrongKey);
    const wrongKeyResult = expandPreviousResponseInput(replayWrongKey);
    expect(previousResponseReplayFailure(replayWrongKey)).toEqual({
      code: "previous_response_not_found",
      reason: "spill_corrupt",
    });
  });

  test("temporary keyring failure preserves an encrypted resident across restart for retry", async () => {
    const memoryKeyring = new Map<string, Uint8Array>();
    setResponseContinuationKeyringFactoryForTests({
      getSecret: account => memoryKeyring.get(account) ?? null,
      setSecret: (account, secret) => { memoryKeyring.set(account, Uint8Array.from(secret)); },
    });
    const secret = "resident survives a transient keyring outage";
    const request = { input: "first" };
    expect(await prepareSensitiveResponsePersistence(request)).toBe("encrypted");
    rememberResponseState(request, {
      id: "resp_transient_resident",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: secret }],
    }, undefined, { durability: "encrypted" });
    await flushResponseState();
    clearResponseStateMemoryForTests();

    setResponseContinuationKeyringFactoryForTests({
      getSecret: () => { throw new Error("keyring temporarily unavailable"); },
      setSecret: () => { throw new Error("keyring temporarily unavailable"); },
    });
    const unavailable = { previous_response_id: "resp_transient_resident", input: "retry" };
    await prepareResponseStateReplay(unavailable);
    expandPreviousResponseInput(unavailable);
    expect(previousResponseReplayFailure(unavailable)?.reason).toBe("spill_corrupt");
    await flushResponseState();
    expect(JSON.parse(readFileSync(join(home, "responses-state.json"), "utf8")).states[0][1].kind)
      .toBe("encrypted-resident");

    setResponseContinuationKeyringFactoryForTests({
      getSecret: account => memoryKeyring.get(account) ?? null,
      setSecret: (account, value) => { memoryKeyring.set(account, Uint8Array.from(value)); },
    });
    const recovered = { previous_response_id: "resp_transient_resident", input: "retry" };
    await prepareResponseStateReplay(recovered);
    expect(JSON.stringify(expandPreviousResponseInput(recovered))).toContain(secret);
    expect(previousResponseReplayFailure(recovered)).toBeUndefined();
  });

  test("temporary keyring failure preserves an encrypted spill and its stub for retry", async () => {
    const memoryKeyring = new Map<string, Uint8Array>();
    setResponseContinuationKeyringFactoryForTests({
      getSecret: account => memoryKeyring.get(account) ?? null,
      setSecret: (account, secret) => { memoryKeyring.set(account, Uint8Array.from(secret)); },
    });
    const secret = "spilled secret survives keyring outage ".repeat(400);
    const request = { input: "first" };
    expect(await prepareSensitiveResponsePersistence(request)).toBe("encrypted");
    rememberResponseState(request, {
      id: "resp_transient_spill",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: secret }],
    }, undefined, { durability: "encrypted" });
    setResponseStateByteCapForTests(1_024);
    evictOldestResponseContinuationForBudget();
    await flushResponseState();
    const spillDir = responseSpillDirectory(home);
    const spillFile = readdirSync(spillDir)[0]!;
    clearResponseStateMemoryForTests();

    setResponseContinuationKeyringFactoryForTests({
      getSecret: () => { throw new Error("keyring temporarily unavailable"); },
      setSecret: () => { throw new Error("keyring temporarily unavailable"); },
    });
    const unavailable = { previous_response_id: "resp_transient_spill", input: "retry" };
    await prepareResponseStateReplay(unavailable);
    expandPreviousResponseInput(unavailable);
    expect(previousResponseReplayFailure(unavailable)?.reason).toBe("spill_corrupt");
    await flushResponseState();
    expect(existsSync(join(spillDir, spillFile))).toBe(true);
    const snapshot = JSON.parse(readFileSync(join(home, "responses-state.json"), "utf8")) as {
      states: Array<[string, { kind: string }]>;
    };
    expect(snapshot.states.find(([id]) => id === "resp_transient_spill")?.[1].kind).toBe("spill");

    setResponseContinuationKeyringFactoryForTests({
      getSecret: account => memoryKeyring.get(account) ?? null,
      setSecret: (account, value) => { memoryKeyring.set(account, Uint8Array.from(value)); },
    });
    const recovered = { previous_response_id: "resp_transient_spill", input: "retry" };
    await prepareResponseStateReplay(recovered);
    expect(JSON.stringify(expandPreviousResponseInput(recovered))).toContain(secret);
    expect(previousResponseReplayFailure(recovered)).toBeUndefined();
  });

  test("AES-GCM authenticates every continuation identity and envelope field", () => {
    const key = Buffer.alloc(32, 0x5a);
    const identity = {
      home: responseContinuationHomeId(home),
      id: "resp_aad",
      createdAt: 1_725_000_000_000,
      thread: "task-a",
      boundary: 3,
    };
    const aad = buildResponseContinuationAAD(
      identity.home,
      identity.id,
      identity.createdAt,
      identity.thread,
      identity.boundary,
    );
    const envelope = encryptResponseContinuation({ items: [{ secret: "sentinel" }] }, aad, key);
    expect(decryptResponseContinuation(envelope, aad, key)?.items).toEqual([{ secret: "sentinel" }]);

    const wrongAads = [
      buildResponseContinuationAAD("other-home", identity.id, identity.createdAt, identity.thread, identity.boundary),
      buildResponseContinuationAAD(identity.home, "other-id", identity.createdAt, identity.thread, identity.boundary),
      buildResponseContinuationAAD(identity.home, identity.id, identity.createdAt + 1, identity.thread, identity.boundary),
      buildResponseContinuationAAD(identity.home, identity.id, identity.createdAt, "task-b", identity.boundary),
      buildResponseContinuationAAD(identity.home, identity.id, identity.createdAt, identity.thread, identity.boundary + 1),
    ];
    for (const wrong of wrongAads) expect(decryptResponseContinuation(envelope, wrong, key)).toBeNull();

    for (const field of ["nonce", "tag", "ciphertext"] as const) {
      const bytes = Buffer.from(envelope[field], "base64");
      bytes[0] ^= 0xff;
      expect(decryptResponseContinuation({ ...envelope, [field]: bytes.toString("base64") }, aad, key)).toBeNull();
    }
    key.fill(0);
  });

  test("keyring failure downgrades to memory-only with no plaintext written to disk", async () => {
    // Inject a failing keyring
    setResponseContinuationKeyringFactoryForTests({
      getSecret: () => { throw new Error("OS Keyring unavailable in container"); },
      setSecret: () => { throw new Error("OS Keyring unavailable in container"); },
    });

    const sensitiveData = "never-persist-this-plaintext-to-disk";
    const request = { model: "chatgpt/gpt-5.6-luna", input: "test" };
    const response = {
      id: "resp_fail_keyring_1",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: sensitiveData }],
    };

    // Requested durability cannot become durable when the keyring is unavailable.
    rememberResponseState(request, response, undefined, { durability: "encrypted" });

    // Same process replay still works from RAM
    const inMemoryReplay = expandPreviousResponseInput({
      previous_response_id: "resp_fail_keyring_1",
      input: "continue",
    });
    expect(JSON.stringify(inMemoryReplay)).toContain(sensitiveData);

    // Flush to disk
    await flushResponseState();

    // Check disk snapshot: plaintext MUST NOT appear
    const snapshotPath = join(home, "responses-state.json");
    if (existsSync(snapshotPath)) {
      const content = readFileSync(snapshotPath, "utf8");
      expect(content).not.toContain(sensitiveData);
      expect(content).not.toContain("resp_fail_keyring_1");
    }
  });

  test("encrypted spill store v2: demoted encrypted entries spill as version 2 with envelope and recover", async () => {
    const memoryKeyring = new Map<string, Uint8Array>();
    setResponseContinuationKeyringFactoryForTests({
      getSecret: a => memoryKeyring.get(a) ?? null,
      setSecret: (a, s) => { memoryKeyring.set(a, new Uint8Array(s)); },
    });

    const sensitiveContent = "large-encrypted-content-".repeat(1000);
    const request = { model: "chatgpt/gpt-5.6-luna", input: "test" };
    const response = {
      id: "resp_large_enc_1",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: sensitiveContent }],
    };

    expect(await prepareSensitiveResponsePersistence(request)).toBe("encrypted");
    rememberResponseState(request, response, undefined, { durability: "encrypted" });

    // Trigger demotion to spill by lowering byte cap
    setResponseStateByteCapForTests(10_000);
    // Remember another dummy to trigger pruneResponses
    rememberResponseState({ model: "openai/gpt-4o", input: "trigger" }, {
      id: "resp_trigger",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: "ok" }],
    });

    // Check spill directory
    const spillDir = responseSpillDirectory(home);
    expect(existsSync(spillDir)).toBe(true);
    const files = readdirSync(spillDir).filter(f => f.includes("resp_large_enc_1"));
    expect(files.length).toBe(1);

    // Read the spill file directly from disk: verify it is version 2 and ciphertext
    const spillPath = join(spillDir, files[0]!);
    const rawSpill = readFileSync(spillPath, "utf8");
    expect(rawSpill).not.toContain(sensitiveContent); // Zero plaintext!
    const parsedSpill = JSON.parse(rawSpill) as { version: number; envelope: Record<string, unknown> };
    expect(parsedSpill.version).toBe(2);
    expect(parsedSpill.envelope).toMatchObject({
      version: 1,
      cipher: "aes-256-gcm",
    });

    // Replay the spilled entry
    const replayReq = { previous_response_id: "resp_large_enc_1", input: "next" };
    await prepareResponseStateReplay(replayReq);
    const expanded = expandPreviousResponseInput(replayReq);
    expect(JSON.stringify(expanded)).toContain(sensitiveContent);
  });

  test("memory-only entries are never spilled under RAM pressure or budget eviction", async () => {
    setResponseStateByteCapForTests(512);

    const memContent = "memory-only-content-".repeat(50);
    rememberResponseState({ model: "chatgpt/gpt-5.6-luna", input: "test" }, {
      id: "resp_mem_spill_avoid",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: memContent }],
    }, undefined, { durability: "memory-only" });

    // Evict for budget
    evictOldestResponseContinuationForBudget();

    // Verify no spill file was created
    const spillDir = responseSpillDirectory(home);
    if (existsSync(spillDir)) {
      const files = readdirSync(spillDir).filter(f => f.includes("resp_mem_spill_avoid"));
      expect(files.length).toBe(0);
    }
  });

  test("legacy v1 and v2 snapshots: retires whole legacy snapshot and associated spills", async () => {
    const spillDir = responseSpillDirectory(home);
    mkdirSync(spillDir, { recursive: true });
    const legacySpillFile = "resp_legacy.1234567890ab.cdef12345678901234567890.1.100.spill.json";
    const legacySpillPath = join(spillDir, legacySpillFile);
    writeFileSync(legacySpillPath, JSON.stringify({ version: 1, responseId: "resp_legacy", createdAt: Date.now(), items: [] }));

    const legacySnapshot = {
      version: 2,
      states: [
        ["resp_legacy_standard", {
          createdAt: Date.now(),
          kind: "spill",
          spill: { version: 1, fileName: legacySpillFile, digest: "0".repeat(64), payloadBytes: 100 },
        }],
      ],
    };

    const snapshotPath = join(home, "responses-state.json");
    writeFileSync(snapshotPath, JSON.stringify(legacySnapshot));

    // Re-initialize state to load snapshot
    clearResponseStateMemoryForTests();

    // Trigger loading
    expandPreviousResponseInput({ previous_response_id: "resp_legacy_standard", input: "test" });

    // Legacy snapshot file and legacy spill file must be unlinked/retired!
    expect(existsSync(snapshotPath)).toBe(false);
    expect(existsSync(legacySpillPath)).toBe(false);
  });

  test.skipIf(!canSymlink)("legacy snapshot retirement removes both a symlink and its plaintext target", () => {
    const targetDir = join(home, "managed-state");
    mkdirSync(targetDir, { recursive: true });
    const targetPath = join(targetDir, "responses-state-target.json");
    const snapshotPath = join(home, "responses-state.json");
    writeFileSync(targetPath, JSON.stringify({ version: 2, states: [] }));
    symlinkSync(targetPath, snapshotPath);

    clearResponseStateMemoryForTests();
    expandPreviousResponseInput({ previous_response_id: "missing", input: "test" });

    expect(existsSync(targetPath)).toBe(false);
    expect(() => lstatSync(snapshotPath)).toThrow();
  });

  test("an ordinary snapshot write stays blocked while a legacy spill cannot be deleted", async () => {
    const spillDir = responseSpillDirectory(home);
    mkdirSync(spillDir, { recursive: true });
    const legacySpillFile = "resp_locked_legacy.1234567890ab.cdef12345678901234567890.1.100.spill.json";
    const legacySpillPath = join(spillDir, legacySpillFile);
    writeFileSync(legacySpillPath, JSON.stringify({
      version: 1,
      responseId: "resp_locked_legacy",
      createdAt: Date.now(),
      items: [{ secret: "legacy-plaintext" }],
    }));
    writeFileSync(join(home, "responses-state.json"), JSON.stringify({
      version: 2,
      states: [["resp_locked_legacy", {
        createdAt: Date.now(),
        kind: "spill",
        spill: { version: 1, fileName: legacySpillFile, digest: "0".repeat(64), payloadBytes: 100 },
      }]],
    }));

    setSpillIoForTest({
      unlink(path) {
        if (path === legacySpillPath) throw Object.assign(new Error("locked"), { code: "EACCES" });
        unlinkSync(path);
      },
    });
    clearResponseStateMemoryForTests();
    expandPreviousResponseInput({ previous_response_id: "resp_locked_legacy", input: "test" });
    expect(existsSync(legacySpillPath)).toBe(true);

    rememberResponseState({ input: "ordinary" }, {
      id: "resp_ordinary_after_legacy",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: "ordinary" }],
    });
    await flushResponseState();
    // The v2 snapshot remains the durable retry marker; replacing it with v3
    // would lose the only restart-stable reference to the plaintext spill.
    expect(JSON.parse(readFileSync(join(home, "responses-state.json"), "utf8")).version).toBe(2);
    expect(existsSync(legacySpillPath)).toBe(true);

    const memoryKeyring = new Map<string, Uint8Array>();
    setResponseContinuationKeyringFactoryForTests({
      getSecret: account => memoryKeyring.get(account) ?? null,
      setSecret: (account, secret) => { memoryKeyring.set(account, Uint8Array.from(secret)); },
    });
    expect(await prepareSensitiveResponsePersistence({ input: "sensitive" })).toBe("memory-only");

    setSpillIoForTest(null);
    runPendingLegacyResponseStateRetirementForTests();
    // The bounded retry retires the retained v2 marker in this process even
    // when every request is sensitive and schedules no ordinary snapshot write.
    expect(await prepareSensitiveResponsePersistence({ input: "sensitive retry" })).toBe("encrypted");
    expect(existsSync(legacySpillPath)).toBe(false);
    rememberResponseState({ input: "ordinary retry" }, {
      id: "resp_ordinary_retry",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: "ordinary retry" }],
    });
    await flushResponseState();
    expect(JSON.parse(readFileSync(join(home, "responses-state.json"), "utf8")).version).toBe(3);
  });

  test("keyring release drops the cache without mutating caller-owned copies", async () => {
    const memoryKeyring = new Map<string, Uint8Array>();
    setResponseContinuationKeyringFactoryForTests({
      getSecret: a => memoryKeyring.get(a) ?? null,
      setSecret: (a, s) => { memoryKeyring.set(a, new Uint8Array(s)); },
    });

    const key1 = await getResponseContinuationKey();
    expect(key1).toBeDefined();
    expect(key1?.byteLength).toBe(32);

    const beforeRelease = Buffer.from(key1!);
    releaseResponseContinuationKey();
    expect(key1).toEqual(beforeRelease);
    expect(getResponseContinuationKeySync()).toBeNull();
  });

  test("release cancels an in-flight key load without letting stale work replace a newer cache", async () => {
    const staleSecret = new Uint8Array(32).fill(0x11);
    const currentSecret = new Uint8Array(32).fill(0x22);
    let resolveStaleRead: ((secret: Uint8Array) => void) | undefined;
    let reads = 0;

    setResponseContinuationKeyringFactoryForTests({
      async: () => ({
        getSecret() {
          reads += 1;
          if (reads === 1) {
            return new Promise<Uint8Array>(resolve => { resolveStaleRead = resolve; });
          }
          return Promise.resolve(Uint8Array.from(currentSecret));
        },
        async setSecret() {},
      }),
      sync: () => ({
        getSecret: () => Uint8Array.from(currentSecret),
        setSecret() {},
      }),
    });

    const staleLoad = getResponseContinuationKey();
    await Promise.resolve();
    expect(resolveStaleRead).toBeDefined();

    releaseResponseContinuationKey();
    const currentLoad = await getResponseContinuationKey();
    expect(currentLoad).toEqual(Buffer.from(currentSecret));

    resolveStaleRead!(staleSecret);
    expect(await staleLoad).toBeNull();
    expect(staleSecret.every(byte => byte === 0)).toBe(true);
    expect(getResponseContinuationKeySync()).toEqual(Buffer.from(currentSecret));
  });

  test("caller-owned continuation key copies can be explicitly wiped", () => {
    const key = Buffer.alloc(32, 0x5a);
    wipeResponseContinuationKeyCopy(key);
    expect(key.equals(Buffer.alloc(32))).toBe(true);
  });

  test("concurrent key preparation creates and verifies one installation key", async () => {
    const secrets = new Map<string, Uint8Array>();
    let writes = 0;
    setResponseContinuationKeyringFactoryForTests({
      getSecret: account => secrets.get(account) ?? null,
      setSecret: (account, secret) => {
        writes += 1;
        secrets.set(account, new Uint8Array(secret));
      },
    });

    const [first, second, third] = await Promise.all([
      getResponseContinuationKey(),
      getResponseContinuationKey(),
      getResponseContinuationKey(),
    ]);
    expect(first).not.toBeNull();
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(second).not.toBe(first);
    expect(third).not.toBe(first);
    expect(first?.byteLength).toBe(32);
    expect(writes).toBe(1);
  });

  test("invalid or unverified keyring material never becomes a persistence key", async () => {
    let writes = 0;
    setResponseContinuationKeyringFactoryForTests({
      getSecret: () => new Uint8Array(31),
      setSecret: () => { writes += 1; },
    });
    expect(await getResponseContinuationKey()).toBeNull();
    expect(writes).toBe(0);

    resetResponseContinuationKeyForTests();
    let readback: Uint8Array | null = null;
    setResponseContinuationKeyringFactoryForTests({
      getSecret: () => readback,
      setSecret: (_account, secret) => {
        writes += 1;
        readback = new Uint8Array(secret);
        readback[0] ^= 0xff;
      },
    });
    expect(await getResponseContinuationKey()).toBeNull();
  });

  test("a keyring NoEntry exception creates and verifies the installation key", async () => {
    let stored: Uint8Array | null = null;
    const missing = () => Object.assign(new Error("No entry found"), { code: "NoEntry" });
    setResponseContinuationKeyringFactoryForTests({
      async: () => ({
        async getSecret() {
          if (!stored) throw missing();
          return Uint8Array.from(stored);
        },
        async setSecret(secret) { stored = Uint8Array.from(secret); },
      }),
      sync: () => ({
        getSecret() {
          if (!stored) throw missing();
          return Array.from(stored);
        },
        setSecret(secret) { stored = Uint8Array.from(secret); },
      }),
    });

    const key = await getResponseContinuationKey();
    expect(key).not.toBeNull();
    expect(key?.byteLength).toBe(32);
    expect(stored).not.toBeNull();
  });

  test("an abort-aware keyring timeout degrades without a synchronous fallback", async () => {
    let syncReads = 0;
    setResponseContinuationKeyringFactoryForTests({
      async: () => ({
        getSecret: signal => new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("timed out")), { once: true });
        }),
        async setSecret() {},
      }),
      sync: () => ({
        getSecret() { syncReads += 1; return null; },
        setSecret() {},
      }),
    });
    expect(await getResponseContinuationKey()).toBeNull();
    expect(syncReads).toBe(0);
  }, 7_000);
});
