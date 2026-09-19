import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { sceneDestinations } from "../data/scene-catalog.ts";

const regions = [
  "北京", "天津", "河北", "山西", "内蒙古", "辽宁", "吉林", "黑龙江", "上海",
  "江苏", "浙江", "安徽", "福建", "江西", "山东", "河南", "湖北", "湖南",
  "广东", "广西", "海南", "重庆", "四川", "贵州", "云南", "西藏", "陕西",
  "甘肃", "青海", "宁夏", "新疆", "香港", "澳门", "台湾",
];

const hotRegions = [
  "北京", "江苏", "浙江", "安徽", "福建", "山东", "河南", "湖北", "湖南",
  "广东", "广西", "海南", "重庆", "四川", "贵州", "云南", "陕西", "甘肃",
  "青海", "新疆",
];

test("every provincial-level region has at least two local scene destinations", () => {
  const counts = new Map<string, number>();
  for (const destination of sceneDestinations) {
    counts.set(destination.region, (counts.get(destination.region) ?? 0) + 1);
  }
  for (const region of regions) {
    assert.ok((counts.get(region) ?? 0) >= 2, `${region} has fewer than two destinations`);
  }
});

test("hot travel regions provide extra destination depth", () => {
  const counts = new Map<string, number>();
  for (const destination of sceneDestinations) {
    counts.set(destination.region, (counts.get(destination.region) ?? 0) + 1);
  }
  for (const region of hotRegions) {
    assert.ok((counts.get(region) ?? 0) >= 3, `${region} has fewer than three destinations`);
  }
});

test("scene ids are unique", () => {
  assert.equal(new Set(sceneDestinations.map((destination) => destination.id)).size, sceneDestinations.length);
});

test("every generated scene has a unique visual structure", () => {
  const seen = new Map<string, string>();
  for (const destination of sceneDestinations) {
    const svg = readFileSync(
      join(process.cwd(), "public", destination.scene.replace(/^\//, "")),
      "utf8",
    ).replace(/<title[^>]*>.*?<\/title>/s, "");
    const hash = createHash("sha256").update(svg).digest("hex");
    const duplicate = seen.get(hash);
    assert.equal(duplicate, undefined, `${destination.name} duplicates ${duplicate ?? "another scene"}`);
    seen.set(hash, destination.name);
  }
});
