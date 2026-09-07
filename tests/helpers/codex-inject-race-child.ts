/**
 * A real second process that reaches the lock THROUGH `injectCodexConfig`.
 *
 * The existing lock child calls `withCodexWriteLock` directly with a fabricated
 * admission, which proves N and nothing about production. This one runs the
 * actual injection, so what it proves is that the production edge is the thing
 * contending.
 *
 * Prints exactly one JSON line so the parent asserts on a typed result rather
 * than scraping logs.
 */
import { injectCodexConfig } from "../../src/codex/inject";
import { readConfigDiagnostics } from "../../src/config";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests } from "../../src/lib/windows-secret-acl";

const payload = JSON.parse(process.env.OCX_INJECT_RACE_PAYLOAD ?? "{}") as {
  port?: number;
  lockTimeoutMs?: number;
};

const ICACLS_OK = { success: true, exitCode: 0, timedOut: false, stdout: "" };
setIcaclsRunnerForTests(() => ICACLS_OK);
setAsyncIcaclsRunnerForTests(async () => ICACLS_OK);

try {
  // The real caller passes the persisted config; a child that invented `{}` could
  // not exercise settings the parent seeded — syncResumeHistory among them.
  const persisted = readConfigDiagnostics();
  const config = persisted.source === "file" ? persisted.config : {};

  const result = await injectCodexConfig(payload.port ?? 10100, config, {
    lockTimeoutMs: payload.lockTimeoutMs ?? 0,
  });

  await flushConfigDirHardeningForTests();
  console.log(JSON.stringify({
    success: result.success,
    status: result.status,
    retryable: (result as { retryable?: boolean }).retryable ?? false,
    message: result.message.slice(0, 200),
  }));
} finally {
  await flushConfigDirHardeningForTests();
  setIcaclsRunnerForTests(null);
  setAsyncIcaclsRunnerForTests(null);
}
