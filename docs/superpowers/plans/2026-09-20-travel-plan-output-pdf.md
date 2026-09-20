# 旅行规划输出与 PDF 路书 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 统一两种旅行入口，生成可执行行程，并导出 travel-guidebook 风格的 PDF 路书。

**Architecture:** 新增领域模型和纯调度引擎；高德与 DeepSeek 通过服务端适配器进入统一 TripPlan；React 结果页使用日期导航、执行时间轴和预算侧栏；PDF 由独立 HTML 渲染器和 Playwright 导出。

**Tech Stack:** React 19、TypeScript、TanStack Start、Zod、高德 Web Service/URI API、DeepSeek、Open-Meteo、Playwright、node:test。

**Spec:** `docs/superpowers/specs/2026-09-20-travel-plan-output-pdf-design.md`

## Global Constraints

- 所有界面文案和新增代码注释使用中文。
- API Key 只在服务端读取。
- 火车、飞机和轮船只做时间与费用估算，不查询班次。
- 所有费用和时间必须标记为估算。
- PDF 使用 travel-guidebook 暖色风格，无 AI 插图和 emoji。
- PDF 每天只有一个综合雷达，不生成单景点雷达。
- 每日 PDF 从新双页开始，内容多时自动扩展。
- PDF 页脚固定显示“内容由 AI 生成，旅游记得以实际为准哦”。

---

## File Structure

- `src/lib/travel-plan.ts`：TripPlan 类型、预算和雷达纯函数。
- `src/lib/travel-plan.test.ts`：领域模型测试。
- `src/lib/travel-schedule.ts`：执行时间轴编排。
- `src/lib/travel-schedule.test.ts`：时间轴测试。
- `src/lib/amap.server.ts`：高德 POI、路线、静态地图和导航适配器。
- `src/lib/amap.server.test.ts`：高德适配器测试。
- `src/lib/travel-plan.server.ts`：DeepSeek 景点审核、预算、总结与结束语。
- `src/lib/travel-plan.server.test.ts`：模型输出与降级测试。
- `src/lib/travel-plan.functions.ts`：TanStack 服务端函数。
- `src/components/planner/plan-output/`：结果页执行组件。
- `src/lib/guidebook-html.server.ts`：PDF HTML 渲染器。
- `src/lib/guidebook-html.server.test.ts`：路书 HTML 测试。
- `src/lib/guidebook-pdf.server.ts`：Playwright PDF 导出。
- `src/components/planner/plan-output/ExportGuidebookButton.tsx`：PDF 下载按钮。
- `src/components/planner/PlannerPrototype.tsx`：接入新字段和新结果组件。
- `scripts/browser-smoke.mjs`：旅行结果与下载路径浏览器检查。
- `package.json`：把新增测试文件加入 `npm test`。

---

### Task 1: 领域模型、预算与雷达纯函数

**Files:**
- Create: `src/lib/travel-plan.ts`
- Create: `src/lib/travel-plan.test.ts`
- Modify: `package.json` 的 `test` 脚本

**Interfaces:**
- Produces: `Travelers`、`BudgetCategory`、`TripBudget`、`AttractionAudit`、`DailyRadar`、`TripPlan`
- Produces: `estimateBudget(input: BudgetInput): TripBudget`
- Produces: `normalizeRadarScores(scores: number[], minimumSpread?: number): number[]`

- [ ] **Step 1: 写失败测试**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { estimateBudget, normalizeRadarScores } from "./travel-plan.ts";

test("adds a ten percent other budget with a minimum of 200", () => {
  const budget = estimateBudget({ transport: 1000, lodging: 500, food: 300, tickets: 200 });
  assert.equal(budget.other, 200);
  assert.equal(budget.total, 2200);
});

test("expands clustered radar scores without changing order", () => {
  assert.deepEqual(normalizeRadarScores([52, 55, 58, 61, 64]), [22, 43, 64, 85, 94]);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --experimental-strip-types --test src/lib/travel-plan.test.ts`
Expected: FAIL，提示模块不存在或导出不存在。

- [ ] **Step 3: 实现最小领域模型**

```ts
export type Travelers = { adults: number; children: number };
export type BudgetCategory = { amount: number; ratio: number };
export type TripBudget = {
  totalBudget: number;
  estimatedTotal: number;
  remaining: number;
  overBudget: number;
  perPersonBudget: number;
  perPersonEstimated: number;
  transport: BudgetCategory;
  lodging: BudgetCategory;
  food: BudgetCategory;
  tickets: BudgetCategory;
  other: BudgetCategory;
};
export type AttractionAudit = {
  scale: "small" | "medium" | "large" | "multi-day";
  durationHours: number;
  physical: number;
  childFit: number;
  weatherSensitivity: number;
  timeCost: number;
  crowding: number;
  bestTime: string;
};
export type DailyRadar = {
  physical: number;
  childFit: number;
  weatherSensitivity: number;
  timeCost: number;
  crowding: number;
};

export function normalizeRadarScores(scores: number[], minimumSpread = 60): number[] {
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  if (max - min >= minimumSpread) return scores.map((score) => Math.round(score));
  const center = scores.reduce((sum, score) => sum + score, 0) / scores.length;
  return scores.map((score) =>
    Math.round(Math.max(20, Math.min(90, center + (score - center) * 2))),
  );
}

export function estimateBudget(input: {
  transport: number;
  lodging: number;
  food: number;
  tickets: number;
  other?: number;
}) {
  const subtotal = input.transport + input.lodging + input.food + input.tickets;
  const other = input.other ?? Math.max(200, Math.round(subtotal * 0.1));
  return { ...input, other, total: subtotal + other };
}
```

- [ ] **Step 4: 更新测试脚本并运行**

在 `package.json` 的 `test` 命令中加入 `src/lib/travel-plan.test.ts`，运行：
`npm test`
Expected: 新增测试 PASS，原测试不回归。

- [ ] **Step 5: 提交**

```bash
git add package.json src/lib/travel-plan.ts src/lib/travel-plan.test.ts
git commit -m "feat: add travel plan domain model"
```

---

### Task 2: 执行时间轴编排引擎

**Files:**
- Create: `src/lib/travel-schedule.ts`
- Create: `src/lib/travel-schedule.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `AttractionAudit`、`TimelineNodeType` from `travel-plan.ts`
- Produces: `buildExecutionDays(input: ExecutionScheduleInput): TripDay[]`
- Produces: `resolveDayBounds(pace: Pace): { start: string; end: string }`

- [ ] **Step 1: 写失败测试**

```ts
test("night activity stays inside the same day", () => {
  const days = buildExecutionDays({
    startDate: "2026-09-20",
    days: 1,
    pace: "balanced",
    travelers: { adults: 2, children: 1 },
    routeNodes: ["西湖", "灵隐寺"],
    audits: {
      西湖: { scale: "large", durationHours: 7, physical: 6, childFit: 8, weatherSensitivity: 7, timeCost: 7, crowding: 9, bestTime: "上午" },
      灵隐寺: { scale: "medium", durationHours: 3, physical: 5, childFit: 6, weatherSensitivity: 4, timeCost: 4, crowding: 8, bestTime: "下午" },
    },
    nightActivity: "湖边夜游",
  });
  assert.equal(days[0]?.nodes.at(-2)?.type, "night-activity");
  assert.equal(days[0]?.nodes.at(-1)?.type, "rest");
});

test("pace controls the default day bounds", () => {
  assert.deepEqual(resolveDayBounds("relaxed"), { start: "09:30", end: "19:30" });
  assert.deepEqual(resolveDayBounds("deep"), { start: "08:00", end: "22:00" });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --experimental-strip-types --test src/lib/travel-schedule.test.ts`
Expected: FAIL，提示模块不存在。

- [ ] **Step 3: 实现调度引擎**

实现 `resolveDayBounds`、景点规模排序、跨日景点连续拆分、交通耗时占位、用餐/休息/酒店/夜游节点插入。每个节点必须有 `startTime`、`endTime`、`type`、`name`、`estimatedCost`、`navigation`。

- [ ] **Step 4: 运行单元测试**

Run: `npm test`
Expected: 时间轴顺序与夜游测试 PASS。

- [ ] **Step 5: 提交**

```bash
git add package.json src/lib/travel-schedule.ts src/lib/travel-schedule.test.ts
git commit -m "feat: add execution schedule engine"
```

---

### Task 3: 高德服务端适配器

**Files:**
- Create: `src/lib/amap.server.ts`
- Create: `src/lib/amap.server.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `createAmapClient(apiKey: string, fetchImpl?: typeof fetch): AmapClient`
- Produces: `buildStaticMapUrl(input: StaticMapInput): string`
- Produces: `buildNavigationUrl(input: NavigationInput): string`
- `AmapClient` 提供 `searchPoi`、`route`、`geocode`、`weather`

- [ ] **Step 1: 写失败测试**

```ts
test("builds separate outbound and return path styles", () => {
  const url = buildStaticMapUrl({
    outbound: [{ longitude: 120.15, latitude: 30.27 }, { longitude: 120.49, latitude: 30.74 }],
    returnPath: [{ longitude: 120.49, latitude: 30.74 }, { longitude: 120.15, latitude: 30.27 }],
    returnMode: "scenic",
  });
  assert.match(url, /0x4A7C8A/);
  assert.match(url, /0xC96442/);
});

test("returns a navigation URL with coordinates", () => {
  assert.match(buildNavigationUrl({ from: [120.15, 30.27], to: [120.49, 30.74], mode: "car" }), /uri\.amap\.com/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --experimental-strip-types --test src/lib/amap.server.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现高德客户端**

只用 `fetch`，读取 `AMAP_API_KEY` 由调用方传入。POI 使用高德关键字搜索，路线按交通方式选择接口，静态地图用 `paths` 和 `markers` 参数编码，导航链接使用 `uri.amap.com`。所有请求带超时和明确的错误信息。

- [ ] **Step 4: 运行测试**

Run: `npm test`
Expected: 高德 URL 编码、去程/返程路线和导航链接 PASS。

- [ ] **Step 5: 提交**

```bash
git add package.json src/lib/amap.server.ts src/lib/amap.server.test.ts
git commit -m "feat: add amap server adapter"
```

---

### Task 4: DeepSeek 景点审核、预算与每日总结

**Files:**
- Create: `src/lib/travel-plan.server.ts`
- Create: `src/lib/travel-plan.server.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `AttractionAudit`、`TripBudget`、`Travelers`
- Produces: `auditAttractionsWithDeepSeek(input, deps): Promise<AttractionAudit[]>`
- Produces: `estimateBudgetWithDeepSeek(input, deps): Promise<TripBudget>`
- Produces: `buildDaySummaryWithDeepSeek(input, deps): Promise<DaySummary>`
- Produces: `buildTripClosingWithDeepSeek(input, deps): Promise<TripClosing>`

- [ ] **Step 1: 写失败测试**

```ts
test("rejects a fabricated historical quote without a verified source", () => {
  assert.throws(
    () => parseTripClosing({ quote: "不存在的原文", source: "", message: "寄语" }),
    /引用必须提供可核验来源/,
  );
});

test("falls back to modern wording when quote is absent", () => {
  const closing = parseTripClosing({ quote: null, source: null, message: "山河万里，行者常新。" });
  assert.equal(closing.quote, null);
  assert.match(closing.message, /山河/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --experimental-strip-types --test src/lib/travel-plan.server.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现 DeepSeek 服务端逻辑**

严格 JSON 输出。景点审核必须返回规模、时长、五项评分和最佳时段。预算只返回估算区间与分类金额。结束语只允许引用具有可核验 `source` 的原文，否则设置 `quote: null` 并生成现代语言寄语。

- [ ] **Step 4: 运行测试**

Run: `npm test`
Expected: 景点审核、预算、引用校验和降级 PASS。

- [ ] **Step 5: 提交**

```bash
git add package.json src/lib/travel-plan.server.ts src/lib/travel-plan.server.test.ts
git commit -m "feat: add deepseek travel plan services"
```
---

### Task 5: 两种入口补齐用户输入

**Files:**
- Create: `src/components/planner/plan-output/TravelerBudgetFields.tsx`
- Modify: `src/components/planner/PlannerPrototype.tsx`
- Modify: `src/lib/travel-plan.test.ts`

**Interfaces:**
- Produces: `TravelerBudgetFields({ value, onChange })`
- Adds fields to `TripBrief`: `startTime`、`endTime`、`adults`、`children`、`totalBudget`、`vehicleEnergy`
- Produces: `validateTripBrief(brief: TripBrief): string[]`

- [ ] **Step 1: 写失败测试**

```ts
test("requires a total budget and at least one adult", () => {
  const errors = validateTripBrief({
    adults: 0,
    children: 1,
    totalBudget: 0,
    startTime: "09:00",
    endTime: "21:00",
  });
  assert.deepEqual(errors, ["至少需要 1 位成人", "请填写全团总预算"]);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --experimental-strip-types --test src/lib/travel-plan.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现输入组件和校验**

`TravelerBudgetFields` 包含成人数、儿童数、全团总预算、每日出发时间、每日最晚结束时间。选择自驾时显示燃油、纯电、混动。两个入口都复用该组件，并在提交前调用 `validateTripBrief`。

- [ ] **Step 4: 运行测试和类型检查**

Run: `npm test && npm run typecheck`
Expected: 输入校验测试 PASS，类型无错误。

- [ ] **Step 5: 提交**

```bash
git add src/components/planner/PlannerPrototype.tsx src/components/planner/plan-output/TravelerBudgetFields.tsx src/lib/travel-plan.ts src/lib/travel-plan.test.ts
git commit -m "feat: add traveler and budget inputs"
```

---

### Task 6: 屏幕端 B 布局执行结果

**Files:**
- Create: `src/components/planner/plan-output/TripOverview.tsx`
- Create: `src/components/planner/plan-output/ExecutionTimeline.tsx`
- Create: `src/components/planner/plan-output/BudgetPanel.tsx`
- Modify: `src/components/planner/PlannerPrototype.tsx`
- Create: `src/components/planner/plan-output/plan-output.test.tsx`

**Interfaces:**
- Consumes: `TripPlan`
- Produces: `<TripOverview plan={plan} />`
- Produces: `<ExecutionTimeline day={day} />`
- Produces: `<BudgetPanel budget={plan.budget} />`

- [ ] **Step 1: 写渲染测试**

```tsx
test("renders day navigation, timeline and budget", () => {
  const html = renderToStaticMarkup(<TripOverview plan={fixturePlan} />);
  assert.match(html, /DAY 01/);
  assert.match(html, /西湖核心环线/);
  assert.match(html, /全团总预算/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --experimental-strip-types --test src/components/planner/plan-output/plan-output.test.tsx`
Expected: FAIL。

- [ ] **Step 3: 实现屏幕端 B 布局**

左侧日期导航显示天数、城市、重点数量、预计花费和住宿地。右侧显示当前日执行时间轴。预算侧栏显示总额、预计费用、差额和饼图。节点必须包含时间、交通、用餐、休息、住宿与夜游。

- [ ] **Step 4: 运行测试与浏览器验证**

Run: `npm test && npm run typecheck`
Expected: 渲染测试 PASS；浏览器中可跨日期切换。

- [ ] **Step 5: 提交**

```bash
git add src/components/planner/PlannerPrototype.tsx src/components/planner/plan-output
git commit -m "feat: add executable travel plan layout"
```

---

### Task 7: travel-guidebook HTML 渲染器

**Files:**
- Create: `src/lib/guidebook-html.server.ts`
- Create: `src/lib/guidebook-html.server.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `TripPlan`
- Produces: `renderGuidebookHtml(plan: TripPlan): string`

- [ ] **Step 1: 写失败测试**

```ts
test("renders cover, daily radar and closing pages", () => {
  const html = renderGuidebookHtml(fixturePlan);
  assert.match(html, /旅行回望/);
  assert.match(html, /当日综合雷达/);
  assert.match(html, /致当代徐霞客/);
  assert.match(html, /内容由 AI 生成，旅游记得以实际为准哦/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --experimental-strip-types --test src/lib/guidebook-html.server.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现 HTML 渲染器**

按 A4 页面顺序输出封面、概览、路线、预算、每日双页、来源与结尾。每日左页包含地图、导航二维码、预算和当日综合雷达；右页只放执行时间轴与今日总结。今日总结使用 1/2/3 重点和历史背景。引用只能来自 `TripClosing.source`。

- [ ] **Step 4: 运行测试和 HTML 预览**

Run: `npm test`
Expected: HTML 结构、雷达和固定声明测试 PASS；将输出写入浏览器预览检查分页。

- [ ] **Step 5: 提交**

```bash
git add package.json src/lib/guidebook-html.server.ts src/lib/guidebook-html.server.test.ts
git commit -m "feat: render travel guidebook html"
```

---

### Task 8: PDF 导出和本地下载

**Files:**
- Create: `src/lib/guidebook-pdf.server.ts`
- Create: `src/lib/travel-plan.functions.ts`
- Create: `src/components/planner/plan-output/ExportGuidebookButton.tsx`
- Modify: `src/components/planner/PlannerPrototype.tsx`
- Modify: `package.json`

**Interfaces:**
- Consumes: `renderGuidebookHtml(plan)`
- Produces: `renderGuidebookPdf(html: string): Promise<Uint8Array>`
- Produces: `exportGuidebook` server function returning `{ status: "ok", pdfBase64, filename } | { status: "html", html, message }`
- Produces: `<ExportGuidebookButton plan={plan} />`

- [ ] **Step 1: 写失败测试**

```ts
test("falls back to printable html when chromium is unavailable", async () => {
  const result = await exportGuidebookForTest(fixturePlan, {
    renderPdf: async () => { throw new Error("chromium unavailable"); },
  });
  assert.equal(result.status, "html");
  assert.match(result.html, /江南水乡/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --experimental-strip-types --test src/lib/guidebook-pdf.server.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现 PDF 导出**

使用 Playwright Chromium、A4、`printBackground: true`，等待 `networkidle` 后导出。成功时返回 base64 供浏览器下载；失败时返回可打印 HTML。下载文件名使用 `{路线名称}_guidebook.pdf`。

- [ ] **Step 4: 运行测试和下载验证**

Run: `npm test && npm run typecheck`
Expected: 降级测试 PASS；浏览器点击下载按钮后得到 PDF 或打印页。

- [ ] **Step 5: 提交**

```bash
git add package.json src/lib/guidebook-pdf.server.ts src/lib/guidebook-pdf.server.test.ts src/lib/travel-plan.functions.ts src/components/planner/plan-output/ExportGuidebookButton.tsx src/components/planner/PlannerPrototype.tsx
git commit -m "feat: export travel guidebook pdf"
```

---

### Task 9: 往返路线回望与动态结束语

**Files:**
- Modify: `src/lib/amap.server.ts`
- Modify: `src/lib/travel-plan.server.ts`
- Modify: `src/lib/guidebook-html.server.ts`
- Modify: `src/lib/guidebook-html.server.test.ts`

**Interfaces:**
- Produces: `buildTripMapLayers(route: TripRoute): StaticMapLayer[]`
- Produces: `TripClosing.quote`、`TripClosing.source`、`TripClosing.message`
- Consumes: `returnMode: "fast" | "scenic" | null`

- [ ] **Step 1: 写失败测试**

```ts
test("scenic return draws a separate line", () => {
  const layers = buildTripMapLayers({ ...fixtureRoute, returnMode: "scenic" });
  assert.equal(layers.filter((layer) => layer.kind === "return").length, 1);
  assert.notEqual(layers[0].color, layers[1].color);
});

test("one-way trip has no return layer", () => {
  const layers = buildTripMapLayers({ ...fixtureRoute, returnMode: null });
  assert.equal(layers.some((layer) => layer.kind === "return"), false);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL。

- [ ] **Step 3: 实现往返图层与结束语校验**

快速返程使用虚线，scenic 返程使用独立实线，单程只有去程。结束语必须包含路线总结、旅行评价、鼓励和寄语；引用必须有篇名来源，没有来源时设置 `quote: null`。

- [ ] **Step 4: 运行测试**

Run: `npm test`
Expected: 三种返程模式和引用校验测试 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/lib/amap.server.ts src/lib/travel-plan.server.ts src/lib/guidebook-html.server.ts src/lib/guidebook-html.server.test.ts
git commit -m "feat: add return route recap and closing"
```

---

### Task 10: 缓存、降级与端到端验收

**Files:**
- Create: `src/lib/travel-plan-cache.server.ts`
- Create: `src/lib/travel-plan-cache.server.test.ts`
- Modify: `migrations/0004_travel_plan_cache.sql`
- Modify: `src/lib/travel-plan.functions.ts`
- Modify: `scripts/browser-smoke.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `getCachedTravelData(key: string): Promise<unknown | null>`
- Produces: `setCachedTravelData(key: string, value: unknown, expiresAt: Date): Promise<void>`
- Produces: cache keys: `amap:poi:`、`amap:route:`、`amap:static:`、`weather:`、`deepseek:plan:`

- [ ] **Step 1: 写失败测试**

```ts
test("returns cached data before expiry and drops expired data", async () => {
  await setCachedTravelData("amap:route:test", { distance: 100 }, new Date(Date.now() + 60000));
  assert.deepEqual(await getCachedTravelData("amap:route:test"), { distance: 100 });
  await setCachedTravelData("amap:route:expired", { distance: 1 }, new Date(Date.now() - 1000));
  assert.equal(await getCachedTravelData("amap:route:expired"), null);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --experimental-strip-types --test src/lib/travel-plan-cache.server.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现缓存和降级**

新增 PostgreSQL/PGlite 迁移，缓存高德 POI 30 天、路线 7 天、静态地图按节点集合、天气 1–6 小时、DeepSeek 结果按行程内容哈希。任何外部服务失败都返回结构化降级信息，不中断整个行程。

- [ ] **Step 4: 运行完整质量门禁**

Run: `npm test && npm run typecheck && npm run build`
Expected: 全部 PASS。

- [ ] **Step 5: 浏览器端到端验收**

在浏览器完成：
1. “我知道去哪”生成行程。
2. “帮我决定去哪”生成行程。
3. 添加途经点、往返和夜游。
4. 检查时间轴、预算、每日雷达、往返总结。
5. 下载 PDF 并检查页数、地图、引用和 AI 声明。

- [ ] **Step 6: 提交**

```bash
git add package.json migrations/0004_travel_plan_cache.sql src/lib/travel-plan-cache.server.ts src/lib/travel-plan-cache.server.test.ts src/lib/travel-plan.functions.ts scripts/browser-smoke.mjs
git commit -m "feat: cache and verify travel plan pipeline"
```