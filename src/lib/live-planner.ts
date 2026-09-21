import { z } from "zod";
import type { Pace, WeatherDay } from "./planner";
import type { RoutePlan } from "./route-planner";

export type SearchResult = {
  title: string;
  url: string;
  content: string;
  score?: number;
};

export type DiscoveredStop = {
  name: string;
  region: string;
  placeType: string;
  summary: string;
  tags: string[];
  verificationStatus: "verified" | "candidate";
};

export type DiscoveredPlaceSummary = {
  canonicalName: string;
  region: string;
  placeType: string;
  summary: string;
  tags: string[];
};

export function mapDiscoveredStops(input: {
  verifiedPlaces: DiscoveredPlaceSummary[];
  candidatePlaces: DiscoveredPlaceSummary[];
}): DiscoveredStop[] {
  return [
    ...input.verifiedPlaces.map((place) => ({
      name: place.canonicalName,
      region: place.region,
      placeType: place.placeType,
      summary: place.summary,
      tags: place.tags,
      verificationStatus: "verified" as const,
    })),
    ...input.candidatePlaces.map((place) => ({
      name: place.canonicalName,
      region: place.region,
      placeType: place.placeType,
      summary: place.summary,
      tags: place.tags,
      verificationStatus: "candidate" as const,
    })),
  ];
}

export type DiscoverySourceGroup = {
  inputName: string;
  sources: SearchResult[];
};

function takeUniqueSources(
  sources: SearchResult[],
  limit: number,
  seenUrls: Set<string>,
): SearchResult[] {
  const selected: SearchResult[] = [];
  for (const source of sources) {
    if (selected.length >= limit) break;
    const url = source.url.trim();
    if (!url || seenUrls.has(url)) continue;
    seenUrls.add(url);
    selected.push({ ...source, url });
  }
  return selected;
}

/**
 * Deterministic planner source budget:
 * - destination and seed sources have reserved capacity;
 * - discovery sources fill only the remaining budget;
 * - each input place contributes at most four discovery sources.
 */
export function selectPlannerSources(input: {
  destinationSources: SearchResult[];
  seedSources: SearchResult[];
  discoverySourceGroups?: DiscoverySourceGroup[];
  maxTotal?: number;
  maxDestinationSources?: number;
  maxSeedSources?: number;
  maxDiscoverySourcesPerPlace?: number;
}): SearchResult[] {
  const maxTotal = Math.max(0, Math.floor(input.maxTotal ?? 20));
  const maxDestinationSources = Math.max(0, Math.floor(input.maxDestinationSources ?? 12));
  const maxSeedSources = Math.max(0, Math.floor(input.maxSeedSources ?? 8));
  const maxDiscoverySourcesPerPlace = Math.max(
    0,
    Math.floor(input.maxDiscoverySourcesPerPlace ?? 4),
  );
  const seenUrls = new Set<string>();
  const destination = takeUniqueSources(
    input.destinationSources,
    Math.min(maxDestinationSources, maxTotal),
    seenUrls,
  );
  const seed = takeUniqueSources(
    input.seedSources,
    Math.min(maxSeedSources, maxTotal - destination.length),
    seenUrls,
  );
  const selected = [...destination, ...seed];

  if (selected.length >= maxTotal) return selected;
  for (const group of input.discoverySourceGroups ?? []) {
    if (selected.length >= maxTotal) break;
    selected.push(
      ...takeUniqueSources(
        group.sources,
        Math.min(maxDiscoverySourcesPerPlace, maxTotal - selected.length),
        seenUrls,
      ),
    );
  }

  return selected;
}

export type GeneratedDay = {
  day: number;
  note: string;
  places: {
    id: string;
    name: string;
    area: string;
    indoor: boolean;
    duration: number;
    summary: string;
    source: string;
  }[];
};

export type GeneratedItinerary = {
  title: string;
  summary: string;
  days: GeneratedDay[];
};

const plannerSchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  days: z.array(
    z.object({
      day: z.number().int().positive(),
      note: z.string().min(1),
      places: z.array(
        z.object({
          id: z.string().min(1),
          name: z.string().min(1),
          area: z.string().min(1),
          indoor: z.boolean(),
          duration: z.number().int().positive(),
          summary: z.string().min(1),
          source: z.string().url(),
        }),
      ),
    }),
  ),
});

export function parsePlannerJson(text: string, allowedSources: string[] = []): GeneratedItinerary {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const parsed = plannerSchema.parse(JSON.parse(cleaned));

  if (allowedSources.length > 0) {
    const allowed = new Set(allowedSources);
    for (const day of parsed.days) {
      for (const place of day.places) {
        if (!allowed.has(place.source)) {
          throw new Error(`景点「${place.name}」的来源不在搜索结果中`);
        }
      }
    }
  }

  return parsed;
}

export function buildPlannerMessages(input: {
  destinationName: string;
  region: string;
  startDate: string;
  days: number;
  dailyHours: number;
  pace: Pace;
  interests: string[];
  weather: WeatherDay[];
  searchResults: SearchResult[];
  discoveredStops?: DiscoveredStop[];
  route: RoutePlan;
}) {
  const paceLabel = input.pace === "relaxed" ? "轻松" : input.pace === "deep" ? "充实" : "适中";
  const searchPayload = input.searchResults.slice(0, 20).map((item) => ({
    title: item.title,
    url: item.url,
    content: item.content.slice(0, 1200),
  }));
  const weatherPayload = input.weather.map((day) => ({
    date: day.date,
    code: day.code,
    tempMax: day.tempMax,
    tempMin: day.tempMin,
    precipitationProbability: day.precipProb ?? 0,
  }));

  return [
    {
      role: "system",
      content:
        "你是中文旅行规划师。只能使用用户提供的搜索结果中的景点和来源链接，不得编造景区、开放时间或来源。优先推荐热门、口碑高、地理上顺路的景点。遇到降雨或雷雨，应把室内或短时景点排在前面。生成前先在内部检查时间与空间是否合理；如果不合理，自动调整交通、停留时长、休息日和游玩密度后再输出，不展示失败草稿。summary 只写整体印象（风景类型、适合人群、季节与节奏特点），不得逐日罗列安排或断言某天去哪，因为每日排程由下游时间轴模块决定。只输出严格 JSON，不要 Markdown。",
    },
    {
      role: "user",
      content: JSON.stringify({
        task: "生成逐日行程",
        requiredSchema: {
          title: "string",
          summary: "string，整体印象；不要逐日描述安排",
          days: [
            {
              day: "number",
              note: "string",
              places: [
                {
                  id: "string",
                  name: "string",
                  area: "string",
                  indoor: "boolean",
                  duration: "number，单位分钟",
                  summary: "string，说明为什么值得去以及如何顺路安排",
                  source: "string，必须来自 searchResults.url",
                },
              ],
            },
          ],
        },
        trip: {
          destination: input.destinationName,
          region: input.region,
          startDate: input.startDate,
          days: input.days,
          dailyHours: input.dailyHours,
          pace: paceLabel,
          interests: input.interests,
          route: input.route,
        },
        weather: weatherPayload,
        searchResults: searchPayload,
        discoveredStops: input.discoveredStops ?? [],
        constraints: [
          `必须生成恰好 ${input.days} 天`,
          "每天景点数量必须适配 dailyHours 和 pace",
          "途经点顺序不可更改，目的地和途经点都表示到达附近后游玩",
          "途经点都必须作为实际停留与游玩节点，不得只当作交通经过点",
          "使用校核后的地区和地点类型解释地理关系",
          "verificationStatus=candidate 表示候选地点，不是已确认事实；介绍时必须明确说明不确定性，不得当作确定结论",
          "每一段必须遵循用户设置的 transport 和 style",
          "transport=economy 表示经济推荐：优先降低交通支出，可以接受更长交通时间",
          "transport=balanced 表示均衡推荐：综合费用、时间、换乘次数、可靠性和舒适度，默认采用此策略",
          "transport=speed 表示效率推荐：优先缩短交通时间，可以接受更高交通开销",
          "train/flight/drive/bus/ship 表示用户指定交通方式，不得擅自替换",
          "估算交通价格时给出区间并说明估算依据，不得伪造实时票价",
          "自驾成本按能源费、过路费、停车费估算；默认按自有车辆计算，不擅自加入租车费或车辆折旧",
          "style=wander 表示边走边玩，应减少固定景点、保留临时停留与机动时间",
          "roundTrip=true 且 returnMode=fast 时，快速回家；returnMode=scenic 时不走回头，优先规划不同返程路线",
          "每天至少预留 7 小时睡眠，并预留用餐、休息、换乘和交通缓冲",
          "先在内部判断时间与空间合理性，不合理则自动调整优化后再输出最终结果",
          "所有 source 必须原样使用 searchResults 中的 url",
          "不要输出 JSON 之外的解释",
        ],
      }),
    },
  ];
}
