import { createHash } from "node:crypto";
import type { TripDay, TripPlan } from "./travel-plan.ts";
import {
  buildDaySummaryWithDeepSeek,
  type DaySummary,
  type DeepSeekTravelDeps,
} from "./travel-plan.server.ts";

/** 同时问 DeepSeek 的自然日上限，避免长行程一次打出十几个并发请求。 */
const NARRATIVE_CONCURRENCY = 3;
const MAX_CACHE_ENTRIES = 300;

/**
 * 每日文案缓存：键是同一天最终排程的内容哈希。
 *
 * 路书会被预览和 PDF 导出各渲染一次，行程没变就不该重复付费。
 */
const narrativeCache = new Map<string, DaySummary>();

export function dayNarrativeKey(plan: TripPlan, day: TripDay): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        title: plan.meta.title,
        date: day.date,
        weather: day.weather ?? null,
        pace: plan.meta.pace,
        travelers: plan.meta.travelers,
        interests: plan.meta.interests,
        nodes: day.nodes.map((node) => [node.type, node.name, node.timeLabel, node.estimatedCost]),
      }),
    )
    .digest("hex");
}

export function clearNarrativeCache(): void {
  narrativeCache.clear();
}

function rememberSummary(key: string, summary: DaySummary): void {
  if (narrativeCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = narrativeCache.keys().next().value;
    if (oldest) narrativeCache.delete(oldest);
  }
  narrativeCache.set(key, summary);
}

async function summarizeDay(
  plan: TripPlan,
  day: TripDay,
  index: number,
  deps: DeepSeekTravelDeps,
): Promise<DaySummary | null> {
  const key = dayNarrativeKey(plan, day);
  const cached = narrativeCache.get(key);
  if (cached) return cached;

  try {
    const summary = await buildDaySummaryWithDeepSeek(
      {
        day,
        dayNumber: index + 1,
        date: day.date,
        destination: plan.meta.destination,
        origin: plan.meta.origin,
        routeNodes: [plan.meta.origin, ...plan.meta.waypoints, plan.meta.destination],
        attractions: day.nodes
          .filter((node) => node.type === "attraction" || node.type === "night-activity")
          .map((node) => node.name),
        weather: day.weather,
        travelers: plan.meta.travelers,
        pace: plan.meta.pace,
        interests: plan.meta.interests,
      },
      deps,
    );
    rememberSummary(key, summary);
    return summary;
  } catch {
    // DeepSeek 不可用时保留本地排程文案，路书本身照常生成。
    return null;
  }
}

function applySummary(day: TripDay, summary: DaySummary | null): TripDay {
  if (!summary) return day;
  // 只替换文字：时间轴节点、费用、地图与日期一律以最终排程为准。
  return {
    ...day,
    purpose: summary.purpose,
    highlights: summary.highlights,
    cautions: summary.cautions,
  };
}

/** 按并发上限依次推进，保持输入顺序。 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (index >= items.length || item === undefined) return;
      results[index] = await run(item, index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * 用 DeepSeek 重写每天的旅行信息与分析（今日目的、核心重点、注意事项）。
 *
 * 输入是**已经排好的最终时间轴**，所以文案描述的就是用户真正会走的路线；
 * 单日失败只保留该日的本地文案，不影响路书其余部分。
 */
/**
 * 判断该计划是否以管家 dayCopy 为叙述权威源。
 * 管家文案已在骨架定稿后按天生成，legacy enrichment 的任何二次改写都会
 * 丢弃 dayCopy、违反 token 预算并抹掉 analysisFailed 留痕。
 */
export function isButlerNarrativePlan(plan: TripPlan): boolean {
  return plan.meta.narrativeSource === "butler";
}

const FAILED_DAY_CAUTION = "本页分析未能生成，已改用基础行程与本地提示。";
const GENERIC_HIGHLIGHT_LABELS = new Set(["交通", "用餐", "午餐", "晚餐", "住宿", "酒店", "休息", "路线", "天气", "预算", "体力", "节奏", "自由活动"]);

function normalizeNarrativeLabel(value: string): string {
  return value.trim().replace(/\s+/g, "").toLowerCase();
}

export function validateDayNarrative(
  day: TripDay,
  index: number,
  options: { allowAnalysisFailure?: boolean; knownAttractions?: readonly string[] } = {},
): void {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error("每日文案索引非法");
  }
  if (!day.purpose.trim()) {
    throw new Error(`第 ${index + 1} 天文案缺少今日目的`);
  }
  if (day.analysisFailed && !options.allowAnalysisFailure) {
    throw new Error(`第 ${index + 1} 天文案已标记失败`);
  }

  const attractions = new Set(
    day.nodes
      .filter((node) => node.type === "attraction" || node.type === "night-activity")
      .map((node) => normalizeNarrativeLabel(node.name)),
  );

  const historySourceTexts = (day.history ?? []).map((entry) => {
    try {
      const source = new URL(entry.source);
      return [
        entry.source,
        decodeURIComponent(entry.source),
        decodeURIComponent(source.host),
        decodeURIComponent(source.pathname + source.search + source.hash),
      ].join(" ");
    } catch {
      return entry.source;
    }
  });
  const historyDisplayTexts = (day.history ?? []).flatMap((entry) => [
    entry.title,
    entry.background,
  ]);
  const historyTexts = [...historyDisplayTexts, ...historySourceTexts];
  for (const text of [
    day.theme,
    ...day.highlights,
    ...day.cautions,
    day.purpose,
    ...historyDisplayTexts,
  ]) {
    if (/https?:\/\/|<[^>]+>/i.test(text)) {
      throw new Error(`第 ${index + 1} 天文案包含 URL 或 HTML`);
    }
  }
  if (historySourceTexts.some((text) => /<[^>]+>/i.test(text))) {
    throw new Error(`第 ${index + 1} 天历史来源包含 HTML`);
  }
  for (const entry of day.history ?? []) {
    const source = (entry.source ?? "").trim();
    if (!source) {
      throw new Error(`第 ${index + 1} 天历史背景缺少来源说明`);
    }
    // 允许「景区官方介绍」「地方志」这类说明性来源：强制 URL 会让模型干脆不写历史背景。
    // 一旦写成链接，就必须是 http(s)。
    if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(source)) {
      let parsed: URL;
      try {
        parsed = new URL(source);
      } catch {
        throw new Error(`第 ${index + 1} 天历史来源不是有效 URL`);
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(`第 ${index + 1} 天历史来源协议不安全`);
      }
    }
  }

  const normalizedTexts = [
    day.theme,
    ...day.highlights,
    ...day.cautions,
    day.purpose,
    ...historyTexts,
  ].map(normalizeNarrativeLabel);
  // 交通节点天然会写「桂林 → 布达拉宫」，这是路线而不是排入的景点；
  // 不排除就会把交通日文案误判成"提到未安排的景点"，连降级文案都过不了校验。
  const transportTexts = day.nodes
    .filter((node) => node.type === "transport" || node.type === "transfer")
    .flatMap((node) => [node.name, node.location ?? ""])
    .map(normalizeNarrativeLabel)
    .filter((value) => value.length > 0);
  for (const knownAttraction of options.knownAttractions ?? []) {
    const normalizedKnown = normalizeNarrativeLabel(knownAttraction);
    if (!normalizedKnown) continue;
    const scheduledToday = [...attractions].some(
      (scheduled) => scheduled.includes(normalizedKnown) || normalizedKnown.includes(scheduled),
    );
    if (scheduledToday) continue;
    if (transportTexts.some((value) => value.includes(normalizedKnown))) continue;
    if (normalizedTexts.some((text) => text.includes(normalizedKnown))) {
      throw new Error(`第 ${index + 1} 天摘要提到当天未安排的景点：${knownAttraction}`);
    }
  }

  for (const highlight of day.highlights) {
    if (!/[：:]/u.test(highlight)) continue;
    const label = highlight.split(/[：:]/u, 1)[0]?.trim();
    if (!label) continue;
    const normalized = normalizeNarrativeLabel(label);
    const generic = GENERIC_HIGHLIGHT_LABELS.has(normalized) || /^第\d+天$/u.test(normalized);
    if (!generic && !attractions.has(normalized)) {
      throw new Error(`第 ${index + 1} 天摘要包含当天未安排的景点：${label}`);
    }
  }
}

export function buildFallbackDayTheme(day: TripDay): string {
  const attractionNames = day.nodes
    .filter((node) => node.type === "attraction" || node.type === "night-activity")
    .map((node) => node.name.trim())
    .filter(Boolean);
  if (attractionNames.length > 0) return attractionNames.slice(0, 2).join(" · ");
  const transportNode = day.nodes.find((node) => node.type === "transport" || node.type === "transfer");
  if (transportNode) {
    const routeName = transportNode.name.split("·")[0]?.trim();
    return routeName ? `交通移动 · ${routeName}` : "交通移动";
  }
  return "周边漫步与休整";
}
export function buildFallbackDayNarrative(day: TripDay, index: number): TripDay {
  // 已经带失败留痕的本地安全文案原样保留，避免预览第二次改写用户已看到的说明。
  if (day.analysisFailed) {
    return {
      ...day,
      theme: buildFallbackDayTheme(day),
      cautions: day.cautions.includes(FAILED_DAY_CAUTION)
        ? day.cautions
        : [FAILED_DAY_CAUTION, ...day.cautions],
      history: [],
    };
  }

  const attractionNames = day.nodes
    .filter((node) => node.type === "attraction" || node.type === "night-activity")
    .map((node) => node.name);
  return {
    ...day,
    theme: buildFallbackDayTheme(day),
    purpose: `第 ${index + 1} 天：按已冻结排程继续行程`,
    highlights:
      attractionNames.length > 0
        ? attractionNames.slice(0, 3).map((name) => `${name}：按当天排程游览`)
        : ["自由活动：按冻结排程保留休息与机动时间"],
    cautions: [FAILED_DAY_CAUTION, "所有时间与费用以现场情况为准。"],
    history: [],
    analysisFailed: true,
  };
}

export function freezeExistingDayNarrative(day: TripDay, index: number): TripDay {
  try {
    validateDayNarrative(day, index);
    return day;
  } catch {
    return buildFallbackDayNarrative(day, index);
  }
}

export type GuidebookNarrativePreparationOptions = {
  deps?: DeepSeekTravelDeps;
  signal?: AbortSignal;
  loadDayNarrative?: (day: TripDay, dayIndex: number) => Promise<TripDay>;
  failNarrativeDay?: number;
  knownAttractions?: readonly string[];
};

/**
 * 预览、PDF 和导出的唯一文案固化入口。
 * butler 计划只校验已有文案，绝不再触发 legacy AI enrichment。
 */
export async function prepareGuidebookDayNarrative(
  plan: TripPlan,
  index: number,
  options: GuidebookNarrativePreparationOptions = {},
): Promise<TripDay> {
  const day = plan.days[index];
  if (!day) throw new Error(`第 ${index + 1} 天不存在`);
  const scheduledAttractions = plan.days.flatMap((planDay) =>
    planDay.nodes
      .filter((node) => node.type === "attraction" || node.type === "night-activity")
      .map((node) => node.name),
  );
  const knownAttractions = [
    ...(options.knownAttractions ?? []),
    ...(plan.meta.allowedAttractions ?? []),
    ...scheduledAttractions,
  ];

  let candidate = day;
  try {
    if (options.failNarrativeDay === index + 1) {
      throw new Error(`第 ${index + 1} 天强制降级`);
    }
    if (options.loadDayNarrative) {
      candidate = await options.loadDayNarrative(day, index);
    } else if (!isButlerNarrativePlan(plan)) {
      candidate = await enrichTripPlanNarrativeForDay(plan, index, {
        ...options.deps,
        ...(options.signal ? { signal: options.signal } : {}),
      });
    }
    validateDayNarrative(candidate, index, { knownAttractions });
  } catch {
    candidate = buildFallbackDayNarrative(day, index);
    validateDayNarrative(candidate, index, { allowAnalysisFailure: true, knownAttractions });
  }

  return candidate;
}

export async function prepareGuidebookNarrativePlan(
  plan: TripPlan,
  options: GuidebookNarrativePreparationOptions = {},
): Promise<TripPlan> {
  const days: TripDay[] = [];
  for (let index = 0; index < plan.days.length; index += 1) {
    days.push(await prepareGuidebookDayNarrative(plan, index, options));
  }
  return { ...plan, days };
}
/** 逐日生成并校验文案；单日失败只生成经过校验的 fallback，不阻塞后续日期。 */
export async function enrichTripPlanNarrativeForDay(
  plan: TripPlan,
  index: number,
  deps: DeepSeekTravelDeps = {},
): Promise<TripDay> {
  const day = plan.days[index];
  if (!day) throw new Error(`第 ${index + 1} 天不存在`);

  const summary = await summarizeDay(plan, day, index, deps);
  const candidate = applySummary(day, summary);
  try {
    validateDayNarrative(candidate, index);
    return candidate;
  } catch {
    return buildFallbackDayNarrative(day, index);
  }
}
export async function enrichTripPlanNarrative(
  plan: TripPlan,
  deps: DeepSeekTravelDeps = {},
): Promise<TripPlan> {
  // 管家计划跳过 legacy 二次总结：preview 与 PDF 两条路径都共用这里的守卫。
  if (isButlerNarrativePlan(plan) || plan.days.length === 0) return plan;
  const summaries = await mapWithConcurrency(plan.days, NARRATIVE_CONCURRENCY, (day, index) =>
    summarizeDay(plan, day, index, deps),
  );
  return {
    ...plan,
    days: plan.days.map((day, index) => applySummary(day, summaries[index] ?? null)),
  };
}
