const FORK_PACKAGE_NAME = "@yansigit/opencodex";
const FORK_REPOSITORY = {
  type: "git",
  url: "git+https://github.com/yansigit/opencodex.git",
};
const FORK_HOMEPAGE = "https://github.com/yansigit/opencodex#readme";
const FORK_BUGS = {
  url: "https://github.com/yansigit/opencodex/issues",
};

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function validVersion(value: unknown): value is string {
  return typeof value === "string" && SEMVER.test(value);
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
  return `${JSON.stringify({
    ...current,
    ...upstream,
    name: FORK_PACKAGE_NAME,
    version,
    repository: current.repository ?? FORK_REPOSITORY,
    ...(current.homepage || upstream.homepage ? { homepage: current.homepage ?? FORK_HOMEPAGE } : {}),
    ...(current.bugs || upstream.bugs ? { bugs: current.bugs ?? FORK_BUGS } : {}),
  }, null, 2)}\n`;
}
