const MAX_ATTEMPTS = 3;
const ATTEMPT_TIMEOUT_MS = 90_000;
const RETRY_DELAY_MS = 2_000;

const TRANSIENT_ERROR =
  /(?:\b(?:408|429|5\d\d)\b|dnsresolvefailed|eai_again|econnreset|enotfound|etimedout|enetunreach|econnrefused|und_err_connect_timeout|fetch failed|socket hang up|network timeout|tls handshake timeout)/i;

export function isTransientAuditFailure(
  output: string,
  timedOut = false,
): boolean {
  if (timedOut) return true;

  return output
    .split(/\r?\n/)
    .filter((line) => line.trimStart().toLowerCase().startsWith("error:"))
    .some((line) => TRANSIENT_ERROR.test(line));
}

export interface AuditAttempt {
  exitCode: number;
  output: string;
  timedOut: boolean;
}

interface AuditProcess {
  exited: Promise<number>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  kill(signal?: number): void;
}

interface AuditAttemptOptions {
  spawn?: () => AuditProcess;
  timeoutMs?: number;
}

export async function runAttempt(
  cwd: string,
  options: AuditAttemptOptions = {},
): Promise<AuditAttempt> {
  const child = options.spawn?.() ?? Bun.spawn(
    [process.execPath, "audit", "--audit-level=high"],
    {
      cwd,
      env: { ...process.env, NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill(9);
  }, options.timeoutMs ?? ATTEMPT_TIMEOUT_MS);

  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, output: `${stdout}${stderr}`, timedOut };
  } finally {
    clearTimeout(timeout);
  }
}

interface AuditRetryOptions {
  label: string;
  cwd: string;
  run?: (cwd: string) => Promise<AuditAttempt>;
  sleep?: (milliseconds: number) => Promise<void>;
  write?: (output: string) => void;
  warn?: (message: string) => void;
  maxAttempts?: number;
}

export async function auditWithRetries({
  label,
  cwd,
  run = runAttempt,
  sleep = Bun.sleep,
  write = (output) => process.stdout.write(output),
  warn = (message) => console.warn(message),
  maxAttempts = MAX_ATTEMPTS,
}: AuditRetryOptions): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await run(cwd);
    write(result.output);

    if (result.exitCode === 0 && !result.timedOut) return;

    const transient = isTransientAuditFailure(result.output, result.timedOut);
    if (!transient || attempt === maxAttempts) {
      const reason = result.timedOut
        ? `timed out after ${ATTEMPT_TIMEOUT_MS / 1_000}s`
        : `exited with code ${result.exitCode}`;
      throw new Error(`${label} dependency audit ${reason}`);
    }

    warn(
      `${label} dependency audit hit a transient registry error; retrying (${attempt}/${maxAttempts})`,
    );
    await sleep(RETRY_DELAY_MS * attempt);
  }
}

if (import.meta.main) {
  const workspace = process.cwd();
  await auditWithRetries({ label: "root", cwd: workspace });
  await auditWithRetries({ label: "GUI", cwd: `${workspace}/gui` });
}
