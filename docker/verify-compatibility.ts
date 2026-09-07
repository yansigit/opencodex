import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, posix, resolve } from "node:path";

// Match the canonical generator without importing any not-yet-verified source.
const REQUIRED_COMPATIBILITY_FILES = [
  ".dockerignore",
  "Dockerfile",
  "bun.lock",
  "compose.yaml",
  "docker/bootstrap-tls.ts",
  "docker/bootstrap-token.ts",
  "docker/config.json",
  "docker/healthcheck.ts",
  "docker/verify-compatibility.ts",
  "gui/bun.lock",
  "gui/package.json",
  "package.json",
  "scripts/model-metadata.source.json",
];
const MANIFEST_PATH = "src/generated/compatibility-version.json";
const BUILD_CONTEXT_ONLY_FILES = new Set([".dockerignore", "Dockerfile", "compose.yaml"]);

function isBuildContextOnly(path: string): boolean {
  // The build stage verifies every tracked GUI input before Vite derives gui/dist.
  // The runtime stage intentionally contains only that derived output, not its sources.
  return BUILD_CONTEXT_ONLY_FILES.has(path) || path.startsWith("gui/");
}

interface ManifestRow {
  path: string;
  sha256: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseRows(raw: unknown): ManifestRow[] {
  if (!record(raw) || raw.schemaVersion !== 1
    || raw.assertionDslVersion !== "1.0.0" || raw.evidenceSchemaVersion !== "1.0.0"
    || typeof raw.bunRuntimeVersion !== "string" || !raw.bunRuntimeVersion
    || !Array.isArray(raw.files) || raw.files.length === 0) {
    throw new Error("Invalid compatibility manifest schema");
  }
  const seen = new Set<string>();
  return raw.files.map((row: unknown) => {
    if (!record(row) || typeof row.path !== "string" || typeof row.sha256 !== "string"
      || !/^[0-9a-f]{64}$/.test(row.sha256)) {
      throw new Error("Invalid compatibility manifest entry");
    }
    const path = row.path;
    if (!path || /[\\\0]/.test(path) || posix.normalize(path) !== path
      || path.split("/").some(part => !part || part === "." || part === "..")
      || (!path.startsWith("src/") && !path.startsWith("docker/")
        && !path.startsWith("gui/")
        && !REQUIRED_COMPATIBILITY_FILES.includes(path))
      || path === MANIFEST_PATH) {
      throw new Error(`Invalid compatibility manifest path: ${JSON.stringify(path)}`);
    }
    if (seen.has(path)) throw new Error(`Duplicate compatibility manifest entry: ${JSON.stringify(path)}`);
    seen.add(path);
    return { path, sha256: row.sha256 };
  });
}

function regularFile(root: string, path: string): string {
  const parts = path.split("/");
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`Symlink in compatibility input: ${JSON.stringify(path)}`);
    }
    if (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory()) {
      throw new Error(`Non-regular compatibility input: ${JSON.stringify(path)}`);
    }
  }
  return current;
}

function treeFiles(root: string, path: string, label: string): string[] {
  const stat = lstatSync(join(root, path));
  if (stat.isSymbolicLink()) throw new Error(`Symlink in ${label} tree: ${JSON.stringify(path)}`);
  if (stat.isFile()) return [path];
  if (!stat.isDirectory()) throw new Error(`Non-regular ${label} entry: ${JSON.stringify(path)}`);
  return readdirSync(join(root, path)).flatMap(name => treeFiles(root, `${path}/${name}`, label));
}

/** Validate a Git-free build snapshot against the host-generated tracked-authority manifest. */
export function verifyCompatibilitySnapshot(
  snapshotRoot: string,
  options: { runtime?: boolean } = {},
): void {
  const root = resolve(snapshotRoot);
  const stat = lstatSync(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Invalid compatibility snapshot root");
  const manifestFile = regularFile(root, MANIFEST_PATH);
  const rows = parseRows(JSON.parse(readFileSync(manifestFile, "utf8")));
  const expected = new Set(rows.map(row => row.path));
  for (const required of REQUIRED_COMPATIBILITY_FILES) {
    if (!expected.has(required)) throw new Error(`Missing required manifest entry: ${required}`);
  }
  if (!rows.some(row => row.path.startsWith("src/"))) {
    throw new Error("Compatibility manifest contains no source files");
  }
  if (!rows.some(row => row.path.startsWith("gui/"))) {
    throw new Error("Compatibility manifest contains no GUI build inputs");
  }

  // Inspect the full tree, including symlinks to files/directories not named in the manifest.
  for (const path of treeFiles(root, "src", "source")) {
    if (path !== MANIFEST_PATH && !expected.has(path)) {
      throw new Error(`Source file absent from compatibility manifest: ${JSON.stringify(path)}`);
    }
  }
  for (const path of treeFiles(root, "docker", "container authority")) {
    if (!expected.has(path)) {
      throw new Error(`Container authority file absent from compatibility manifest: ${JSON.stringify(path)}`);
    }
  }
  if (!options.runtime) {
    for (const path of treeFiles(root, "gui", "GUI build input")) {
      if (!expected.has(path)) {
        throw new Error(`GUI build input absent from compatibility manifest: ${JSON.stringify(path)}`);
      }
    }
  }
  for (const row of rows) {
    if (options.runtime && isBuildContextOnly(row.path)) continue;
    const bytes = readFileSync(regularFile(root, row.path));
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== row.sha256) {
      throw new Error(`Stale compatibility manifest: hash mismatch for ${JSON.stringify(row.path)}`);
    }
  }
}

if (import.meta.main) {
  const runtime = process.argv.includes("--runtime");
  const rootArg = process.argv.slice(2).find(arg => arg !== "--runtime");
  verifyCompatibilitySnapshot(rootArg ?? resolve(import.meta.dir, ".."), { runtime });
}
