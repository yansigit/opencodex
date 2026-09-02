const FORK_PACKAGE_NAME = "@yansigit/opencodex";
const FORK_REPOSITORY = {
  type: "git",
  url: "git+https://github.com/yansigit/opencodex.git",
};
const FORK_HOMEPAGE = "https://github.com/yansigit/opencodex#readme";
const FORK_BUGS = {
  url: "https://github.com/yansigit/opencodex/issues",
};
const FORK_PRESERVED_SCRIPTS = ["test:container", "check:hygiene"] as const;
const FORK_PINNED_DEV_DEPS = ["@anthropic-ai/sdk"] as const;
const PREPUSH_HYGIENE_PREFIX = "bun run check:hygiene && ";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function validVersion(value: unknown): value is string {
  return typeof value === "string" && SEMVER.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function mergePackageJson(ours: string, theirs: string): string {
  const current = JSON.parse(ours) as Record<string, unknown>;
  const upstream = JSON.parse(theirs) as Record<string, unknown>;
  const currentVersion = validVersion(current.version) ? current.version : null;
  const upstreamVersion = validVersion(upstream.version) ? upstream.version : null;
  if (!currentVersion && !upstreamVersion) {
    throw new Error("fork package.json must contain a valid version");
  }
  const version = currentVersion && upstreamVersion
    ? Bun.semver.order(currentVersion, upstreamVersion) >= 0 ? currentVersion : upstreamVersion
    : currentVersion ?? upstreamVersion!;
  const currentScripts = isRecord(current.scripts) ? (current.scripts as Record<string, string>) : undefined;
  const upstreamScripts = isRecord(upstream.scripts) ? (upstream.scripts as Record<string, string>) : undefined;
  const currentDevDeps = isRecord(current.devDependencies) ? (current.devDependencies as Record<string, string>) : undefined;
  const upstreamDevDeps = isRecord(upstream.devDependencies) ? (upstream.devDependencies as Record<string, string>) : undefined;

  let mergedScripts: Record<string, string> | undefined;
  if (currentScripts || upstreamScripts) {
    mergedScripts = { ...(upstreamScripts ?? {}) } as Record<string, string>;
    for (const key of FORK_PRESERVED_SCRIPTS) {
      const val = currentScripts?.[key];
      if (typeof val === "string" && val.length > 0 && !mergedScripts[key]) {
        mergedScripts[key] = val;
      }
    }
    const currentPrepush = currentScripts?.prepush;
    const hasForkHygiene = typeof currentPrepush === "string" && currentPrepush.includes("check:hygiene");
    const mergedPrepush = mergedScripts.prepush;
    if (hasForkHygiene) {
      if (typeof mergedPrepush === "string" && !mergedPrepush.includes("check:hygiene")) {
        mergedScripts.prepush = `${PREPUSH_HYGIENE_PREFIX}${mergedPrepush}`;
      } else if (!mergedPrepush && typeof currentPrepush === "string") {
        mergedScripts.prepush = currentPrepush;
      }
    }
    if (Object.keys(mergedScripts).length === 0) mergedScripts = undefined;
  }

  let mergedDevDeps: Record<string, string> | undefined;
  if (currentDevDeps || upstreamDevDeps) {
    mergedDevDeps = { ...(upstreamDevDeps ?? {}) } as Record<string, string>;
    for (const key of FORK_PINNED_DEV_DEPS) {
      const val = currentDevDeps?.[key];
      if (typeof val === "string" && val.length > 0 && !mergedDevDeps[key]) {
        mergedDevDeps[key] = val;
      }
    }
    if (Object.keys(mergedDevDeps).length === 0) mergedDevDeps = undefined;
  }

  return `${JSON.stringify({
    ...current,
    ...upstream,
    name: FORK_PACKAGE_NAME,
    version,
    repository: current.repository ?? FORK_REPOSITORY,
    ...(current.homepage || upstream.homepage ? { homepage: current.homepage ?? FORK_HOMEPAGE } : {}),
    ...(current.bugs || upstream.bugs ? { bugs: current.bugs ?? FORK_BUGS } : {}),
    ...(mergedScripts ? { scripts: mergedScripts } : upstreamScripts || currentScripts ? { scripts: mergedScripts ?? upstreamScripts ?? currentScripts } : {}),
    ...(mergedDevDeps ? { devDependencies: mergedDevDeps } : upstreamDevDeps || currentDevDeps ? { devDependencies: mergedDevDeps ?? upstreamDevDeps ?? currentDevDeps } : {}),
  }, null, 2)}\n`;
}
