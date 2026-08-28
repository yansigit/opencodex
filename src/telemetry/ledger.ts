import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { computeFailureFingerprint } from "./fingerprint";
import type { FailureEvent, FailureFingerprint, LedgerRecord, RemediationStatus } from "./types";

type Stored = LedgerRecord & { occurrences: number[] };

export class TelemetryLedger {
  private readonly db: Database;

  constructor(path = join(homedir(), ".opencodex", "telemetry-issues.sqlite")) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.run("CREATE TABLE IF NOT EXISTS failure_events (fingerprint TEXT PRIMARY KEY, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, count INTEGER NOT NULL, status TEXT NOT NULL, details TEXT, occurrences TEXT NOT NULL)");
  }

  recordFailure(event: FailureEvent, windowMs: number): LedgerRecord {
    const fingerprint = computeFailureFingerprint(event);
    const timestamp = event.timestamp ?? Date.now();
    const old = this.db.query("SELECT * FROM failure_events WHERE fingerprint = ?").get(fingerprint) as Stored | null;
    const occurrences = [...(old ? JSON.parse((old as unknown as { occurrences: string }).occurrences) : []), timestamp].filter((seen) => seen >= timestamp - windowMs).sort((a, b) => a - b);
    const record: LedgerRecord = { fingerprint, firstSeen: old?.firstSeen ?? timestamp, lastSeen: timestamp, count: occurrences.length, status: old?.status ?? "monitoring", ...(old?.details ? { details: JSON.parse(old.details as unknown as string) } : {}) };
    this.db.query("INSERT INTO failure_events (fingerprint, first_seen, last_seen, count, status, details, occurrences) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(fingerprint) DO UPDATE SET first_seen=excluded.first_seen, last_seen=excluded.last_seen, count=excluded.count, status=excluded.status, details=excluded.details, occurrences=excluded.occurrences").run(fingerprint, record.firstSeen, timestamp, record.count, record.status, record.details ? JSON.stringify(record.details) : null, JSON.stringify(occurrences));
    return record;
  }

  getRecord(fingerprint: FailureFingerprint): LedgerRecord | null {
    const row = this.db.query("SELECT fingerprint, first_seen, last_seen, count, status, details FROM failure_events WHERE fingerprint = ?").get(fingerprint) as Record<string, unknown> | null;
    if (!row) return null;
    return { fingerprint: row.fingerprint as string, firstSeen: row.first_seen as number, lastSeen: row.last_seen as number, count: row.count as number, status: row.status as RemediationStatus, ...(row.details ? { details: JSON.parse(row.details as string) } : {}) };
  }

  listRecords(): LedgerRecord[] {
    return this.db.query("SELECT fingerprint, first_seen, last_seen, count, status, details FROM failure_events ORDER BY last_seen DESC").all().map(row => {
      const value = row as Record<string, unknown>;
      return { fingerprint: value.fingerprint as string, firstSeen: value.first_seen as number, lastSeen: value.last_seen as number, count: value.count as number, status: value.status as RemediationStatus, ...(value.details ? { details: JSON.parse(value.details as string) } : {}) };
    });
  }

  updateStatus(fingerprint: FailureFingerprint, status: RemediationStatus, details?: Record<string, unknown>): void {
    this.db.query("UPDATE failure_events SET status = ?, details = ? WHERE fingerprint = ?").run(status, details ? JSON.stringify(details) : null, fingerprint);
  }

  shouldDispatch(fingerprint: FailureFingerprint, threshold: number, windowMs: number): boolean {
    const row = this.db.query("SELECT status, last_seen, occurrences FROM failure_events WHERE fingerprint = ?").get(fingerprint) as { status: RemediationStatus; last_seen: number; occurrences: string } | null;
    if (!row || row.status !== "monitoring") return false;
    const count = (JSON.parse(row.occurrences) as number[]).filter((seen) => seen >= row.last_seen - windowMs).length;
    return count >= threshold;
  }

  close(): void { this.db.close(); }
}
