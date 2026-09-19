import test from "node:test";
import assert from "node:assert/strict";
import {
  createInspirationCycle,
  findInspiration,
  findInspirationsByRegion,
  inspirationDestinations,
  mergeInspirationCatalog,
  type InspirationDestination,
  nextInspirationBatch,
} from "./inspiration.ts";

const ids = ["a", "b", "c", "d", "e", "f"];

test("a full cycle shows every destination before reshuffling", () => {
  let state = createInspirationCycle(ids, () => 0.25);
  const seen: string[] = [];

  for (let index = 0; index < 2; index += 1) {
    const step = nextInspirationBatch(state, 3, () => (index + 1) / 10);
    assert.equal(step.batch.length, 3);
    assert.equal(new Set(step.batch).size, 3);
    seen.push(...step.batch);
    state = step;
  }

  assert.deepEqual([...seen].sort(), [...ids].sort());
});

test("a new batch never repeats the immediately previous batch", () => {
  const state = createInspirationCycle(ids, () => 0.4);
  const first = nextInspirationBatch(state, 3, () => 0.2);
  const second = nextInspirationBatch(first, 3, () => 0.2);
  assert.equal(second.batch.some((id) => first.batch.includes(id)), false);
});

test("province names and full official region names filter inspiration destinations", () => {
  const fujian = findInspirationsByRegion("福建省");
  assert.ok(fujian.length >= 5);
  assert.ok(fujian.some((destination) => destination.id === "fujian-tulou"));
  assert.ok(fujian.every((destination) => destination.region.includes("福建")));

  const guangxi = findInspirationsByRegion("广西壮族自治区");
  assert.ok(guangxi.length >= 5);
  assert.ok(guangxi.every((destination) => destination.region.includes("广西")));
});

test("an empty region query can restore the full inspiration catalog", () => {
  assert.equal(findInspirationsByRegion("").length, inspirationDestinations.length);
  assert.ok(inspirationDestinations.length > 0);
});

test("merges dynamic inspirations after static and removes duplicate ids", () => {
  const staticItems: InspirationDestination[] = [{ id: "huangshan", name: "黄山", region: "安徽", summary: "", scene: "/a.svg", accent: "#000", tags: [], art: "mountain" }];
  const dynamicItems: InspirationDestination[] = [
    { id: "dyn-longyan", name: "龙岩", region: "福建", summary: "客家文化", scene: "data:image/svg+xml,a", accent: "#45695d", tags: ["客家文化"], art: "mountain", discovered: true },
    { id: "huangshan", name: "黄山候选", region: "安徽", summary: "", scene: "/b.svg", accent: "#111", tags: [], art: "mountain", discovered: true },
  ];
  const merged = mergeInspirationCatalog(staticItems, dynamicItems);

  assert.equal(merged.at(-1)?.name, "龙岩");
  assert.equal(merged.length, 2);
  assert.equal(merged[0]?.name, "黄山");
});

test("dynamic catalogs can be searched by id or name", () => {
  const dynamicItems: InspirationDestination[] = [{ id: "dyn-longyan", name: "龙岩", region: "福建", summary: "", scene: "/a.svg", accent: "#000", tags: [], art: "mountain" }];

  assert.equal(findInspiration("dyn-longyan", dynamicItems)?.name, "龙岩");
  assert.equal(findInspiration("龙岩", dynamicItems)?.id, "dyn-longyan");
});

test("dynamic catalogs can be filtered by region", () => {
  const dynamicItems: InspirationDestination[] = [{ id: "dyn-longyan", name: "龙岩", region: "福建省", summary: "", scene: "/a.svg", accent: "#000", tags: [], art: "mountain" }];

  assert.deepEqual(
    findInspirationsByRegion("福建", dynamicItems).map((item) => item.id),
    ["dyn-longyan"],
  );
});