import { TelemetryLedger } from "../telemetry/ledger";
import type { OcxConfig } from "../types";

export function runTelemetryCommand(args: string[], config: OcxConfig): number {
  if (args[0] !== "status") {
    console.error("Usage: ocx telemetry status");
    return 1;
  }
  const ledger = new TelemetryLedger();
  try {
    const records = ledger.listRecords();
    console.log(`Telemetry failures: ${records.length}`);
    for (const record of records) {
      console.log(`${record.fingerprint}  ${record.status}  count=${record.count}  lastSeen=${new Date(record.lastSeen).toISOString()}`);
    }
    if ((config as OcxConfig & { autonomousRemediation?: { enabled?: boolean; instanceId?: string } }).autonomousRemediation?.enabled === true) {
      console.log("Autonomous remediation: enabled");
    } else {
      console.log("Autonomous remediation: disabled");
    }
    return 0;
  } finally {
    ledger.close();
  }
}
