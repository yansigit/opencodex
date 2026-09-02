#!/usr/bin/env node
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { collectDeterministicHygieneFailures, HYGIENE_FAILURE_HINTS } = require("../.github/scripts/pr-hygiene.cjs");
function sh(cmd){ return execSync(cmd, {encoding:"utf8"}).trim(); }
let base = "origin/dev";
try{ sh("git rev-parse --verify "+base); }catch{ base = "dev"; }
let statusOut="";
try{ statusOut = sh("git diff --name-status --diff-filter=ACMRT "+base+"...HEAD"); }catch{ /* fallback */ }
if(!statusOut) try{ statusOut = sh("git diff --name-status --diff-filter=ACMRT "+base); }catch{ /* fallback */ }
const files=[];
for(const line of (statusOut||"").split("\n").filter(Boolean)){
  const parts=line.split("\t");
  const stat=parts[0];
  let filename, prev;
  if(stat.startsWith("R")){ prev=parts[1]; filename=parts[2]; }
  else{ filename=parts[1] ?? parts[0].slice(1).trim(); }
  let patch="";
  try{ patch=execSync("git diff -U0 "+base+"...HEAD -- "+JSON.stringify(filename), {encoding:"utf8", maxBuffer:10*1024*1024}).toString(); if(!patch) patch=execSync("git diff -U0 "+base+" -- "+JSON.stringify(filename), {encoding:"utf8", maxBuffer:10*1024*1024}).toString(); }catch{ /* fallback */ }
  const e={filename, patch};
  if(prev) e.previous_filename=prev;
  files.push(e);
}
// include untracked files (new test not yet staged) so local check is not blind
try{
  const untracked = sh("git ls-files --others --exclude-standard");
  for(const f of untracked.split("\n").filter(Boolean)){
    if(files.some(x=>x.filename===f)) continue;
    // synthesize file entry; patch empty but filename drives behavior/test path checks
    // for new test files, empty patch still counts as testsChanged (isTestPath on filename)
    // for behavior files untracked, patch empty would be comment-only false, but we treat as behavior change
    files.push({filename:f, patch:"@@ -0,0 +1 @@\n+new file"});
  }
}catch{ /* fallback */ }
if(files.length===0){ console.log("check:hygiene \u2014 no changes vs "+base); process.exit(0); }
const failures=collectDeterministicHygieneFailures({files, labels:[], authorHasPushPermission:true});
if(failures.length===0){ console.log("check:hygiene \u2014 ok"); process.exit(0); }
console.error("check:hygiene \u2014 failed:");
for(const f of failures){ const h=HYGIENE_FAILURE_HINTS[f.code]??f.code; console.error("- "+f.code+": "+h+(f.paths?" ("+f.paths.join(", ")+")":"")); }
console.error("\nFix: add test under tests/ or label test-exception-approved. Local: bun run check:hygiene");
process.exit(1);
