import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalJson,
  encodeReleaseCandidateManifest,
  parseReleaseCandidateManifest,
  verifyReleaseCandidateManifest,
  type ReleaseCandidateManifest,
} from "../../scripts/release-candidate";

const scratch: string[] = [];

afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

function digest(bytes: string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function integrity(bytes: string): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

function fixture(packageBytes = "candidate package"): ReleaseCandidateManifest {
  return {
    schemaVersion: 1,
    source: {
      repository: "example/opencodex",
      commitSha: "a".repeat(40),
      treeSha: "b".repeat(40),
    },
    package: {
      name: "@example/opencodex",
      version: "3.0.0-preview.1",
      filename: "example-opencodex-3.0.0-preview.1.tgz",
      sha256: digest(packageBytes),
      integritySha512: integrity(packageBytes),
      sizeBytes: Buffer.byteLength(packageBytes),
    },
    inputs: [
      { path: "bun.lock", sha256: digest("root lock") },
      { path: "gui/bun.lock", sha256: digest("gui lock") },
      { path: "gui/package.json", sha256: digest("gui package") },
      { path: "package.json", sha256: digest("root package") },
    ],
    builder: {
      bunVersion: "1.4.0",
      workflow: "Build release candidate",
      runId: "123456",
      runAttempt: 1,
    },
  };
}

describe("release candidate manifest", () => {
  test("canonicalizes object keys recursively and appends one newline", () => {
    expect(canonicalJson({ z: 1, a: { y: true, x: ["ok", null] } })).toBe(
      '{"a":{"x":["ok",null],"y":true},"z":1}',
    );
    const encoded = encodeReleaseCandidateManifest(fixture());
    expect(encoded.endsWith("\n")).toBe(true);
    expect(encoded.endsWith("\n\n")).toBe(false);
    expect(parseReleaseCandidateManifest(encoded)).toEqual(fixture());
  });

  test("rejects noncanonical, extended, and unsafe manifests", () => {
    const manifest = fixture();
    const canonical = encodeReleaseCandidateManifest(manifest);
    expect(() => parseReleaseCandidateManifest(JSON.stringify(manifest))).toThrow("canonical JSON");
    expect(() => parseReleaseCandidateManifest(` ${canonical}`)).toThrow("canonical JSON");

    const extended = { ...manifest, publish: true };
    expect(() => parseReleaseCandidateManifest(`${canonicalJson(extended)}\n`)).toThrow("exactly");

    const traversal = {
      ...manifest,
      inputs: [{ path: "../bun.lock", sha256: digest("root lock") }, ...manifest.inputs.slice(1)],
    };
    expect(() => parseReleaseCandidateManifest(`${canonicalJson(traversal)}\n`)).toThrow("normalized relative POSIX");

    const invalidIntegrity = {
      ...manifest,
      package: { ...manifest.package, integritySha512: "sha512-not-an-integrity" },
    };
    expect(() => parseReleaseCandidateManifest(`${canonicalJson(invalidIntegrity)}\n`)).toThrow("SHA-512 integrity");

    const reordered = { ...manifest, inputs: [...manifest.inputs].reverse() };
    expect(() => parseReleaseCandidateManifest(`${canonicalJson(reordered)}\n`)).toThrow(/sorted by path|contain exactly/);
  });

  test("binds verification to source identity, package bytes, and inputs", () => {
    const directory = mkdtempSync(join(tmpdir(), "ocx-release-candidate-"));
    scratch.push(directory);
    const packageBytes = "candidate package";
    const packagePath = join(directory, fixture().package.filename);
    writeFileSync(packagePath, packageBytes);
    writeFileSync(join(directory, "bun.lock"), "root lock");
    const gui = join(directory, "gui");
    mkdirSync(gui);
    writeFileSync(join(gui, "bun.lock"), "gui lock");
    writeFileSync(join(gui, "package.json"), "gui package");
    writeFileSync(join(directory, "package.json"), "root package");

    const encoded = encodeReleaseCandidateManifest(fixture(packageBytes));
    expect(verifyReleaseCandidateManifest(encoded, {
      repository: "example/opencodex",
      commitSha: "a".repeat(40),
      treeSha: "b".repeat(40),
      packagePath,
      inputRoot: directory,
    }).package.sha256).toBe(digest(packageBytes));

    writeFileSync(packagePath, "mutated package");
    expect(() => verifyReleaseCandidateManifest(encoded, { packagePath })).toThrow(/size|digest/);
    expect(() => verifyReleaseCandidateManifest(encoded, { commitSha: "c".repeat(40) })).toThrow("commit SHA mismatch");
  });
});
