"use strict";

const ALLOWED_RELEASE_REFS = new Set([
  "refs/heads/main",
  "refs/heads/preview",
  "refs/heads/dev",
]);

function validateReleaseDispatch({
  eventName,
  eventAction,
  ref,
  expectedSha,
  actualSha,
  tag,
  dryRun,
  candidateRunId,
  candidateArtifactId,
  clientPayload,
}) {
  if (eventName === "repository_dispatch") {
    if (eventAction !== "fork-auto-release") {
      return `Unsupported release repository_dispatch action: ${eventAction || "(empty)"}.`;
    }
    if (ref !== "refs/heads/main") {
      return `Automatic stable releases must run from main; got ${ref || "(empty)"}.`;
    }
    if (!clientPayload || typeof clientPayload !== "object" || Array.isArray(clientPayload)) {
      return "Automatic stable release payload must be an object.";
    }
    const expectedKeys = ["candidate_artifact_id", "candidate_run_id", "expected_sha", "tag", "version"];
    const actualKeys = Object.keys(clientPayload).sort();
    if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
      return `Automatic stable release payload must contain exactly: ${expectedKeys.join(", ")}.`;
    }
    if (clientPayload.tag !== "latest") return "Automatic stable releases must publish the latest dist-tag.";
    if (typeof clientPayload.version !== "string" || !/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/.test(clientPayload.version)) {
      return "Automatic stable release version must be stable SemVer.";
    }
    if (clientPayload.expected_sha !== expectedSha
      || clientPayload.candidate_run_id !== candidateRunId
      || clientPayload.candidate_artifact_id !== candidateArtifactId) {
      return "Automatic stable release payload does not match the normalized dispatch inputs.";
    }
  } else if (eventName !== "workflow_dispatch") {
    return `Release must be triggered by workflow_dispatch or the audited repository_dispatch; got ${eventName || "(empty)"}.`;
  }

  if (!ALLOWED_RELEASE_REFS.has(ref)) {
    return `Release must run from main, preview, or dev; got ${ref || "(empty)"}.`;
  }

  if (!expectedSha) {
    return "expected-sha is required; refusing to publish without an audited commit.";
  }

  if (eventName === "repository_dispatch" || candidateRunId || candidateArtifactId) {
    if (typeof candidateRunId !== "string" || !/^[1-9][0-9]*$/.test(candidateRunId)) {
      return "candidate-run-id is required and must be canonical decimal digits.";
    }
    if (typeof candidateArtifactId !== "string" || !/^[1-9][0-9]*$/.test(candidateArtifactId)) {
      return "candidate-artifact-id is required and must be canonical decimal digits.";
    }
  }

  if (eventName === "workflow_dispatch" && tag === "latest" && dryRun !== "true"
    && (!candidateRunId || !candidateArtifactId)) {
    return "Publishing the latest dist-tag requires immutable candidate run and artifact IDs.";
  }

  if (!/^[0-9a-f]{40}$/.test(expectedSha)) {
    return `expected-sha must be a full 40-character commit SHA; got ${expectedSha}.`;
  }

  if (actualSha !== expectedSha) {
    return (
      `branch moved after the release audit ` +
      `(expected ${expectedSha}, got ${actualSha || "(empty)"}) — ` +
      "refusing to publish an unaudited commit."
    );
  }

  return null;
}

module.exports = {
  ALLOWED_RELEASE_REFS,
  validateReleaseDispatch,
};
