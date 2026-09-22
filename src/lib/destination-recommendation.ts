import type { InspirationDestination } from "@/lib/inspiration";

/** 排序只需要这几个用户答案，其余字段不参与。 */
export type DestinationRecommendationAnswers = {
  mood: string;
  interest?: string;
  days?: number | null;
  startDate?: string;
};

// 气质 → 标签关键词，把"我最想看什么"翻译成可排序的目的地候选。
export const MOOD_TAG_KEYWORDS: Record<string, string[]> = {
  mountain: ["山", "峰", "云海", "峡谷", "森林", "登高", "地貌", "漓江"],
  "water-town": ["古镇", "水乡", "园林", "街巷", "老街", "湖"],
  都可以: [],
  anything: [],
};

/** 需要长假的目的地：短假推它们会南辕北辙。 */
const LONG_TRIP_PATTERN =
  /新疆|西藏|青海|内蒙|稻城|喀纳斯|呼伦贝尔|可可西里|那拉提|巴音布鲁克|独库|喀拉库勒|西北/u;
const SOUTH_PATTERN = /海南|三亚|云南|广西|广东|福建|厦门|西双版纳|北海|桂林|阳朔/u;
// 港澳台属于跨境行程，默认国内游不把它们排在最前面（用户明确想要时仍会出现在列表里）。
const CROSS_BORDER_PATTERN = /台湾|香港|澳门/u;
const COOL_PATTERN = /雪|冰川|高原|东北|哈尔滨|长白山|漠河|青海|西藏|香格里拉|稻城/u;

function destinationText(destination: InspirationDestination): string {
  return [destination.name, destination.region, destination.summary, ...destination.tags]
    .join(" ")
    .toLowerCase();
}

/**
 * 给单个目的地打分：先看气质与兴趣是否命中标签，再按出发季节和行程长度微调。
 * 关键词一个都没命中时返回 -1，直接排除，避免"想看古镇却推雪山"。
 */
export function scoreDestination(
  destination: InspirationDestination,
  answers: DestinationRecommendationAnswers,
  keywords: string[],
): number {
  const haystack = destinationText(destination);
  const keywordHits = keywords.filter((keyword) => haystack.includes(keyword.toLowerCase())).length;
  if (keywords.length > 0 && keywordHits === 0) return -1;

  let score = keywordHits * 10;
  if (CROSS_BORDER_PATTERN.test(haystack)) score -= 6;
  const days = answers.days ?? 2;
  if (LONG_TRIP_PATTERN.test(haystack)) score += days >= 7 ? 3 : -4;
  else if (days >= 6) score += 1;

  const month = Number(answers.startDate?.slice(5, 7));
  if (Number.isFinite(month) && month > 0) {
    const winter = month <= 2 || month === 12;
    const summer = month >= 6 && month <= 8;
    if (winter && SOUTH_PATTERN.test(haystack)) score += 3;
    if (summer && COOL_PATTERN.test(haystack)) score += 3;
    // 夏季的南方、冬季的高寒地区体验通常偏差，轻微降权而不是排除。
    if (summer && SOUTH_PATTERN.test(haystack) && !COOL_PATTERN.test(haystack)) score -= 1;
    if (winter && COOL_PATTERN.test(haystack)) score -= 1;
  }
  return score;
}

/** 把用户答案翻成用于匹配的关键词。 */
export function recommendationKeywords(answers: DestinationRecommendationAnswers): string[] {
  const mood = answers.mood.trim();
  return [
    ...(MOOD_TAG_KEYWORDS[mood.toLowerCase()] ?? (mood ? [mood] : [])),
    ...(answers.interest?.trim() ? [answers.interest.trim()] : []),
  ].filter((keyword) => keyword.length > 0);
}

/**
 * 返回按契合度排序的目的地。
 *
 * 之前的实现是硬编码映射（奇峰与山水 + 4 天以上永远推桂林），
 * 用户反复看到同一个目的地。现在改成：气质标签匹配 + 季节与行程长度加权，
 * 同一组答案结果稳定，但不同条件会给出不同目的地。
 */
export function rankRecommendedDestinations(
  answers: DestinationRecommendationAnswers,
  catalog: readonly InspirationDestination[],
): InspirationDestination[] {
  const keywords = recommendationKeywords(answers);
  const scored = catalog.map((destination, index) => ({
    destination,
    index,
    score: scoreDestination(destination, answers, keywords),
  }));
  const matched = scored.filter((entry) => entry.score > 0);
  const pool = matched.length > 0 ? matched : scored;
  // 同分时保留目录本身的顺序（人工编排过的优先级），而不是按拼音排序。
  return pool
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((entry) => entry.destination);
}

/** 只取最契合的一个；找不到时返回 undefined，由调用方兜底。 */
export function recommendDestination(
  answers: DestinationRecommendationAnswers,
  catalog: readonly InspirationDestination[],
): InspirationDestination | undefined {
  return rankRecommendedDestinations(answers, catalog)[0];
}
