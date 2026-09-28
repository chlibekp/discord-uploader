// Copies dither-kit's shadcn registry items into web/src/components/dither-kit.
// Re-run to update; then re-apply both local patches, each described in its
// file header: palette.ts (indigo/cyan/gold) and grid.tsx (tickCount).
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const OUT = path.resolve("web/src/components/dither-kit");
const seen = new Set();
const npm = new Set();

async function pull(url) {
  if (seen.has(url)) return;
  seen.add(url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const item = await res.json();
  for (const dep of item.dependencies ?? []) npm.add(dep);
  for (const dep of item.registryDependencies ?? []) await pull(dep);
  for (const file of item.files ?? []) {
    const target = path.join(OUT, path.basename(file.path));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.content);
  }
}

await pull("https://tripwire.sh/r/dither-kit.json");
console.log(`Wrote ${seen.size} registry items to ${OUT}`);
console.log(`npm deps: ${[...npm].sort().join(" ")}`);
