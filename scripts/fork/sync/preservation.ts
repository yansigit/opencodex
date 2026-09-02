import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";

export type PreservationDisposition = "preserve" | "upstream-equivalent" | "intentional-drop";

// Legacy per-path entry (v1) kept for compatibility
interface LegacyPreservationEntry {
  decision: PreservationDisposition;
  rationale: string;
  symbols?: string[];
  forkBlob?: string;
  upstreamBlob?: string;
  baseBlob?: string;
}

export interface BaselineFeature {
  decisionSource: string;
  ownedBehavior: string;
  integrationPaths: string[];
  requiredTests: string[];
}

export interface PerReleaseDecision {
  disposition: PreservationDisposition;
  upstreamIntent: string;
  forkInvariant: string;
  equivalentOrBetter: boolean;
  implementationEvidence: string;
  exactTests: string[];
  rationale?: string;
  symbols?: string[];
  forkBlob?: string;
  upstreamBlob?: string;
  baseBlob?: string;
}

export interface PreservationRelease {
  tag: string;
  tagSha: string;
  baseSha: string;
  decisions: Record<string, PerReleaseDecision>;
}

export interface PreservationRegistry {
  version: number;
  auditStart?: string;
  baseline?: {
    features: Record<string, BaselineFeature>;
  };
  releases: Record<string, PreservationRelease>;
}

const REGISTRY_PATH = "docs/fork/PRESERVATION.json";

const INTENTIONAL_DROP_BASELINE = new Set<string>([
]);

export function registryPath(): string {
  return REGISTRY_PATH;
}

export function resolvedRegistryPath(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.FORK_SYNC_TRUSTED_REGISTRY || REGISTRY_PATH;
}

export function registryHash(): string {
  try {
    const path = resolvedRegistryPath();
    if (!existsSync(path)) return "missing";
    const data = readFileSync(path, "utf8");
    return createHash("sha256").update(data).digest("hex");
  } catch {
    return "error";
  }
}

export function loadRegistry(): PreservationRegistry {
  const path = resolvedRegistryPath();
  if (!existsSync(path)) throw new Error(`preservation registry missing at ${path}`);
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as PreservationRegistry;
  validateRegistry(parsed);
  return parsed;
}

export function validateRegistry(registry: PreservationRegistry): void {
  if (registry.version !== 1 && registry.version !== 2) throw new Error(`unsupported registry version ${String(registry.version)}`);
  if (registry.version === 2) {
    if (!registry.baseline || !registry.baseline.features) throw new Error("baseline.features missing for v2");
    for (const [fid, feat] of Object.entries(registry.baseline.features)) {
      if (!feat.decisionSource || !feat.decisionSource.trim()) throw new Error(`baseline ${fid} missing decisionSource`);
      if (!feat.ownedBehavior || !feat.ownedBehavior.trim()) throw new Error(`baseline ${fid} missing ownedBehavior`);
      if (!Array.isArray(feat.integrationPaths) || feat.integrationPaths.length === 0) throw new Error(`baseline ${fid} missing integrationPaths`);
      if (!Array.isArray(feat.requiredTests) || feat.requiredTests.length === 0) throw new Error(`baseline ${fid} missing requiredTests`);
    }
  }
  for (const [release, entry] of Object.entries(registry.releases)) {
    if (!entry.tag || !entry.tagSha || !entry.baseSha) throw new Error(`release ${release} missing tag/tagSha/baseSha`);
    for (const [path, decision] of Object.entries(entry.decisions)) {
      // Support both legacy (decision) and new (disposition) fields
      const disp = (decision as unknown as { disposition?: string; decision?: string }).disposition ?? (decision as unknown as { decision?: string }).decision;
      if (!disp || !["preserve", "upstream-equivalent", "intentional-drop"].includes(disp)) {
        throw new Error(`invalid disposition for ${path} in ${release}: ${String(disp)}`);
      }
      if (disp === "intentional-drop" && !INTENTIONAL_DROP_BASELINE.has(path)) {
        throw new Error(`intentional-drop for ${path} not in pre-approved baseline`);
      }
      // For v2, questionnaire fields required
      if (registry.version === 2) {
        const d = decision as PerReleaseDecision;
        if (!d.upstreamIntent || !d.upstreamIntent.trim()) throw new Error(`missing upstreamIntent for ${path} in ${release}`);
        if (!d.forkInvariant || !d.forkInvariant.trim()) throw new Error(`missing forkInvariant for ${path} in ${release}`);
        if (typeof d.equivalentOrBetter !== "boolean") throw new Error(`missing equivalentOrBetter for ${path} in ${release}`);
        if (disp === "upstream-equivalent" && d.equivalentOrBetter !== true) {
          throw new Error(`upstream-equivalent for ${path} in ${release} requires equivalentOrBetter=true`);
        }
        if (!d.implementationEvidence || !d.implementationEvidence.trim()) throw new Error(`missing implementationEvidence for ${path} in ${release}`);
        if (!Array.isArray(d.exactTests) || d.exactTests.length === 0) throw new Error(`missing exactTests for ${path} in ${release}`);
      } else {
        const legacy = decision as unknown as LegacyPreservationEntry;
        if (!legacy.rationale || !legacy.rationale.trim()) throw new Error(`missing rationale for ${path} in ${release}`);
      }
    }
  }
}

export function decisionsForRelease(registry: PreservationRegistry, tag: string): Record<string, PerReleaseDecision> {
  const rel = registry.releases[tag];
  return rel ? rel.decisions : {};
}

export function baselineFeatures(registry: PreservationRegistry): Record<string, BaselineFeature> {
  return registry.baseline?.features ?? {};
}

export function decisionHash(registry: PreservationRegistry, tag: string): string {
  const decisions = registry.releases[tag]?.decisions ?? {};
  return createHash("sha256").update(JSON.stringify(decisions)).digest("hex");
}
