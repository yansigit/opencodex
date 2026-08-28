import type { LedgerRecord } from "./types";

export type GhCommandRunner = (args: string[]) => Promise<string>;

export interface AutonomousRemediationConfig {
  autonomousRemediation?: { enabled?: boolean; instanceId?: string };
}

export type DispatchResult =
  | { status: "skipped"; reason: "unauthorized" | "invalid-record" }
  | { status: "dispatched"; issueNumber?: number; issueUrl?: string; existing: boolean };

const defaultRunner: GhCommandRunner = async args => {
  const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  return await new Response(proc.stdout).text();
};

export async function dispatchAutonomousFix(
  record: LedgerRecord,
  config: AutonomousRemediationConfig,
  run: GhCommandRunner = defaultRunner,
): Promise<DispatchResult> {
  const authorization = config.autonomousRemediation;
  const eventInstance = typeof record.details?.instanceId === "string" ? record.details.instanceId : undefined;
  if (authorization?.enabled !== true || !authorization.instanceId || (eventInstance !== undefined && eventInstance !== authorization.instanceId)) {
    return { status: "skipped", reason: "unauthorized" };
  }
  if (!record.fingerprint) return { status: "skipped", reason: "invalid-record" };

  const search = await run(["issue", "list", "--repo", "yansigit/opencodex", "--state", "open", "--search", `fingerprint:${record.fingerprint}`]);
  const existing = search.match(/(?:^|\D)(\d+)(?:\D|$)/);
  if (existing) {
    const issueNumber = Number(existing[1]);
    return { status: "dispatched", issueNumber, existing: true };
  }

  const metadata = { fingerprint: record.fingerprint, instanceId: authorization.instanceId, firstSeen: record.firstSeen, lastSeen: record.lastSeen, count: record.count, ...(record.details ?? {}) };
  const body = `<!-- opencodex-failure-telemetry ${JSON.stringify(metadata)} -->\n\nFailure fingerprint: ${record.fingerprint}\n\nThis issue was dispatched by the verified local telemetry instance.`;
  const title = `Autonomous fix: ${String(record.details?.failureKind ?? "failure")} (${record.fingerprint})`;
  const created = await run(["issue", "create", "--repo", "yansigit/opencodex", "--title", title, "--body", body, "--label", "agent:jules,autonomous-fix,instance:verified"]);
  const url = created.match(/https?:\/\/\S+/)?.[0];
  const issueNumber = url?.match(/\/issues\/(\d+)/)?.[1];
  return { status: "dispatched", existing: false, ...(url ? { issueUrl: url } : {}), ...(issueNumber ? { issueNumber: Number(issueNumber) } : {}) };
}
