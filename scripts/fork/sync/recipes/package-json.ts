const FORK_PACKAGE_NAME = "@yansigit/opencodex";

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
  }, null, 2)}\n`;
}
