"use strict";

const { execFileSync, spawnSync } = require("node:child_process");

const SHA_RE = /^[0-9a-f]{40}$/;

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function isAncestor(ancestor, descendant) {
  const result = spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant]);
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(result.stderr?.toString().trim() || "git merge-base failed");
}

function tree(commit) {
  return git(["rev-parse", `${commit}^{tree}`]);
}

function reconcilePromotionBackmerge(mainSha, devSha) {
  if (!SHA_RE.test(mainSha) || !SHA_RE.test(devSha)) throw new Error("main and dev must be full commit SHAs");
  if (isAncestor(mainSha, devSha)) return { action: "unchanged", targetSha: devSha };
  if (isAncestor(devSha, mainSha)) {
    if (tree(mainSha) !== tree(devSha)) throw new Error("main changes the verified dev tree");
    return { action: "fast-forward", targetSha: mainSha };
  }

  const parents = git(["show", "-s", "--format=%P", mainSha]).split(" ");
  if (parents.length !== 2 || !isAncestor(parents[1], devSha) || tree(mainSha) !== tree(parents[1])) {
    throw new Error("main is not an identical-tree promotion of an ancestor of dev");
  }

  const targetSha = execFileSync("git", [
    "commit-tree", tree(devSha), "-p", devSha, "-p", mainSha, "-m", "chore: sync main promotion ancestry into dev",
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "github-actions[bot]",
      GIT_AUTHOR_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
      GIT_COMMITTER_NAME: "github-actions[bot]",
      GIT_COMMITTER_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
    },
  }).trim();
  if (git(["show", "-s", "--format=%P", targetSha]) !== `${devSha} ${mainSha}` || tree(targetSha) !== tree(devSha)) {
    throw new Error("generated backmerge failed its parent or tree postcheck");
  }
  return { action: "merged", targetSha };
}

if (require.main === module) {
  const result = reconcilePromotionBackmerge(process.argv[2] || "", process.argv[3] || "");
  if (process.argv[4] === "--json") process.stdout.write(JSON.stringify(result));
  else process.stdout.write(`action=${result.action}\ntarget_sha=${result.targetSha}\n`);
}

module.exports = { reconcilePromotionBackmerge };
