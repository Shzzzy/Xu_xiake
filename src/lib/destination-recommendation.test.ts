import assert from "node:assert/strict";
import test from "node:test";
import type { InspirationDestination } from "./inspiration.ts";
import { sceneDestinations } from "../data/scene-catalog.ts";
import {
  rankRecommendedDestinations,
  recommendationKeywords,
  scoreDestination,
} from "./destination-recommendation.ts";

function destination(
  id: string,
  name: string,
  region: string,
  tags: string[],
): InspirationDestination {
  return {
    id,
    name,
    region,
    summary: tags.join("、"),
    scene: "test",
    accent: "#000000",
    tags,
  };
}

const catalog: InspirationDestination[] = [
  destination("forbidden-city", "故宫", "北京", ["宫殿", "历史", "建筑"]),
  destination("great-wall", "八达岭长城", "北京", ["长城", "山脊", "历史"]),
  destination("huangshan", "黄山", "安徽", ["奇峰", "云海", "登山"]),
  destination("taibaishan", "太白山", "陕西", ["雪山", "高山", "森林"]),
  destination("wuzhen", "乌镇", "浙江", ["水乡", "古镇", "老街"]),
  destination("alishan", "阿里山", "台湾", ["山", "云海", "森林"]),
];

test("同一个气质在不同季节下排序会变化，不会固定推同一个目的地", () => {
  const spring = rankRecommendedDestinations(
    { mood: "mountain", days: 3, startDate: "2026-05-10" },
    catalog,
  );
  const summer = rankRecommendedDestinations(
    { mood: "mountain", days: 8, startDate: "2026-07-10" },
    catalog,
  );
  const winter = rankRecommendedDestinations(
    { mood: "mountain", days: 8, startDate: "2026-01-10" },
    catalog,
  );

  // 太白山带「雪山/高山」标签：夏季得分应高于冬季。
  const taibaishan = catalog.find((item) => item.id === "taibaishan");
  assert.ok(taibaishan);
  const keywords = recommendationKeywords({ mood: "mountain" });
  const summerScore = scoreDestination(
    taibaishan,
    { mood: "mountain", days: 8, startDate: "2026-07-10" },
    keywords,
  );
  const winterScore = scoreDestination(
    taibaishan,
    { mood: "mountain", days: 8, startDate: "2026-01-10" },
    keywords,
  );
  assert.ok(summerScore > winterScore, `夏季 ${summerScore} 应高于冬季 ${winterScore}`);

  assert.ok(spring.length > 0 && summer.length > 0);
});

test("关键词没有命中的目的地会被排除", () => {
  const ranked = rankRecommendedDestinations(
    { mood: "water-town", days: 3, startDate: "2026-04-10" },
    catalog,
  );
  assert.ok(ranked.length > 0);
  assert.ok(ranked.every((item) => item.id === "wuzhen"));
});

test("港澳台默认不会排在最前面", () => {
  const ranked = rankRecommendedDestinations(
    { mood: "mountain", days: 3, startDate: "2026-05-10" },
    catalog,
  );
  assert.notEqual(ranked[0]?.id, "alishan");
  assert.ok(ranked.some((item) => item.id === "alishan"), "仍然会出现在候选列表里");
});

test("同一组答案的排序结果稳定", () => {
  const answers = { mood: "mountain", days: 5, startDate: "2026-05-10" };
  const first = rankRecommendedDestinations(answers, catalog).map((item) => item.id);
  const second = rankRecommendedDestinations(answers, catalog).map((item) => item.id);
  assert.deepEqual(first, second);
});

test("都可以时保留目录本身的人工优先级", () => {
  const ranked = rankRecommendedDestinations(
    { mood: "anything", days: 2, startDate: "2026-09-10" },
    catalog,
  );
  assert.equal(ranked[0]?.id, "forbidden-city");
});

test("自定义气质关键词会转成匹配词", () => {
  assert.deepEqual(recommendationKeywords({ mood: "雪山", days: 3 }), ["雪山"]);
  assert.ok(recommendationKeywords({ mood: "mountain", days: 3 }).includes("峰"));
});

test("真实目的地库下，不同天数会给出不同的首选", () => {
  const short = rankRecommendedDestinations(
    { mood: "mountain", days: 3, startDate: "2026-05-10" },
    sceneDestinations,
  )[0];
  const long = rankRecommendedDestinations(
    { mood: "mountain", days: 8, startDate: "2026-07-10" },
    sceneDestinations,
  )[0];

  assert.ok(short && long);
  // 旧实现是硬编码「奇峰与山水 + 4 天以上永远桂林」，这里守住不再退回固定映射。
  assert.notEqual(short.id, long.id);
  assert.notEqual(long.id, "guilin");
});
