import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sceneDestinations } from "../src/data/scene-catalog.ts";
import { hashString, renderSceneSvg } from "../src/lib/scene-art.ts";

const outDir = join(process.cwd(), "public", "scenes", "inspirations");
mkdirSync(outDir, { recursive: true });

for (const destination of sceneDestinations) {
  const visualSeed = hashString(destination.id);
  const svg = renderSceneSvg({ id: destination.id, name: destination.name, art: destination.art, accent: destination.accent, visualSeed });
  writeFileSync(join(outDir, `${destination.id}.svg`), svg);
}

console.log(`generated ${sceneDestinations.length} province-complete inspiration scenes in ${outDir}`);