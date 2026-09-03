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

export function registryHash(env: Record<string, string | undefined> = process.env): string {
  try {
    const currentPath = registryPath();
    const path = existsSync(currentPath) ? currentPath : resolvedRegistryPath(env);
    if (!existsSync(path)) return "missing";
    const data = readFileSync(path, "utf8");
    return createHash("sha256").update(data).digest("hex");
  } catch {
    return "error";
  }
}

export function loadRegistry(env: Record<string, string | undefined> = process.env): PreservationRegistry {
  const trustedPath = env.FORK_SYNC_TRUSTED_REGISTRY;
  const currentPath = registryPath();

  if (trustedPath && existsSync(trustedPath)) {
    const trustedRaw = readFileSync(trustedPath, "utf8");
    const trustedRegistry = JSON.parse(trustedRaw) as PreservationRegistry;
    validateRegistry(trustedRegistry);

    if (existsSync(currentPath)) {
      const currentRaw = readFileSync(currentPath, "utf8");
      const candidate = JSON.parse(currentRaw) as PreservationRegistry;
      validateRegistryTransition(trustedRegistry, candidate);
      return candidate;
    }
    return trustedRegistry;
  }

  const path = resolvedRegistryPath();
  if (!existsSync(path)) throw new Error(`preservation registry missing at ${path}`);
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as PreservationRegistry;
  validateRegistry(parsed);
  return parsed;
}

export function validateRegistryTransition(
  trustedBase: PreservationRegistry,
  candidate: PreservationRegistry,
  targetTag?: string,
): void {
  validateRegistry(candidate);

  if (candidate.version !== trustedBase.version) {
    throw new Error(`candidate registry version ${String(candidate.version)} does not match trusted base ${String(trustedBase.version)}`);
  }
  if (candidate.auditStart !== trustedBase.auditStart) {
    throw new Error("candidate registry auditStart does not match trusted base");
  }

  // Baseline features must remain identical to trusted base
  const trustedFeatures = trustedBase.baseline?.features ?? {};
  const candidateFeatures = candidate.baseline?.features ?? {};
  const trustedKeys = Object.keys(trustedFeatures).sort();
  const candidateKeys = Object.keys(candidateFeatures).sort();
  if (JSON.stringify(trustedKeys) !== JSON.stringify(candidateKeys)) {
    throw new Error("candidate registry baseline features do not match trusted base");
  }
  for (const key of trustedKeys) {
    if (JSON.stringify(trustedFeatures[key]) !== JSON.stringify(candidateFeatures[key])) {
      throw new Error(`candidate registry modified trusted baseline feature: ${key}`);
    }
  }

  // All historical releases in trusted base must remain identical
  for (const [releaseTag, trustedEntry] of Object.entries(trustedBase.releases)) {
    const candidateEntry = candidate.releases[releaseTag];
    if (!candidateEntry) {
      throw new Error(`candidate registry removed historical release: ${releaseTag}`);
    }
    if (JSON.stringify(trustedEntry) !== JSON.stringify(candidateEntry)) {
      throw new Error(`candidate registry modified historical release: ${releaseTag}`);
    }
  }

  // New releases introduced by sync PR: at most 1, matching targetTag if provided
  const newReleases = Object.keys(candidate.releases)
    .filter(rel => !(rel in trustedBase.releases));
  if (newReleases.length > 1) {
    throw new Error(`candidate registry introduces multiple new releases: ${newReleases.join(", ")}`);
  }
  if (newReleases.length === 1) {
    const newTag = newReleases[0]!;
    if (targetTag && newTag !== targetTag) {
      throw new Error(`candidate registry introduces release ${newTag}, expected ${targetTag}`);
    }
    const entry = candidate.releases[newTag]!;
    if (entry.tag !== newTag) {
      throw new Error(`release tag ${entry.tag} does not match release key ${newTag}`);
    }
    if (!/^[0-9a-fA-F]{40}$/.test(entry.tagSha)) {
      throw new Error(`release ${newTag} tagSha is malformed`);
    }
    if (!/^[0-9a-fA-F]{40}$/.test(entry.baseSha)) {
      throw new Error(`release ${newTag} baseSha is malformed`);
    }
  } else if (targetTag && !(targetTag in trustedBase.releases)) {
    throw new Error(`release ${targetTag} not found in candidate registry`);
  }
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
