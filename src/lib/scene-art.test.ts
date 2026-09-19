import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createUniqueVisualSeed, hashString, renderSceneSvg } from "./scene-art.ts";

const input = {
  id: "longyan",
  name: "龙岩",
  art: "mountain",
  accent: "#45695d",
  visualSeed: 42,
} as const;
const DB_SAFE_SEED_MASK = 0x7fffffff;

function dynamicSeed(canonicalKey: string): number {
  return hashString(canonicalKey) & DB_SAFE_SEED_MASK;
}

test("same visual input renders identical svg", () => {
  assert.equal(renderSceneSvg(input), renderSceneSvg(input));
});

test("different seeds render different svg", () => {
  assert.notEqual(renderSceneSvg(input), renderSceneSvg({ ...input, visualSeed: 43 }));
});

test("generates a seed outside the used set", () => {
  const used = new Set([100, 101, 102]);
  assert.equal(used.has(createUniqueVisualSeed("龙岩|福建", used)), false);
});

test("keeps dynamic seeds within the PostgreSQL integer range", () => {
  const seed = createUniqueVisualSeed("龙岩|福建", new Set());

  assert.ok(Number.isInteger(seed));
  assert.ok(seed >= 0 && seed <= DB_SAFE_SEED_MASK, `${seed} exceeds the database-safe range`);
  assert.equal(seed, dynamicSeed("龙岩|福建"));
});

test("escapes XML markup in the title text", () => {
  const svg = renderSceneSvg({
    ...input,
    name: 'A & B </title><rect onload="x"/>',
  });

  assert.ok(svg.includes("A &amp; B &lt;/title&gt;&lt;rect onload=&quot;x&quot;/&gt; scene"));
  assert.equal(svg.includes("</title><rect"), false);
});

test("returns the 10,000th salted candidate before exhausting retries", () => {
  const canonicalKey = "boundary-key";
  const used = new Set([dynamicSeed(canonicalKey)]);
  for (let retry = 1; retry <= 9_999; retry += 1) {
    used.add(dynamicSeed(`${canonicalKey}:${retry}`));
  }

  assert.equal(createUniqueVisualSeed(canonicalKey, used), dynamicSeed(`${canonicalKey}:10000`));
});

test("throws after all 10,000 salted retries are exhausted", () => {
  const canonicalKey = "exhausted-key";
  const used = new Set([dynamicSeed(canonicalKey)]);
  for (let retry = 1; retry <= 10_000; retry += 1) {
    used.add(dynamicSeed(`${canonicalKey}:${retry}`));
  }

  assert.throws(() => createUniqueVisualSeed(canonicalKey, used), /无法分配唯一视觉种子/);
});

test("renders at least 100 distinct canonical keys with unique seeds and svg hashes", () => {
  const usedSeeds = new Set<number>();
  const renderedHashes = new Set<string>();
  const arts = ["mountain", "lake", "temple"] as const;

  for (let index = 0; index < 100; index += 1) {
    const canonicalKey = `动态地点-${index}|测试地区-${index}`;
    const visualSeed = createUniqueVisualSeed(canonicalKey, usedSeeds);
    usedSeeds.add(visualSeed);
    const svg = renderSceneSvg({
      id: `dynamic-${index}`,
      name: `动态地点${index}`,
      art: arts[index % arts.length],
      accent: "#45695d",
      visualSeed,
    });
    renderedHashes.add(createHash("sha256").update(svg).digest("hex"));
  }

  assert.equal(usedSeeds.size, 100);
  assert.equal(renderedHashes.size, 100);
});
