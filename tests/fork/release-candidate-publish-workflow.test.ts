import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const text = readFileSync(resolve(import.meta.dir, "../../.github/workflows/release.yml"), "utf8");

describe("release candidate publish bridge", () => {
  test("requires and validates immutable candidate provenance", () => {
    expect(text).toContain("candidate-run-id:");
    expect(text).toContain("candidate-artifact-id:");
    expect(text).toContain("candidateRunId: process.env.CANDIDATE_RUN_ID");
    expect(text).toContain("candidateArtifactId: process.env.CANDIDATE_ARTIFACT_ID");
    expect(text).toContain("actions/runs/${CANDIDATE_RUN_ID}");
    expect(text).toContain('Build release candidate');
    expect(text).toContain("actions/artifacts/${CANDIDATE_ARTIFACT_ID}");
    expect(text).toContain(".workflow_run.repository_id");
    // The workflow-run payload carries repository.full_name; the artifact
    // payload does not. Repository binding for the artifact therefore uses
    // workflow_run.repository_id, while the full-name check appears once on
    // the run itself.
    expect(text.match(/\.repository\.full_name == \$repo/g)).toHaveLength(1);
    expect(text).toContain("actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c");
    expect(text.match(/if: \$\{\{ env\.DISPATCH_CANDIDATE_RUN_ID != '' \}\}/g)).toHaveLength(3);
    expect(text).toContain('($release_tag != "latest") or (.head_branch == "main")');
    expect(text).toContain("tag: process.env.DISPATCH_TAG");
    expect(text).toContain("dryRun: process.env.DISPATCH_DRY_RUN");
  });

  test("automatic candidate publication uses only the downloaded tarball", () => {
    expect(text).toContain('npm publish "$package_file" --tag "$NPM_DIST_TAG" --access public --ignore-scripts');
    expect(text).toContain('if [ -z "$DISPATCH_CANDIDATE_RUN_ID" ]');
    expect(text).toContain('elif [ "$DRY_RUN" = "true" ]');
    expect(text).toContain("automatic main releases always consume an immutable candidate");
  });

  test("legacy releases do not resolve or download an empty candidate", () => {
    expect(text).toContain('if [ -z "$DISPATCH_CANDIDATE_RUN_ID" ] && [ "$DRY_RUN" = "true" ]');
    expect(text).toContain('if [ -z "$DISPATCH_CANDIDATE_RUN_ID" ]; then');
    expect(text).toContain('elif [ -z "$DISPATCH_CANDIDATE_RUN_ID" ]; then');
  });

  test("recovers exact npm-success metadata without publishing twice", () => {
    expect(text).toContain("release-postpublish.cjs");
    expect(text).toContain("npm view \"${pkg_name}@${RELEASE_VERSION}\" version gitHead --json");
    expect(text).toContain("PUBLISH_NEEDED: ${{ steps.release-metadata.outputs.publish-needed }}");
    expect(text).toContain("resuming post-publish metadata only");
    expect(text).toContain('gh api --method POST "repos/${GITHUB_REPOSITORY}/git/refs"');
    expect(text).not.toContain('git push origin "refs/tags/${release_tag}"');
  });
});
