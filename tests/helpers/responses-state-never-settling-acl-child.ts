import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeWithRetry } from "./remove-tree";

type Mode = "principal" | "icacls";

function rememberLarge(id: string): void {
  const text = id.repeat(1_000);
  rememberResponseState(
    { model: "test/model", input: text, store: false },
    { id, output: [{ type: "message", role: "assistant", content: text }], status: "completed" },
    undefined,
    { force: true },
  );
}

const mode = process.argv[2];
if (mode !== "principal" && mode !== "icacls") {
  throw new Error(`Unknown never-settling ACL mode: ${mode ?? "<missing>"}`);
}

const home = mkdtempSync(join(tmpdir(), "ocx-never-settling-acl-child-"));
process.env.OPENCODEX_HOME = home;

// Import state and ACL modules only after assigning the isolated home. This child is
// intentionally a fresh process: loading them first can prime path-sensitive lazy state
// from the parent's inherited OPENCODEX_HOME on Windows before the seam is installed.
const {
  clearResponseStateMemoryForTests,
  awaitResponseSpillPublicationTailForTests,
  pendingResponseSpillMetricsForTests,
  rememberResponseState,
  responseStateMetrics,
  setResponseSpillAsyncAclAttemptBudgetForTests,
  setResponseStateByteCapForTests,
} = await import("../../src/responses/state");
const {
  setAsyncIcaclsRunnerForTests,
  setPlatformForTests,
  windowsSecretAclApplies,
} = await import("../../src/lib/windows-secret-acl");
const { setAsyncWindowsPrincipalRunnerForTests } = await import("../../src/lib/windows-user-principal");

clearResponseStateMemoryForTests();
setPlatformForTests("win32");
if (!windowsSecretAclApplies()) throw new Error("Windows ACL test lane was not activated");
setResponseSpillAsyncAclAttemptBudgetForTests(100);
setResponseStateByteCapForTests(1_024);

let principalCalls = 0;
let icaclsCalls = 0;
if (mode === "principal") {
  setAsyncWindowsPrincipalRunnerForTests(() => {
    principalCalls += 1;
    return new Promise(() => {});
  });
  setAsyncIcaclsRunnerForTests(async () => {
    icaclsCalls += 1;
    return { success: true, exitCode: 0, timedOut: false, stdout: "" };
  });
} else {
  setAsyncWindowsPrincipalRunnerForTests(async () => {
    principalCalls += 1;
    return {
      success: true,
      exitCode: 0,
      timedOut: false,
      stdout: "S-1-5-21-1-2-3-1001\nocx-test\n",
    };
  });
  setAsyncIcaclsRunnerForTests(() => {
    icaclsCalls += 1;
    return new Promise(() => {});
  });
}

rememberLarge(`resp_never_settling_${mode}_first`);
rememberLarge(`resp_never_settling_${mode}_second`);
await awaitResponseSpillPublicationTailForTests();

console.log(JSON.stringify({
  settled: true,
  pending: pendingResponseSpillMetricsForTests(),
  metrics: responseStateMetrics(),
  seamCalls: { principal: principalCalls, icacls: icaclsCalls },
}));
removeTreeWithRetry(home);
