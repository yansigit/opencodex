import { afterEach, describe, expect, test } from "bun:test";

import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  bootstrapContainerTls,
  CONTAINER_TLS_CERT_NAME,
  CONTAINER_TLS_IDENTITY_DIR_NAME,
  CONTAINER_TLS_KEY_NAME,
  ensureContainerTls,
  type OpenSslRunner,
} from "../../docker/bootstrap-tls";
import { bootstrapToken, readBoundedToken } from "../../docker/bootstrap-token";
import { verifyCompatibilitySnapshot } from "../../docker/verify-compatibility";
import { loadServiceTokenFromFile } from "../../src/lib/service-secrets";
import {
  REQUIRED_COMPATIBILITY_FILES,
  type CompatibilityVersionManifest,
} from "../../scripts/generate-compatibility-version";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";

function input(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe("container token bootstrap", () => {
  test("accepts one trimmed token split across input chunks", async () => {
    await expect(readBoundedToken(input("  compose-", "token\n"))).resolves.toBe("compose-token");
  });

  test("accepts a maximum-size token followed by a shell newline", async () => {
    const token = "x".repeat(512);
    await expect(readBoundedToken(input(token, "\n"))).resolves.toBe(token);
  });

  test("round-trips a maximum-size bootstrap token through the startup reader", async () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-container-token-"));
    snapshotDirs.push(root);
    const previousHome = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = root;
    try {
      const token = "x".repeat(512);
      await bootstrapToken(input(token, "\n"));
      const path = join(root, "service-api-token");
      expect(lstatSync(path).size).toBe(513);
      expect(loadServiceTokenFromFile({ OCX_API_TOKEN_FILE: path })).toBe(token);
    } finally {
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
    }
  });

  test("rejects empty, multiline, and oversized input", async () => {
    await expect(readBoundedToken(input(" \n"))).rejects.toThrow("token input is empty");
    await expect(readBoundedToken(input("first\nsecond\n"))).rejects.toThrow("exactly one line");
    await expect(readBoundedToken(input("first\n\n"))).rejects.toThrow("exactly one line");
    await expect(readBoundedToken(input("\nfirst\n"))).rejects.toThrow("exactly one line");
    await expect(readBoundedToken(input("x".repeat(513), "\n"))).rejects.toThrow("exceeds 512 bytes");
  });
});

describe("container TLS bootstrap", () => {
  function fakeOpenSsl(options: { mismatch?: boolean } = {}): OpenSslRunner {
    return argv => {
      if (argv.includes("req")) {
        writeFileSync(argv[argv.indexOf("-keyout") + 1]!, "private key");
        writeFileSync(argv[argv.indexOf("-out") + 1]!, "certificate");
      }
      if (argv.includes("-pubkey")) return { exitCode: 0, stdout: "public-key\n" };
      if (argv.includes("pkey")) return { exitCode: 0, stdout: options.mismatch ? "other-key\n" : "public-key\n" };
      return { exitCode: 0, stdout: "" };
    };
  }

  test("creates an owner-only key and reuses the complete per-volume identity", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-container-tls-"));
    snapshotDirs.push(root);
    let calls = 0;
    const delegate = fakeOpenSsl();
    const run: OpenSslRunner = argv => {
      if (argv.includes("req")) calls++;
      return delegate(argv);
    };
    expect(ensureContainerTls(root, run)).toBe("created");
    expect(ensureContainerTls(root, run)).toBe("present");
    expect(calls).toBe(1);
    const identity = join(root, CONTAINER_TLS_IDENTITY_DIR_NAME);
    expect(readFileSync(join(identity, CONTAINER_TLS_CERT_NAME), "utf8")).toBe("certificate");
    expect(readFileSync(join(identity, CONTAINER_TLS_KEY_NAME), "utf8")).toBe("private key");
    if (process.platform !== "win32") {
      expect(lstatSync(root).mode & 0o777).toBe(0o700);
      expect(lstatSync(identity).mode & 0o777).toBe(0o700);
      expect(lstatSync(join(identity, CONTAINER_TLS_KEY_NAME)).mode & 0o077).toBe(0);
    }
  });

  test("refuses an incomplete pre-existing identity and a mismatched pair", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-container-tls-partial-"));
    snapshotDirs.push(root);
    const identity = join(root, CONTAINER_TLS_IDENTITY_DIR_NAME);
    mkdirSync(identity, { mode: 0o700 });
    writeFileSync(join(identity, CONTAINER_TLS_KEY_NAME), "private key", { mode: 0o600 });
    expect(() => ensureContainerTls(root, fakeOpenSsl())).toThrow("bounded regular file");
    writeFileSync(join(identity, CONTAINER_TLS_CERT_NAME), "certificate", { mode: 0o644 });
    expect(() => ensureContainerTls(root, fakeOpenSsl({ mismatch: true }))).toThrow("do not match");
  });

  test("hardens the state directory and recovers an abandoned private staging directory", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-container-tls-recovery-"));
    snapshotDirs.push(root);
    const abandoned = join(root, ".container-tls-stage-interrupted");
    mkdirSync(abandoned, { mode: 0o700 });
    writeFileSync(join(abandoned, "key.pem"), "partial", { mode: 0o600 });
    if (process.platform !== "win32") chmodSync(root, 0o777);
    expect(ensureContainerTls(root, fakeOpenSsl())).toBe("created");
    expect(existsSync(abandoned)).toBe(false);
    if (process.platform !== "win32") expect(lstatSync(root).mode & 0o777).toBe(0o700);
  });

  test.skipIf(process.platform === "win32")("refuses linked state and identity directories", () => {
    const target = mkdtempSync(join(tmpdir(), "ocx-container-tls-link-target-"));
    const parent = mkdtempSync(join(tmpdir(), "ocx-container-tls-link-parent-"));
    snapshotDirs.push(target, parent);
    const linkedState = join(parent, "state");
    symlinkSync(target, linkedState, "dir");
    expect(() => ensureContainerTls(linkedState, fakeOpenSsl())).toThrow("state path is not a regular directory");

    const identityTarget = join(parent, "identity-target");
    mkdirSync(identityTarget, { mode: 0o700 });
    symlinkSync(identityTarget, join(target, CONTAINER_TLS_IDENTITY_DIR_NAME), "dir");
    expect(() => ensureContainerTls(target, fakeOpenSsl())).toThrow("identity directory is not a regular directory");
  });

  test("migrates retained non-TLS config and derives the public origin from the host port", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-container-tls-migrate-"));
    snapshotDirs.push(root);
    const configPath = join(root, "config.json");
    writeFileSync(configPath, '{"hostname":"0.0.0.0","providers":{}}\n', { mode: 0o600 });
    const before = process.env["OPENCODEX_HOME"];
    process.env["OPENCODEX_HOME"] = root;
    try {
      expect(bootstrapContainerTls(root, configPath, { OCX_CONTAINER_PUBLIC_PORT: "10190" }, fakeOpenSsl())).toBe("created");
      expect(JSON.parse(readFileSync(configPath, "utf8"))).toMatchObject({
        hostname: "0.0.0.0",
        tls: {
          certFile: "/home/bun/.opencodex/container-tls/cert.pem",
          keyFile: "/home/bun/.opencodex/container-tls/key.pem",
          publicOrigin: "https://localhost:10190",
        },
      });
      expect(bootstrapContainerTls(root, configPath, { OCX_CONTAINER_PUBLIC_PORT: "443" }, fakeOpenSsl())).toBe("present");
      expect(JSON.parse(readFileSync(configPath, "utf8")).tls.publicOrigin).toBe("https://localhost");

      const customized = JSON.parse(readFileSync(configPath, "utf8"));
      customized.tls.publicOrigin = "https://hub.example.test";
      writeFileSync(configPath, `${JSON.stringify(customized)}\n`, { mode: 0o600 });
      expect(bootstrapContainerTls(root, configPath, { OCX_CONTAINER_PUBLIC_PORT: "10443" }, fakeOpenSsl())).toBe("present");
      expect(JSON.parse(readFileSync(configPath, "utf8")).tls.publicOrigin).toBe("https://hub.example.test");
      expect(bootstrapContainerTls(root, configPath, {
        OCX_CONTAINER_PUBLIC_PORT: "10443",
        OCX_CONTAINER_PUBLIC_ORIGIN: "https://new-hub.example.test",
      }, fakeOpenSsl())).toBe("present");
      expect(JSON.parse(readFileSync(configPath, "utf8")).tls.publicOrigin).toBe("https://new-hub.example.test");
    } finally {
      if (before === undefined) delete process.env["OPENCODEX_HOME"];
      else process.env["OPENCODEX_HOME"] = before;
    }
  });
});

describe("container deployment contract", () => {
  test("publishes only the data port with loopback and explicit bind overrides", () => {
    const compose = Bun.YAML.parse(readFileSync(repoPath("compose.yaml"), "utf8")) as {
      services: { hub: { ports: string[]; environment: Record<string, string> } };
    };
    expect(compose.services.hub.ports).toEqual([
      "${OPENCODEX_BIND_ADDRESS:-127.0.0.1}:${OPENCODEX_PORT:-10100}:10100",
    ]);
    expect(compose.services.hub.environment).toEqual({
      OCX_CONTAINER_PUBLIC_PORT: "${OPENCODEX_PORT:-10100}",
      OCX_CONTAINER_PUBLIC_ORIGIN: "${OPENCODEX_PUBLIC_ORIGIN:-}",
    });
  });

  test("requires the host-generated manifest in the runtime image", () => {
    const ignored = readFileSync(repoPath(".dockerignore"), "utf8").split(/\r?\n/);
    expect(ignored[0]).toBe("**");
    expect(ignored).toContain("!.dockerignore");
    expect(ignored).toContain("!Dockerfile");
    expect(ignored).toContain("!compose.yaml");
    expect(ignored).toContain("!src/generated/compatibility-version.json");
    expect(ignored).not.toContain("src/generated/compatibility-version.json");
    expect(ignored.some(line => /^!\/?\.git(?:\/|$)/.test(line))).toBe(false);
    expect(ignored.slice(ignored.indexOf("!scripts/"), ignored.indexOf("!scripts/") + 3)).toEqual([
      "!scripts/", "scripts/**", "!scripts/model-metadata.source.json",
    ]);
    expect(ignored).not.toContain("!scripts/**");
    expect(ignored.slice(ignored.indexOf("!docker/"), ignored.indexOf("!docker/") + 7)).toEqual([
      "!docker/",
      "docker/**",
      "!docker/bootstrap-tls.ts",
      "!docker/bootstrap-token.ts",
      "!docker/config.json",
      "!docker/healthcheck.ts",
      "!docker/verify-compatibility.ts",
    ]);
    expect(ignored).not.toContain("!docker/**");
    const lastSourceNegation = Math.max(
      ignored.indexOf("!src/**"),
      ignored.indexOf("!docker/verify-compatibility.ts"),
      ignored.indexOf("!gui/**"),
    );
    for (const sensitive of [
      "**/.git",
      "**/.tmp",
      "**/.worktrees",
      "**/.codex",
      "**/.opencode",
      "**/.planning",
      "**/.agents",
      "**/.claude",
      "**/.cursor",
      "**/.windsurf",
      "**/.ssh",
      "**/.gnupg",
      "**/.aws",
      "**/.docker/config.json",
      "**/.config/containers/auth.json",
      "**/.config/gh/hosts.yml",
      "**/.opencodex",
      "**/.env",
      "**/.env.*",
      "**/.npmrc",
      "**/.netrc",
      "**/.pypirc",
      "**/auth.json",
      "**/credentials.json",
      "**/*.pem",
      "**/*.key",
      "**/*.p12",
      "**/*.pfx",
      "**/*.jks",
      "**/*.sqlite",
      "**/*.sqlite3",
      "**/*.db",
    ]) {
      expect(ignored).toContain(sensitive);
      expect(ignored.indexOf(sensitive)).toBeGreaterThan(lastSourceNegation);
    }

    const dockerfile = readFileSync(repoPath("Dockerfile"), "utf8");
    const runtime = dockerfile.split(" AS runtime")[1];
    const containerConfig = JSON.parse(readFileSync(repoPath("docker/config.json"), "utf8"));
    expect(containerConfig).toMatchObject({ hostname: "0.0.0.0" });
    expect(containerConfig.tls).toBeUndefined();
    expect(dockerfile).toContain("RUN --mount=type=bind,target=/build-context bun /tmp/verify-compatibility.ts /build-context");
    expect(dockerfile.indexOf("RUN --mount=type=bind")).toBeLessThan(dockerfile.indexOf("COPY --chown=bun:bun src ./src"));
    expect(dockerfile).toContain("COPY --chown=bun:bun scripts/model-metadata.source.json ./scripts/model-metadata.source.json");
    expect(dockerfile).toContain("COPY --chown=bun:bun docker/bootstrap-tls.ts docker/bootstrap-token.ts docker/config.json docker/healthcheck.ts docker/verify-compatibility.ts ./docker/");
    expect(runtime).toContain("COPY --from=build --chown=bun:bun /home/bun/app/scripts/model-metadata.source.json ./scripts/model-metadata.source.json");
    expect(runtime).toContain("COPY --chown=bun:bun src/generated/compatibility-version.json ./src/generated/compatibility-version.json");
    expect(runtime).toContain('RUN ["bun", "docker/verify-compatibility.ts", "--runtime"]');
    expect(runtime).toContain("readOpenCodexCompatibilityVersion() ?? ''");
    expect(runtime).toContain("throw new Error('Missing or invalid generated compatibility manifest')");
    expect(runtime).toContain('RUN ["/usr/bin/openssl", "version"]');
    expect(runtime).toContain("bun run docker/bootstrap-tls.ts && exec bun run src/cli/index.ts start --port 10100");
    expect(runtime).toContain('CMD ["bun", "docker/healthcheck.ts"]');
  });
});

const snapshotDirs: string[] = [];
const manifestPath = "src/generated/compatibility-version.json";
const snapshotPaths = [...REQUIRED_COMPATIBILITY_FILES, "src/main.ts"];
// Independent SHA-256 test vector for the bytes "abc", not computed by the verifier.
const abcDigest = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

afterEach(() => {
  for (const dir of snapshotDirs.splice(0)) removeTreeWithRetry(dir);
});

function compatibilitySnapshot() {
  const root = mkdtempSync(join(tmpdir(), "ocx-container-identity-"));
  snapshotDirs.push(root);
  for (const path of snapshotPaths) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), "abc");
  }
  mkdirSync(join(root, "src/generated"));
  const manifest: CompatibilityVersionManifest = {
    schemaVersion: 1,
    assertionDslVersion: "1.0.0",
    evidenceSchemaVersion: "1.0.0",
    bunRuntimeVersion: "1.4.0",
    files: snapshotPaths.map(path => ({ path, sha256: abcDigest })),
  };
  const save = () => writeFileSync(join(root, manifestPath), JSON.stringify(manifest));
  save();
  return { root, manifest, save };
}

describe("container compatibility snapshot validation", () => {
  test("accepts matching bytes and the complete source set without Git metadata", () => {
    const { root } = compatibilitySnapshot();
    expect(existsSync(join(root, ".git"))).toBe(false);
    expect(() => verifyCompatibilitySnapshot(root)).not.toThrow();
  });

  test("runtime verification omits build-only authority bytes after the context verified them", () => {
    const { root } = compatibilitySnapshot();
    for (const path of [".dockerignore", "Dockerfile", "compose.yaml"]) unlinkSync(join(root, path));
    expect(() => verifyCompatibilitySnapshot(root, { runtime: true })).not.toThrow();
  });

  for (const path of snapshotPaths) {
    test(`rejects stale bytes in ${path}`, () => {
      const { root } = compatibilitySnapshot();
      writeFileSync(join(root, path), "abd"); // Same length; metadata checks are insufficient.
      expect(() => verifyCompatibilitySnapshot(root)).toThrow("hash mismatch");
    });

    test(`rejects a missing copied file: ${path}`, () => {
      const { root } = compatibilitySnapshot();
      unlinkSync(join(root, path));
      expect(() => verifyCompatibilitySnapshot(root)).toThrow();
    });
  }

  for (const path of REQUIRED_COMPATIBILITY_FILES) {
    test(`requires the authority manifest entry: ${path}`, () => {
      const { root, manifest, save } = compatibilitySnapshot();
      manifest.files = manifest.files.filter(row => row.path !== path);
      save();
      expect(() => verifyCompatibilitySnapshot(root)).toThrow("Missing required manifest entry");
    });
  }

  for (const [path, message] of [
    ["src/untracked.ts", "Source file absent from compatibility manifest"],
    ["src/generated/untracked.json", "Source file absent from compatibility manifest"],
    ["docker/extra.ts", "Container authority file absent from compatibility manifest"],
  ] as const) {
    test(`rejects an extra inventoried file: ${path}`, () => {
      const { root } = compatibilitySnapshot();
      writeFileSync(join(root, path), "abc");
      expect(() => verifyCompatibilitySnapshot(root)).toThrow(message);
    });
  }

  test("rejects a source entry missing from the manifest while other sources remain", () => {
    const { root, manifest, save } = compatibilitySnapshot();
    writeFileSync(join(root, "src/second.ts"), "abc");
    manifest.files = manifest.files.filter(row => row.path !== "src/main.ts");
    manifest.files.push({ path: "src/second.ts", sha256: abcDigest });
    save();
    expect(() => verifyCompatibilitySnapshot(root)).toThrow("Source file absent from compatibility manifest");
  });

  test("rejects an empty source inventory", () => {
    const { root, manifest, save } = compatibilitySnapshot();
    manifest.files = manifest.files.filter(row => !row.path.startsWith("src/"));
    save();
    expect(() => verifyCompatibilitySnapshot(root)).toThrow("contains no source files");
  });

  test("rejects duplicate manifest entries", () => {
    const { root, manifest, save } = compatibilitySnapshot();
    manifest.files.push({ path: "src/main.ts", sha256: abcDigest });
    save();
    expect(() => verifyCompatibilitySnapshot(root)).toThrow("Duplicate compatibility manifest entry");
  });

  for (const path of ["../outside", "/src/main.ts", "src/../package.json", "src//main.ts", "src/./main.ts", "src\\main.ts", "src/", "src/zero\0.ts", "scripts/unlisted.ts", manifestPath]) {
    test(`rejects an unsafe or out-of-authority path: ${JSON.stringify(path)}`, () => {
      const { root, manifest, save } = compatibilitySnapshot();
      manifest.files.push({ path, sha256: abcDigest });
      save();
      expect(() => verifyCompatibilitySnapshot(root)).toThrow("Invalid compatibility manifest path");
    });
  }

  for (const raw of ["not json", "null", "{}", JSON.stringify({ schemaVersion: 1, files: [] })]) {
    test(`rejects a malformed manifest: ${raw}`, () => {
      const { root } = compatibilitySnapshot();
      writeFileSync(join(root, manifestPath), raw);
      expect(() => verifyCompatibilitySnapshot(root)).toThrow();
    });
  }

  test("rejects an invalid hash", () => {
    const { root, manifest, save } = compatibilitySnapshot();
    manifest.files[0]!.sha256 = "not-a-sha256";
    save();
    expect(() => verifyCompatibilitySnapshot(root)).toThrow("Invalid compatibility manifest entry");
  });

  test("rejects a missing manifest", () => {
    const { root } = compatibilitySnapshot();
    unlinkSync(join(root, manifestPath));
    expect(() => verifyCompatibilitySnapshot(root)).toThrow();
  });

  for (const path of ["package.json", manifestPath]) {
    test(`rejects a directory in place of a required file: ${path}`, () => {
      const { root } = compatibilitySnapshot();
      unlinkSync(join(root, path));
      mkdirSync(join(root, path));
      expect(() => verifyCompatibilitySnapshot(root)).toThrow("Non-regular compatibility input");
    });
  }

  for (const path of ["src", "src/generated", "docker", "scripts"]) {
    test(`rejects a linked input directory: ${path}`, () => {
      const { root } = compatibilitySnapshot();
      const target = join(root, "linked-target");
      renameSync(join(root, path), target);
      symlinkSync(target, join(root, path), process.platform === "win32" ? "junction" : "dir");
      expect(() => verifyCompatibilitySnapshot(root)).toThrow("Symlink");
    });
  }

  test("rejects an unlisted linked source directory before following it", () => {
    const { root } = compatibilitySnapshot();
    symlinkSync(join(root, "scripts"), join(root, "src/extra"), process.platform === "win32" ? "junction" : "dir");
    expect(() => verifyCompatibilitySnapshot(root)).toThrow("Symlink");
  });

  // File symlinks require Developer Mode/admin on Windows; junction cases above run everywhere.
  for (const path of [...snapshotPaths, manifestPath]) {
    test.skipIf(process.platform === "win32")(`rejects a linked file: ${path}`, () => {
      const { root } = compatibilitySnapshot();
      const target = join(root, "linked-target");
      renameSync(join(root, path), target);
      symlinkSync(target, join(root, path), "file");
      expect(() => verifyCompatibilitySnapshot(root)).toThrow("Symlink");
    });
  }
});
