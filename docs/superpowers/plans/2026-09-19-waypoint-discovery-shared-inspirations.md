# 途经点发现与共享灵感景点 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为未知目的地和途经点增加独立的 Tavily 检索、DeepSeek 校核、共享灵感入库与唯一 SVG 配图。

**Architecture:** 行程生成前运行地点发现服务；未知地点先查共享库，未命中时并行检索 Tavily，再批量校核 DeepSeek，按置信度写入 `verified` 或 `candidate`。实时规划器合并途经点来源，灵感景点列表合并静态景点与已验证动态景点，动态 SVG 由唯一视觉种子稳定生成。

**Tech Stack:** React 19、TanStack Start、TypeScript、Zod、Postgres/PGLite、Node test、Playwright、Tavily、DeepSeek、纯 SVG 生成器。

**Spec:** `docs/superpowers/specs/2026-09-19-waypoint-discovery-shared-inspirations-design.md`

## Global Constraints

- 不引入账号，不保存用户身份、IP、设备、输入历史或行程正文。
- `discovered_places` 是无归属共享表，不包含 `user_id`。
- 只公开 `status = 'verified'` 的动态地点；`candidate` 仅服务端按精确名称复用。
- 高置信度阈值为 `>= 0.85`；候选阈值为 `0.55` 到 `0.849999`；低于 `0.55` 或地区冲突时不写库。
- 未知地点最多 5 个，与途经点上限一致。
- Tavily 和 DeepSeek 外部调用必须可注入 `fetch`，测试不得依赖真实网络。
- 当前工作区不是 Git 仓库，计划中的提交步骤替换为测试检查和书面 checkpoint。
- 当前环境未配置 `DEEPSEEK_API_KEY`、`TAVILY_API_KEY`、`DATABASE_URL`；联网验收只能在具备密钥时执行，缺失时不得伪造通过结果。
- 动态配图使用项目现有 SVG 风格，不抓取第三方图片，不写运行时文件。
- 数据库代码只能存在于服务端模块和 `createServerFn` handler 中。

## File Map

- `migrations/0002_discovered_places.sql`：共享动态地点表。
- `src/lib/place-discovery.ts`：纯函数、类型、规范化和置信度分档。
- `src/lib/place-discovery.test.ts`：纯函数和路线节点测试。
- `src/lib/place-verification.ts`：DeepSeek 校核输出解析。
- `src/lib/place-verification.test.ts`：来源白名单和解析测试。
- `src/lib/discovered-places.server.ts`：数据库读写和行映射。
- `src/lib/tavily.server.ts`：共享 Tavily 搜索与去重。
- `src/lib/place-discovery.server.ts`：单点检索、批量校核、落库编排。
- `src/lib/scene-art.ts`：纯 SVG 渲染器和视觉种子。
- `src/lib/scene-art.test.ts`：图片稳定性与唯一性测试。
- `scripts/generate-inspiration-scenes.ts`：改用共享 SVG 渲染器。
- `src/lib/discovered-places.functions.ts`：公开灵感列表 server function。
- `src/lib/live-planner.functions.ts`：接入发现服务并返回校核结果。
- `src/lib/live-planner.ts`：实时提示词和来源约束。
- `src/lib/long-planner.ts`：长线提示词加入校核地点。
- `src/lib/inspiration.ts`：静态与动态目录合并、筛选和查找。
- `src/lib/inspiration.test.ts`：目录合并测试。
- `src/components/planner/PlannerPrototype.tsx`：动态卡片、选择状态和反馈。
- `src/components/planner/InspirationCatalogProvider.tsx`：提供合并后的灵感目录。
- `src/styles.css`：新发现标记和反馈样式。
- `src/routes/__root.tsx`：挂载 Sonner Toaster。

---

### Task 1: 地点规范化与置信度规则

**Files:**

- Create: `src/lib/place-discovery.ts`
- Test: `src/lib/place-discovery.test.ts`

**Interfaces:**

- Consumes: 无。
- Produces:

```ts
export type PlacePublishStatus = "verified" | "candidate" | "rejected";
export function sanitizePlaceText(value: string, maxLength?: number): string;
export function normalizePlaceName(value: string): string;
export function canonicalPlaceKey(name: string, region: string): string;
export function classifyPlaceConfidence(confidence: number, ambiguous: boolean): PlacePublishStatus;
```

- [x] **Step 1: 写失败测试**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalPlaceKey,
  classifyPlaceConfidence,
  normalizePlaceName,
  sanitizePlaceText,
} from "./place-discovery.ts";

test("normalizes place names consistently", () => {
  assert.equal(normalizePlaceName(" 龙岩市 "), "龙岩");
  assert.equal(normalizePlaceName("LONG YAN"), "longyan");
});

test("allows same name in different regions", () => {
  assert.notEqual(canonicalPlaceKey("龙泉", "浙江"), canonicalPlaceKey("龙泉", "云南"));
});

test("classifies publish status by confidence and ambiguity", () => {
  assert.equal(classifyPlaceConfidence(0.85, false), "verified");
  assert.equal(classifyPlaceConfidence(0.84, false), "candidate");
  assert.equal(classifyPlaceConfidence(0.99, true), "rejected");
  assert.equal(classifyPlaceConfidence(0.54, false), "rejected");
});

test("removes control characters and trims text", () => {
  assert.equal(sanitizePlaceText(" 龙\u0000岩 ", 20), "龙岩");
});
```

- [x] **Step 2: 运行测试并确认失败**

Run: `node --experimental-strip-types --test src/lib/place-discovery.test.ts`

Expected: FAIL，模块或导出不存在。

- [x] **Step 3: 实现最小纯函数**

```ts
export function sanitizePlaceText(value: string, maxLength = 80) {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, maxLength);
}

export function normalizePlaceName(value: string) {
  return sanitizePlaceText(value)
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/(特别行政区|维吾尔自治区|壮族自治区|回族自治区|自治区|省|市|县|区)$/g, "");
}

export function canonicalPlaceKey(name: string, region: string) {
  return `${normalizePlaceName(name)}|${normalizePlaceName(region)}`;
}

export function classifyPlaceConfidence(confidence: number, ambiguous: boolean) {
  if (ambiguous || !Number.isFinite(confidence) || confidence < 0.55) return "rejected";
  return confidence >= 0.85 ? "verified" : "candidate";
}
```

- [x] **Step 4: 运行测试并确认通过**

Run: `node --experimental-strip-types --test src/lib/place-discovery.test.ts`

Expected: PASS。

- [x] **Step 5: Checkpoint**

Run: `npm run typecheck`

Expected: PASS。当前工作区不是 Git 仓库，因此不执行 commit。

---

### Task 2: 共享地点表与仓储

**Files:**

- Create: `migrations/0002_discovered_places.sql`
- Create: `src/lib/discovered-places.server.ts`
- Modify: `src/lib/place-discovery.ts`
- Test: `src/lib/place-discovery.test.ts`

**Interfaces:**

- Consumes: `canonicalPlaceKey()`、`normalizePlaceName()`、`classifyPlaceConfidence()`。
- Produces:

```ts
export type DiscoveredPlaceSource = { title: string; url: string; content: string };
export type DiscoveredPlaceRecord = {
  id: string;
  canonicalKey: string;
  canonicalName: string;
  normalizedName: string;
  region: string;
  country: string;
  placeType: string;
  summary: string;
  tags: string[];
  sourceSnapshot: DiscoveredPlaceSource[];
  confidence: number;
  status: "verified" | "candidate";
  art: string;
  accent: string;
  visualSeed: number;
  routeContext: string[]; // compatibility view only; final-fix records always expose []
  usageCount: number;
};
export function mapDiscoveredPlaceRow(row: Record<string, unknown>): DiscoveredPlaceRecord;
```

- [x] **Step 1: 写行映射失败测试**

```ts
import { mapDiscoveredPlaceRow } from "./discovered-places.server.ts";

test("maps a database row to a discovered place", () => {
  const place = mapDiscoveredPlaceRow({
    id: "dyn-longyan",
    canonical_key: "龙岩|福建",
    canonical_name: "龙岩",
    normalized_name: "龙岩",
    region: "福建",
    country: "中国",
    place_type: "城市",
    summary: "福建西部城市",
    tags: ["客家文化"],
    source_snapshot: [{ title: "龙岩", url: "https://example.com", content: "福建" }],
    confidence: "0.960",
    status: "verified",
    art: "mountain",
    accent: "#45695d",
    visual_seed: 12345,
    route_context: [],
    usage_count: 2,
  });
  assert.equal(place.canonicalName, "龙岩");
  assert.equal(place.region, "福建");
  assert.equal(place.confidence, 0.96);
});
```

- [x] **Step 2: 运行测试并确认失败**

Run: `node --experimental-strip-types --test src/lib/place-discovery.test.ts`

Expected: FAIL，`mapDiscoveredPlaceRow` 不存在。

- [x] **Step 3: 创建迁移**

```sql
create table if not exists discovered_places (
  id text primary key,
  canonical_key text not null unique,
  canonical_name text not null,
  normalized_name text not null,
  region text not null,
  country text not null default '中国',
  place_type text not null,
  summary text not null,
  tags jsonb not null default '[]'::jsonb,
  source_snapshot jsonb not null default '[]'::jsonb,
  confidence numeric(4,3) not null check (confidence >= 0 and confidence <= 1),
  status text not null check (status in ('verified', 'candidate')),
  art text not null,
  accent text not null,
  visual_seed integer not null unique,
  route_context jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_verified_at timestamptz not null default now(),
  usage_count integer not null default 0
);
create index if not exists discovered_places_normalized_name_idx on discovered_places (normalized_name);
create index if not exists discovered_places_status_updated_idx on discovered_places (status, updated_at desc);
```

- [x] **Step 4: 实现仓储和行映射**

在 `discovered-places.server.ts` 中实现：

```ts
export async function listVerifiedDiscoveredPlaces(): Promise<DiscoveredPlaceRecord[]>;
export async function findDiscoveredPlaceByName(
  normalizedName: string,
): Promise<DiscoveredPlaceRecord[]>;
export async function upsertDiscoveredPlace(
  record: DiscoveredPlaceRecord,
): Promise<DiscoveredPlaceRecord>;
```

`upsertDiscoveredPlace()` 使用 `canonical_key` 冲突更新，保留原 `visual_seed`，同时把 `usage_count` 加一，并把 `route_context` 固定写为 `[]`。缓存复用改用独立的 usage touch，不刷新 `last_verified_at`；只有实际校核写入才刷新它。所有 SQL 由 `getSql()` 执行。

- [x] **Step 5: 运行测试和迁移检查**

Run: `node --experimental-strip-types --test src/lib/place-discovery.test.ts`; `npm run build`

Expected: PASS；PGLite 会在 dev server 启动时应用迁移。

---

### Task 3: 提取可复用 SVG 渲染器

**Files:**

- Create: `src/lib/scene-art.ts`
- Modify: `scripts/generate-inspiration-scenes.ts`
- Test: `src/lib/scene-art.test.ts`

**Interfaces:**

- Consumes: `SceneArt`、`SceneDestination`。
- Produces:

```ts
export type SceneVisual = { art: SceneArt; accent: string; visualSeed: number };
export function renderSceneSvg(input: {
  id: string;
  name: string;
  art: SceneArt;
  accent: string;
  visualSeed: number;
}): string;
export function sceneDataUrl(input: Parameters<typeof renderSceneSvg>[0]): string;
export function createUniqueVisualSeed(
  canonicalKey: string,
  usedSeeds: ReadonlySet<number>,
): number;
```

- [x] **Step 1: 写稳定性和唯一性失败测试**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { createUniqueVisualSeed, renderSceneSvg } from "./scene-art.ts";

const input = {
  id: "longyan",
  name: "龙岩",
  art: "mountain",
  accent: "#45695d",
  visualSeed: 42,
} as const;
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
```

- [x] **Step 2: 运行测试并确认失败**

Run: `node --experimental-strip-types --test src/lib/scene-art.test.ts`

Expected: FAIL，模块不存在。

- [x] **Step 3: 提取生成器**

把 `scripts/generate-inspiration-scenes.ts` 中的 `hashString`、`adjustColor`、`mountain`、`cloud`、`tree`、`signatureMotif`、`specialRender`、`render` 和 SVG 包装逻辑移动到 `src/lib/scene-art.ts`。渲染器不导入 `node:fs`，只返回字符串。

`createUniqueVisualSeed()` 使用 `hashString(canonicalKey)` 作为起点，遇到已使用种子时递增并再次哈希，最多重试 10,000 次；超过上限时抛出 `无法分配唯一视觉种子`。

- [x] **Step 4: 改造构建脚本**

脚本只保留静态资源目录和写入逻辑：

```ts
for (const destination of sceneDestinations) {
  const visualSeed = hashString(destination.id);
  const svg = renderSceneSvg({
    id: destination.id,
    name: destination.name,
    art: destination.art,
    accent: destination.accent,
    visualSeed,
  });
  writeFileSync(join(outDir, `${destination.id}.svg`), svg);
}
```

`hashString` 从 `scene-art.ts` 导出。

- [x] **Step 5: 运行测试和静态资源生成**

Run: `node --experimental-strip-types --test src/lib/scene-art.test.ts`; `npm run generate:scenes`

Expected: PASS；生成数量与 `sceneDestinations.length` 一致。

---

### Task 4: Tavily 单点搜索服务

**Files:**

- Create: `src/lib/tavily.server.ts`
- Create: `src/lib/place-discovery.server.ts`
- Modify: `src/lib/live-planner.functions.ts`
- Test: `src/lib/place-discovery.test.ts`

**Interfaces:**

- Consumes: `SearchResult`、`normalizePlaceName()`。
- Produces:

```ts
export type PlaceSearchBundle = {
  inputName: string;
  normalizedName: string;
  queries: string[];
  results: SearchResult[];
};
export function buildPlaceSearchQueries(name: string): string[];
export async function searchPlaceSources(
  name: string,
  apiKey: string,
  fetchImpl?: typeof fetch,
): Promise<PlaceSearchBundle>;
```

- [x] **Step 1: 写查询失败测试**

```ts
import { buildPlaceSearchQueries } from "./place-discovery.server.ts";
test("builds a place-specific Tavily query", () => {
  assert.deepEqual(buildPlaceSearchQueries("龙岩"), ["龙岩 所属地区 景点 一日游 推荐"]);
});
```

- [x] **Step 2: 运行测试并确认失败**

Run: `node --experimental-strip-types --test src/lib/place-discovery.test.ts`

Expected: FAIL，导出不存在。

- [x] **Step 3: 抽取 Tavily 模块**

把 `searchTavily()`、`normalizeTavilyResults()` 和 `dedupeSources()` 从 `live-planner.functions.ts` 移到 `tavily.server.ts`。原文件改为导入这些函数，现有实时规划行为保持不变。

- [x] **Step 4: 实现单点搜索**

`buildPlaceSearchQueries()` 返回主查询。`searchPlaceSources()` 调用 Tavily，参数为 `search_depth: "advanced"`、`max_results: 8`、`include_answer: false`、`include_raw_content: false`，使用 30 秒超时并去重 URL。

- [x] **Step 5: 运行测试和原有规划器测试**

Run: `node --experimental-strip-types --test src/lib/place-discovery.test.ts`; `node --experimental-strip-types --test src/lib/live-planner.test.ts`; `npm run typecheck`

Expected: 全部 PASS。

---

### Task 5: DeepSeek 地点校核解析与落库

**Files:**

- Create: `src/lib/place-verification.ts`
- Create: `src/lib/place-verification.test.ts`
- Modify: `src/lib/place-discovery.server.ts`
- Modify: `src/lib/place-discovery.ts`

**Interfaces:**

- Consumes: `PlaceSearchBundle`、`classifyPlaceConfidence()`、`canonicalPlaceKey()`。
- Produces:

```ts
export type PlaceVerificationGroup = {
  inputName: string;
  normalizedName: string;
  routeContext: string[];
  results: SearchResult[];
};
export type VerifiedPlaceResult = {
  inputName: string;
  canonicalName: string;
  region: string;
  country: string;
  placeType: string;
  summary: string;
  tags: string[];
  aliases: string[];
  confidence: number;
  ambiguous: boolean;
  reasons: string[];
  sourceUrls: string[];
};
export function parsePlaceVerificationJson(
  text: string,
  groups: PlaceVerificationGroup[],
): VerifiedPlaceResult[];
export async function verifyPlaceGroupsWithDeepSeek(input: {
  apiKey: string;
  baseUrl?: string;
  groups: PlaceVerificationGroup[];
  fetchImpl?: typeof fetch;
}): Promise<VerifiedPlaceResult[]>;
```

- [x] **Step 1: 写解析和来源白名单失败测试**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { parsePlaceVerificationJson } from "./place-verification.ts";

const groups = [
  {
    inputName: "龙岩",
    normalizedName: "龙岩",
    routeContext: ["厦门", "黄山"],
    results: [{ title: "龙岩", url: "https://example.com/longyan", content: "福建省龙岩市" }],
  },
];

test("parses a verified place", () => {
  const parsed = parsePlaceVerificationJson(
    JSON.stringify([
      {
        inputName: "龙岩",
        canonicalName: "龙岩",
        region: "福建",
        country: "中国",
        placeType: "城市",
        summary: "福建西部城市",
        tags: ["客家文化"],
        aliases: ["龙岩市"],
        confidence: 0.96,
        ambiguous: false,
        reasons: ["来源明确"],
        sourceUrls: ["https://example.com/longyan"],
      },
    ]),
    groups,
  );
  assert.equal(parsed[0].region, "福建");
});

test("rejects sources outside the group whitelist", () => {
  assert.throws(
    () =>
      parsePlaceVerificationJson(
        JSON.stringify([
          {
            inputName: "龙岩",
            canonicalName: "龙岩",
            region: "新疆",
            country: "中国",
            placeType: "城市",
            summary: "错误",
            tags: [],
            aliases: [],
            confidence: 0.9,
            ambiguous: false,
            reasons: [],
            sourceUrls: ["https://example.com/other"],
          },
        ]),
        groups,
      ),
    /来源不在允许列表/,
  );
});
```

- [x] **Step 2: 运行测试并确认失败**

Run: `node --experimental-strip-types --test src/lib/place-verification.test.ts`

Expected: FAIL，模块不存在。

- [x] **Step 3: 实现严格解析**

先用 Zod 定义数组 schema，再检查：`inputName` 必须匹配一个输入分组；每个 `sourceUrls` 必须属于该分组的 URL 集合；`confidence` 必须在 0 到 1；文本字段使用 `sanitizePlaceText()`。

- [x] **Step 4: 实现 DeepSeek 批量校核**

请求 `POST ${baseUrl}/chat/completions`，模型使用 `DEEPSEEK_MODEL` 或 `deepseek-chat`，`response_format: { type: "json_object" }`，温度 0.1，超时 60 秒。提示词要求校核规范名称、所属地区、地点类型；不得使用未提供的地区证据；同名异地或证据冲突时 `ambiguous=true`；只输出 JSON 对象 `{ "places": [...] }`。

- [x] **Step 5: 落库和分档**

对每项调用 `classifyPlaceConfidence(result.confidence, result.ambiguous)`。`verified` 和 `candidate` 创建 `DiscoveredPlaceRecord` 并 upsert；`rejected` 不写库。动态地点 ID 使用 `dyn-${hashString(canonicalPlaceKey)}`。首次写库通过 `createUniqueVisualSeed()` 分配 `visualSeed`，数据库唯一冲突时换种子重试；后续同 `canonicalKey` 更新摘要、来源和置信度，但保留原 `visualSeed`。

- [x] **Step 6: 运行测试**

Run: `node --experimental-strip-types --test src/lib/place-verification.test.ts`; `node --experimental-strip-types --test src/lib/place-discovery.test.ts`; `npm run typecheck`

Expected: 全部 PASS。

---

### Task 6: 路线地点发现编排

**Files:**

- Modify: `src/lib/place-discovery.server.ts`
- Modify: `src/lib/place-discovery.ts`
- Test: `src/lib/place-discovery.test.ts`

**Interfaces:**

- Consumes: `RoutePlan`、`PlaceSearchBundle`、`verifyPlaceGroupsWithDeepSeek()`、仓储函数。
- Produces:

```ts
export type RouteDiscoveryNotice = {
  inputName: string;
  status: "published" | "candidate" | "rejected" | "failed";
  canonicalName?: string;
  region?: string;
  message: string;
};
export type RouteDiscoveryResult = {
  notices: RouteDiscoveryNotice[];
  searchResults: SearchResult[];
  verifiedPlaces: DiscoveredPlaceRecord[];
  candidatePlaces: DiscoveredPlaceRecord[];
};
export function routeNodesNeedingDiscovery(
  route: RoutePlan,
  knownNames: ReadonlySet<string>,
): string[];
export async function discoverRoutePlaces(input: {
  route: RoutePlan;
  deepseekKey?: string;
  tavilyKey?: string;
  fetchImpl?: typeof fetch;
  maxUnknown?: number;
}): Promise<RouteDiscoveryResult>;
```

- [x] **Step 1: 写路线筛选失败测试**

```ts
import { routeNodesNeedingDiscovery } from "./place-discovery.server.ts";

test("excludes origin, deduplicates and keeps waypoint order", () => {
  const nodes = routeNodesNeedingDiscovery(
    {
      origin: "厦门",
      destination: "黄山",
      waypoints: ["龙岩", "龙岩", "景德镇"],
      roundTrip: false,
      returnMode: null,
      legs: [],
    },
    new Set(["黄山"]),
  );
  assert.deepEqual(nodes, ["龙岩", "景德镇"]);
});
```

- [x] **Step 2: 运行测试并确认失败**

Run: `node --experimental-strip-types --test src/lib/place-discovery.test.ts`

Expected: FAIL，导出不存在。

- [x] **Step 3: 实现节点筛选**

顺序固定为：所有途经点按原顺序，然后目的地。使用 `normalizePlaceName()` 去重，排除出现在 `knownNames` 中的地点，最多返回 `maxUnknown ?? 5` 个。

- [x] **Step 4: 实现发现编排**

流程：先查数据库精确候选；已有 `verified` 或未过期 `candidate` 直接复用；未命中地点使用 `Promise.allSettled()` 调用 `searchPlaceSources()`；搜索失败生成 `failed` notice；成功地点合并成一次 `verifyPlaceGroupsWithDeepSeek()` 请求；按置信度写库并生成 notice；合并所有搜索来源并按 URL 去重；缺少密钥时不调用网络、不写库。

- [x] **Step 5: 增加失败降级测试**

使用注入 fetch：一个地点返回 500，另一个地点成功；断言失败 notice 为 `failed`，成功地点仍被解析，`searchResults` 只包含成功来源。

- [x] **Step 6: 运行测试**

Run: `node --experimental-strip-types --test src/lib/place-discovery.test.ts`; `node --experimental-strip-types --test src/lib/place-verification.test.ts`; `npm run typecheck`

Expected: 全部 PASS。

---

### Task 7: 行程规划器接入地点发现

**Files:**

- Modify: `src/lib/live-planner.functions.ts`
- Modify: `src/lib/live-planner.ts`
- Modify: `src/lib/long-planner.ts`
- Modify: `src/lib/live-planner.test.ts`
- Modify: `src/lib/long-planner.test.ts`

**Interfaces:**

- Consumes: `discoverRoutePlaces()`、`RouteDiscoveryNotice`、`RouteDiscoveryResult`。
- Produces:

```ts
export type DiscoveryNotice = {
  inputName: string;
  status: "published" | "candidate" | "rejected" | "failed";
  canonicalName?: string;
  region?: string;
  message: string;
};
export type LivePlanResult =
  | { status: "needs_configuration"; missing: string[] }
  | {
      status: "ok";
      plan: ReturnType<typeof parsePlannerJson>;
      sources: SearchResult[];
      discoveries: DiscoveryNotice[];
    };
export type LongPlanResult =
  | { status: "needs_configuration"; missing: string[] }
  | { status: "ok"; plan: LongPlan; discoveries: DiscoveryNotice[] };
```

- [x] **Step 1: 写提示词失败测试**

在 `live-planner.test.ts` 增加：

```ts
test("planner prompt requires real waypoint stops and verified regions", () => {
  const messages = buildPlannerMessages({
    destinationName: "黄山",
    region: "安徽",
    startDate: "2026-09-19",
    days: 3,
    dailyHours: 8,
    pace: "balanced",
    interests: [],
    weather: [],
    searchResults: [],
    route: {
      origin: "厦门",
      destination: "黄山",
      waypoints: ["龙岩"],
      roundTrip: false,
      returnMode: null,
      legs: [],
    },
  });
  const content = JSON.stringify(messages);
  assert.match(content, /途经点都必须作为实际停留与游玩节点/);
  assert.match(content, /使用校核后的地区/);
});
```

在 `long-planner.test.ts` 增加断言：`buildLongPlannerMessages()` 中包含 `discoveredStops`。

- [x] **Step 2: 运行测试并确认失败**

Run: `node --experimental-strip-types --test src/lib/live-planner.test.ts`; `node --experimental-strip-types --test src/lib/long-planner.test.ts`

Expected: FAIL，约束文本不存在。

- [x] **Step 3: 修改实时规划器**

在 `generateLiveItinerary` handler 中，在执行原目的地 Tavily 查询前调用：

```ts
const discovery = await discoverRoutePlaces({
  route: data.route,
  deepseekKey,
  tavilyKey,
  fetchImpl: fetch,
});
```

将 `discovery.searchResults` 合并到 `sources`，调用 `planWithDeepSeek()` 时传入合并后的来源。结果返回 `discoveries: discovery.notices`。发现服务抛错时捕获并返回 `failed` notices，不阻断规划。

- [x] **Step 4: 修改长线规划器**

在 `generateLongItinerary` handler 中调用发现服务。将 `verifiedPlaces` 的名称、地区、摘要和标签映射为 `discoveredStops`，加入 `planLongTripWithDeepSeek()` 输入。缺少密钥或发现失败时继续原有长线规划，并返回失败 notices。

- [x] **Step 5: 修改提示词约束**

在 `live-planner.ts` 的 `constraints` 增加：

```ts
"途经点都必须作为实际停留与游玩节点，不得只当作交通经过点",
"使用校核后的地区和地点类型解释地理关系",
```

在 `long-planner.ts` 的 trip payload 加入 `discoveredStops`，并增加相同地区约束。

- [x] **Step 6: 运行测试和类型检查**

Run: `node --experimental-strip-types --test src/lib/live-planner.test.ts`; `node --experimental-strip-types --test src/lib/long-planner.test.ts`; `npm run typecheck`

Expected: 全部 PASS。

---

### Task 8: 共享灵感目录与动态卡片

**Files:**

- Create: `src/lib/discovered-places.functions.ts`
- Create: `src/components/planner/InspirationCatalogProvider.tsx`
- Modify: `src/lib/inspiration.ts`
- Modify: `src/lib/inspiration.test.ts`
- Modify: `src/components/planner/PlannerPrototype.tsx`
- Modify: `src/styles.css`
- Modify: `src/routes/__root.tsx`

**Interfaces:**

- Consumes: `listVerifiedDiscoveredPlaces()`、`sceneDataUrl()`、`RouteDiscoveryNotice`。
- Produces:

```ts
export const getSharedInspirations = createServerFn({ method: "GET" }).handler(
  async (): Promise<InspirationDestination[]> => [],
);
export function mergeInspirationCatalog(
  staticItems: InspirationDestination[],
  dynamicItems: InspirationDestination[],
): InspirationDestination[];
export function findInspiration(
  idOrName: string,
  items?: InspirationDestination[],
): InspirationDestination | undefined;
export function findInspirationsByRegion(
  query: string,
  items?: InspirationDestination[],
): InspirationDestination[];
```

- [x] **Step 1: 写目录合并失败测试**

```ts
import { mergeInspirationCatalog } from "./inspiration.ts";

test("merges dynamic inspirations after static and removes duplicate ids", () => {
  const staticItems = [
    {
      id: "huangshan",
      name: "黄山",
      region: "安徽",
      summary: "",
      scene: "/a.svg",
      accent: "#000",
      tags: [],
      art: "mountain",
    },
  ] as const;
  const dynamicItems = [
    {
      id: "dyn-longyan",
      name: "龙岩",
      region: "福建",
      summary: "客家文化",
      scene: "data:image/svg+xml,a",
      accent: "#45695d",
      tags: ["客家文化"],
      art: "mountain",
      discovered: true,
    },
  ] as const;
  const merged = mergeInspirationCatalog([...staticItems], [...dynamicItems]);
  assert.equal(merged.at(-1)?.name, "龙岩");
  assert.equal(merged.length, 2);
});
```

- [x] **Step 2: 运行测试并确认失败**

Run: `node --experimental-strip-types --test src/lib/inspiration.test.ts`

Expected: FAIL，导出不存在。

- [x] **Step 3: 扩展类型和合并函数**

`InspirationDestination` 保留 `SceneDestination` 字段并增加可选 `discovered?: boolean`、`sourceCount?: number`。`mergeInspirationCatalog()` 先保留静态顺序，再追加未重复的动态地点；ID 冲突时静态项优先。

- [x] **Step 4: 实现公开 server function**

`discovered-places.functions.ts` 只调用 `listVerifiedDiscoveredPlaces()`，把记录映射为 `InspirationDestination`：

```ts
scene: sceneDataUrl({ id: place.id, name: place.canonicalName, art: place.art as SceneArt, accent: place.accent, visualSeed: place.visualSeed }),
discovered: true,
sourceCount: place.sourceSnapshot.length,
```

不得返回 `candidate`。

- [x] **Step 5: 创建目录 Provider**

`InspirationCatalogProvider.tsx` 初始使用静态 `inspirationDestinations`，页面立即渲染；挂载后调用 `useServerFn(getSharedInspirations)`，成功时合并，失败时保留静态目录并记录一次 console warning，不显示错误页。

- [x] **Step 6: 替换 PlannerPrototype 的静态引用**

`resolveTripDestination()`、`LandingScreen`、`KnownPlanScreen` 和场景卡组件都从 `useInspirationCatalog()` 读取合并目录。所有 `findInspiration()` 和 `findInspirationsByRegion()` 调用传入当前目录。动态卡片增加：

```tsx
{
  destination.discovered ? <span className="inspiration-new-badge">新发现</span> : null;
}
```

- [x] **Step 7: 挂载反馈消息**

在 `__root.tsx` 保留现有 shell，加入 `<Toaster position="top-center" richColors />`。在 `PlannerPrototype` 收到 `discoveries` 后：`published` 使用 `toast.success()`；`candidate` 使用 `toast.info()`；`rejected` 和 `failed` 使用 `toast.warning()`。

- [x] **Step 8: 添加样式**

在 `styles.css` 添加：

```css
.inspiration-new-badge {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  background: color-mix(in oklab, var(--v-accent) 13%, transparent);
  color: var(--v-accent);
  padding: 0.2rem 0.48rem;
  font-size: 0.6rem;
  font-weight: 700;
  letter-spacing: 0.04em;
}
```

- [x] **Step 9: 运行测试和 browser smoke**

Run: `node --experimental-strip-types --test src/lib/inspiration.test.ts`; `npm run typecheck`; `node scripts/browser-smoke.mjs http://127.0.0.1:8080/ screenshots/discovered-inspirations.png`

Expected: 类型检查和测试 PASS；桌面和移动截图中没有空白页、控制台错误或横向溢出。

---

### Task 9: 全量验收与交付说明

**Files:**

- Modify: `docs/superpowers/plans/2026-09-19-waypoint-discovery-shared-inspirations.md`
- Verify: `src/lib/place-discovery.test.ts`
- Verify: `src/lib/place-verification.test.ts`
- Verify: `src/lib/scene-art.test.ts`
- Verify: `src/lib/inspiration.test.ts`
- Verify: `src/lib/live-planner.test.ts`
- Verify: `src/lib/long-planner.test.ts`

**Interfaces:**

- Consumes: 前 8 个任务的全部产物。
- Produces: 可复现的验收记录和已知环境限制。

- [x] **Step 1: 运行完整自动化测试**

Run: `npm test`

Expected: 全部 PASS，新的地点发现、校核、配图和目录测试均被纳入现有测试脚本。

- [x] **Step 2: 运行类型检查**

Run: `npm run typecheck`

Expected: PASS，无未使用导入或客户端引用服务端模块的问题。

- [x] **Step 3: 运行生产构建**

Run: `npm run build`

Expected: PASS。无 `DATABASE_URL` 时迁移脚本输出跳过信息；有数据库时 `0002_discovered_places.sql` 成功应用。

- [x] **Step 4: 验证开发预览**

Run: `node scripts/browser-smoke.mjs http://127.0.0.1:8080/ screenshots/waypoint-discovery-final.png`

同时人工检查桌面与移动截图：

- 静态灵感景点正常。
- 动态地点在具备数据时显示“新发现”和唯一插画。
- 校核消息不遮挡主要操作。
- 控制台无未捕获错误。
- 页面无横向溢出。

- [x] **Step 5: 验证生产构建**

在 Windows 环境运行：

```powershell
npm run preview -- --host 127.0.0.1 --port 8081
node scripts/browser-smoke.mjs http://127.0.0.1:8081/ screenshots/waypoint-discovery-built.png --baseline screenshots/waypoint-discovery-final.json
```

Expected: `divergesFromBaseline: false`，无控制台或页面错误。

- [x] **Step 6: 有条件执行真实联网验收**

仅在 `DEEPSEEK_API_KEY` 和 `TAVILY_API_KEY` 同时存在时执行：

```powershell
if ($env:DEEPSEEK_API_KEY -and $env:TAVILY_API_KEY) {
  'LIVE_DISCOVERY=READY'
} else {
  'LIVE_DISCOVERY=SKIPPED_MISSING_KEYS'
}
```

如果密钥缺失，最终交付必须明确写出“真实 Tavily/DeepSeek 联网验收未执行”，不得把 mock 测试描述为真实联网验证。

- [x] **Step 7: 记录设计约束**

最终交付说明必须包含：

- 动态分享是共享数据，仅存地点公开信息。
- PGLite 预览在开发服务重启后重置。
- 部署数据库提供跨访客持久化。
- 当前工作区不是 Git 仓库，因此没有提交记录。

---

## Final Review Fix（2026-09-20）

- `route_context` 仅在 DeepSeek 校核调用中存在于内存；所有持久化路径固定写入 `[]`，迁移会清理旧值。
- 实时和长线规划器传递校核后的 `placeType`。
- DeepSeek 批量结果使用容错路径，单条 malformed/out-of-allowlist 不阻断同批其他有效地点。
- `verified` 必须至少有一个允许来源且其内容非空，否则降为 `candidate`。
- 实时来源选择为目的地和种子来源保留固定配额，并对每个途经点的发现来源设定上限。
- 同名异地缓存不自动选行，优先重新发现并仅在内存中使用路线上下文。
- 新发现发布后刷新共享目录；新增 100 个 canonical key 的 SVG 哈希唯一性测试。
- 新增 PGlite 仓储集成测试，覆盖迁移、insert/upsert/list/find、种子保留、verified-only 和 `last_verified_at`。

## Plan Self-Review

### Spec coverage

- 途经点独立 Tavily 搜索：Task 4、Task 6。
- DeepSeek 地区校核：Task 5、Task 7。
- 高、中、低置信度规则：Task 1、Task 5。
- 共享数据库和无账号：Task 2。
- 目的地本身和途经点本身建卡：Task 5、Task 6。
- 避免重复卡片：Task 2、Task 5、Task 6。
- 唯一 SVG 配图：Task 3、Task 5、Task 8。
- 动态卡片、筛选与来源显示：Task 8。
- 实时和长线行程接入：Task 7。
- 失败降级、搜索超时和并发控制：Task 4、Task 6、Task 7。
- UI 反馈：Task 8。
- 测试、开发预览、生产构建：Task 9。
- 安全与隐私：Global Constraints、Task 2、Task 8。

### Placeholder scan

计划中不使用 `TBD`、`TODO`、待实现或省略步骤。所有任务均包含明确文件、接口、失败测试、实现动作和验证命令。

### Type consistency

- `DiscoveredPlaceRecord` 的字段在 Task 2 定义，后续任务只使用同一组属性名。
- `RouteDiscoveryNotice` 与 `DiscoveryNotice` 字段保持同形。
- `renderSceneSvg()` 和 `sceneDataUrl()` 的参数在 Task 3 定义，Task 5 和 Task 8 复用。
- 公共灵感列表只返回 `verified`，候选记录不会进入 `getSharedInspirations()`。
