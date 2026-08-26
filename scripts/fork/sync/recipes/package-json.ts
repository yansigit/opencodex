const FORK_PACKAGE_NAME = "@yansigit/opencodex";
const FORK_REPOSITORY = {
  type: "git",
  url: "git+https://github.com/yansigit/opencodex.git",
};
const FORK_HOMEPAGE = "https://github.com/yansigit/opencodex#readme";
const FORK_BUGS = {
  url: "https://github.com/yansigit/opencodex/issues",
};

export function mergePackageJson(ours: string, theirs: string): string {
  const current = JSON.parse(ours) as Record<string, unknown>;
  const upstream = JSON.parse(theirs) as Record<string, unknown>;
  const version = typeof upstream.version === "string" && upstream.version.length > 0
    ? upstream.version
    : current.version;
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("fork package.json must contain a version");
  }
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
