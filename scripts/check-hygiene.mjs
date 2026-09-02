#!/usr/bin/env node
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { collectDeterministicHygieneFailures, HYGIENE_FAILURE_HINTS } = require("../.github/scripts/pr-hygiene.cjs");
function sh(cmd){ return execSync(cmd, {encoding:"utf8"}).trim(); }
let base = "origin/dev";
try{ sh("git rev-parse --verify "+base); }catch{ base = "dev"; }
let comparisonBase=base;
try{ comparisonBase=sh("git merge-base "+base+" HEAD"); }catch{ /* compare directly when no merge base exists */ }
let statusOut="";
try{ statusOut = sh("git diff --name-status --diff-filter=ACMRT "+comparisonBase); }catch{ /* fallback */ }
const files=[];
for(const line of (statusOut||"").split("\n").filter(Boolean)){
  const parts=line.split("\t");
  const stat=parts[0];
  let filename, prev;
  if(stat.startsWith("R")){ prev=parts[1]; filename=parts[2]; }
  else{ filename=parts[1] ?? parts[0].slice(1).trim(); }
  let patch="";
  try{ patch=execSync("git diff -U0 "+comparisonBase+" -- "+JSON.stringify(filename), {encoding:"utf8", maxBuffer:10*1024*1024}).toString(); }catch{ /* fallback */ }
  const e={filename, patch};
  if(prev) e.previous_filename=prev;
  files.push(e);
}
// include untracked files (new test not yet staged) so local check is not blind
try{
  const untracked = sh("git ls-files --others --exclude-standard");
  for(const f of untracked.split("\n").filter(Boolean)){
    if(files.some(x=>x.filename===f)) continue;
    // Represent every untracked line as added so content policies (empty catches,
    // suppressions, focused tests) see exactly what the remote PR diff will see.
    // A non-text file still participates in path-based hygiene checks.
    let patch="@@ -0,0 +1 @@\n+new binary file";
    try{
      const contents=readFileSync(f,"utf8").replace(/\r\n/g,"\n");
      const lines=contents.split("\n");
      patch="@@ -0,0 +1,"+lines.length+" @@\n"+lines.map(line=>"+"+line).join("\n");
    }catch{ /* binary or concurrently removed untracked file */ }
    files.push({filename:f, patch});
  }
}catch{ /* fallback */ }
if(files.length===0){ console.log("check:hygiene \u2014 no changes vs "+base); process.exit(0); }
const failures=collectDeterministicHygieneFailures({files, labels:[], authorHasPushPermission:true});
if(failures.length===0){ console.log("check:hygiene \u2014 ok"); process.exit(0); }
console.error("check:hygiene \u2014 failed:");
for(const f of failures){ const h=HYGIENE_FAILURE_HINTS[f.code]??f.code; console.error("- "+f.code+": "+h+(f.paths?" ("+f.paths.join(", ")+")":"")); }
console.error("\nFix: add test under tests/ or label test-exception-approved. Local: bun run check:hygiene");
process.exit(1);
