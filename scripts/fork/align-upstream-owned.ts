import { classifyPath } from "./sync/ownership.ts";
import { $ } from "bun";

const diffFiles = (await $`git diff --name-only vendor/main HEAD`.text()).trim().split("\n").filter(Boolean);
const vendorFiles = new Set((await $`git ls-tree -r --name-only vendor/main`.text()).trim().split("\n"));
const toVendor: string[] = [];
for (const f of diffFiles) {
  if (!vendorFiles.has(f)) continue;
  const c = classifyPath(f);
  if (c === "fork-owned" || c === "shared-hotspot" || f === "package.json") continue;
  toVendor.push(f);
}
console.log(`checking out ${toVendor.length} files`);
for (let i = 0; i < toVendor.length; i += 30) {
  const batch = toVendor.slice(i, i + 30);
  await $`git checkout vendor/main -- ${batch}`;
}
console.log("done");
