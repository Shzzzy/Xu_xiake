# AI 管家式路书生成 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把路书的排程权从本地调度器交给 DeepSeek（骨架 → 本地校验 → 最多 1 次带违规清单重排 → 并行文案），让摘要与排程天然一致，同时把「杂事开销」与预算 AI 推荐补齐。

**Architecture:** 新增四个纯模块（校验器、骨架解析、文案解析、编排器），改造适配器为「骨架 + 文案 + 数据 → TripPlan」，本地 `travel-schedule` 降级为兜底；模板、逐页预览、PDF 导出完全不动。新旧链路用环境开关 `BUTLER_PLANNER` 隔离，开关关闭时行为与今天一致。

**Tech Stack:** React 19 + TanStack Start 1.168 + TypeScript 5.7 + zod 4 + DeepSeek Chat Completions + 高德 + Tavily + node:test/tsx + Playwright。

**Spec:** `docs/superpowers/specs/2026-09-21-ai-butler-guidebook-design.md`

## Global Constraints

- 代码注释一律用中文。
- **任何删除操作（删文件、删大段内容）动手前必须单独列清单并等用户确认**；本计划中不含删除步骤。
- 页序与页数不变：`4 + 每天 2 页 + 3`。
- 调用上限：骨架最多尝试 3 次（技术重试与内容重排共用额度）；每日文案并行、每次 ≤ 1200 tokens；结尾 1 次、≤ 800 tokens。
- 违规处理：本地确定性判定 → 带违规清单重排，**内容重排只允许 1 次**；仍不合规则交付带提醒版本，不阻塞。
- 导航链接、静态地图、天气一律由本地补，模型不产出 URL。
- 历史引用必须带来源；无来源条目直接丢弃。
- 每个任务结束都要提交一次，提交信息用 `feat:` / `fix:` / `test:` 前缀（英文）。
- 验证命令：`npm run typecheck`、`npx tsx --test <文件>`、`npm test`、`npm run build:dev`（`npm run build` 会执行数据库迁移，除非用户明确同意否则不要跑）。
- 本地环境为 Windows：`npm run preview:restart` 不可用，构建产物验证用 `npm run preview`。

## File Structure

**新增**

| 文件 | 职责 |
| --- | --- |
| `src/lib/plan-validator.ts` | 违规清单类型 + 8 条确定性校验规则（纯函数） |
| `src/lib/plan-validator.test.ts` | 校验器单测 |
| `src/lib/planner-skeleton.ts` | 骨架类型、解析、提示词、重排指令（纯函数） |
| `src/lib/planner-skeleton.test.ts` | 骨架解析与重排指令单测 |
| `src/lib/planner-day-copy.ts` | 每日文案类型与解析（纯函数） |
| `src/lib/planner-day-copy.test.ts` | 文案解析单测 |
| `src/lib/planner-orchestrator.server.ts` | 编排：骨架 → 校验 → 重排 → 并行文案 → 结尾 |
| `src/lib/planner-orchestrator.server.test.ts` | 假响应契约测试 |
| `src/lib/budget-advice.server.ts` | 预算建议的提示词、解析与降级（服务端） |
| `src/lib/budget-advice.server.test.ts` | 预算建议单测 |
| `src/lib/budget-advice.functions.ts` | 预算建议 server function |

**修改**

| 文件 | 改动 |
| --- | --- |
| `src/lib/plan-output-adapter.ts` | 新增 `buildTripPlanFromSkeleton`；兜底路径的 `other` 不再传 0 |
| `src/lib/live-planner.functions.ts` | `generateLiveItinerary` 内按 `BUTLER_PLANNER` 分流，结果带 `mode` 与 `violations` |
| `src/components/planner/PlannerPrototype.tsx` | 接收 butler 结果、渲染约束提示条、把 violations 透传给组装器 |
| `src/components/planner/plan-output/TravelerBudgetFields.tsx` | 「AI 推荐」按钮 |
| `src/components/planner/plan-output/BudgetPanel.tsx` | 「其他 · 杂事开销」标签 + 说明 |
| `src/lib/guidebook-html.server.ts` | 预算页杂事开销说明、总览页约束提示、每日执行提醒补违规项 |
| `scripts/task-6-plan-output.e2e.test.mjs` | 一致性断言与提示条断言 |

---

### Task 1: 预算「其他 · 杂事开销」默认值与标签

**Files:**
- Modify: `src/lib/plan-output-adapter.ts`（`buildBudgetFromDays`）
- Modify: `src/components/planner/plan-output/BudgetPanel.tsx`
- Modify: `src/lib/guidebook-html.server.ts`（`renderBudget`）
- Test: `src/lib/plan-output-adapter.test.ts`、`src/components/planner/plan-output/plan-output.test.tsx`

**Interfaces:**
- Consumes: 现有 `estimateBudget`（`src/lib/travel-plan.ts`）——`other` 缺省时自动按前四类 10%、最低 ¥200 预留。
- Produces: 预算里 `other.amount > 0`，标签在网页与 PDF 中都为「其他 · 杂事开销」。

- [ ] **Step 1: 写失败测试**

在 `src/lib/plan-output-adapter.test.ts` 末尾加入：

```ts
test("其他项在兜底路径下按前四类 10% 预留", () => {
  const plan = buildTripPlanOutput({
    origin: "北京",
    destination: destinationFixture,
    startDate: "2026-09-21",
    days: 1,
    pace: "balanced",
    interests: ["自然山水"],
    waypoints: [],
    roundTrip: false,
    returnMode: null,
    travelers: { adults: 2, children: 0 },
    totalBudget: 8000,
    startTime: "09:00",
    endTime: "18:00",
    plannedDays: [{ day: 1, places: [placeFixture], note: "" }],
    routePlan: routePlanFixture,
  });
  assert.ok(plan.budget.other.amount >= 200, "杂事开销最低 ¥200");
  assert.ok(plan.budget.other.amount > 0, "不应再恒为 0");
});
```

在 `plan-output.test.tsx` 的渲染断言里补一行：

```tsx
assert.match(html, /其他 · 杂事开销/);
assert.match(html, /中途打车/);
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx tsx --test src/lib/plan-output-adapter.test.ts src/components/planner/plan-output/plan-output.test.tsx`
Expected: FAIL（other 为 0；页面文案里没有「其他 · 杂事开销」）

- [ ] **Step 3: 最小实现**

`src/lib/plan-output-adapter.ts` 中 `buildBudgetFromDays`：把 `other: exact(costs.other)` 改成「有费用才显式传，否则交给默认规则」：

```ts
other: costs.other > 0 ? exact(costs.other) : undefined,
```

`BudgetPanel.tsx` 的 `categoryDefinitions` 里把标签改掉，并补说明：

```tsx
{ key: "other", label: "其他 · 杂事开销", color: "#8b7a9e", dotClass: "bg-[#8b7a9e]" },
```

```tsx
{/* 杂事开销是零散支出，单独说明一次即可 */}
<p className="mt-3 text-[11px] leading-5 text-[var(--v-muted)]">
  杂事开销含中途打车、纪念品、零食与活动道具等零散支出，默认按前四类合计 10% 预留（最低 ¥200）。
</p>
```

`guidebook-html.server.ts` 的 `renderBudget` 中，把 `{ key: "other", label: "其他", ... }` 改为 `label: "其他 · 杂事开销"`，并在 `.budget-notes` 之后补同一句说明。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx tsx --test src/lib/plan-output-adapter.test.ts src/components/planner/plan-output/plan-output.test.tsx`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/lib/plan-output-adapter.ts src/lib/plan-output-adapter.test.ts src/components/planner/plan-output/BudgetPanel.tsx src/components/planner/plan-output/plan-output.test.tsx src/lib/guidebook-html.server.ts
git commit -m "feat: label other budget as incidentals with default reserve"
```

---

### Task 2: 预算建议服务（纯函数 + server function）

**Files:**
- Create: `src/lib/budget-advice.server.ts`
- Create: `src/lib/budget-advice.functions.ts`
- Test: `src/lib/budget-advice.server.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type BudgetAdvice = {
    total: number;
    categories: { transport: number; lodging: number; food: number; tickets: number; other: number };
    note: string;
  };
  export function parseBudgetAdvice(content: string): BudgetAdvice;      // 非法即抛错
  export function buildBudgetAdviceMessages(input: BudgetAdviceInput): unknown[];
  export async function requestBudgetAdvice(input: BudgetAdviceInput, deps?: { fetchImpl?: typeof fetch; apiKey?: string }): Promise<BudgetAdvice>;
  ```
- `BudgetAdviceInput`：`{ destination: string; region: string; days: number; travelers: { adults: number; children: number }; transportPreference: string; pace: string; interests: string[] }`

- [ ] **Step 1: 写失败测试**

```ts
test("预算建议解析合法 JSON 并保留分类", () => {
  const advice = parseBudgetAdvice(
    JSON.stringify({ total: 8600, categories: { transport: 2600, lodging: 2800, food: 1400, tickets: 1200, other: 600 }, note: "含黄山门票与山上住宿" }),
  );
  assert.equal(advice.total, 8600);
  assert.equal(advice.categories.other, 600);
});

test("预算建议拒绝缺少分类或负数", () => {
  assert.throws(() => parseBudgetAdvice(JSON.stringify({ total: 100, categories: {} })));
  assert.throws(() => parseBudgetAdvice(JSON.stringify({ total: -1, categories: { transport: 1, lodging: 1, food: 1, tickets: 1, other: 1 } })));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx tsx --test src/lib/budget-advice.server.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`budget-advice.server.ts` 用 zod 校验上面的结构，`requestBudgetAdvice` 调用 DeepSeek `chat/completions`（`response_format: { type: "json_object" }`、`max_tokens: 800`、`temperature: 0.2`、`AbortSignal.timeout(30_000)`），失败时抛出可读错误；提示词要求：按人数、天数、交通方式与目的地给出**全团**预算区间中值，并把「其他」定义为杂事开销。

`budget-advice.functions.ts`：

```ts
export const recommendBudget = createServerFn({ method: "POST" })
  .validator(z.object({ /* 与 BudgetAdviceInput 一致 */ }))
  .handler(async ({ data }) => {
    const key = process.env.DEEPSEEK_API_KEY?.trim();
    if (!key) return { status: "needs_configuration" as const, message: "缺少 DEEPSEEK_API_KEY" };
    try {
      return { status: "ok" as const, advice: await requestBudgetAdvice(data, { apiKey: key }) };
    } catch (error) {
      return { status: "failed" as const, message: error instanceof Error ? error.message : "预算建议失败" };
    }
  });
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx tsx --test src/lib/budget-advice.server.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/lib/budget-advice.server.ts src/lib/budget-advice.server.test.ts src/lib/budget-advice.functions.ts
git commit -m "feat: add budget advice service"
```

---

### Task 3: 表单接入「AI 推荐」按钮

**Files:**
- Modify: `src/components/planner/plan-output/TravelerBudgetFields.tsx`
- Modify: `src/components/planner/PlannerPrototype.tsx`（`KnownPlanScreen` 处注入回调）
- Test: `src/components/planner/plan-output/plan-output.test.tsx`

**Interfaces:**
- Consumes: `recommendBudget`（Task 2）
- Produces: `TravelerBudgetFields` 新增可选 prop：
  ```ts
  budgetAdvice?: { pending: boolean; hint?: string; onRequest: () => void };
  ```
  没有该 prop 时按钮不渲染（未知目的地向导里不出现）。

- [ ] **Step 1: 写失败测试**

```tsx
test("全团总预算旁提供 AI 推荐按钮", () => {
  const html = renderToStaticMarkup(
    <TravelerBudgetFields value={briefFixture} onChange={() => {}} budgetAdvice={{ pending: false, onRequest: () => {} }} />,
  );
  assert.match(html, /AI 推荐/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx tsx --test src/components/planner/plan-output/plan-output.test.tsx`
Expected: FAIL（没有该按钮）

- [ ] **Step 3: 实现**

在「全团总预算」`label` 内、输入框下方放一行按钮 + 提示；点击调用 `budgetAdvice.onRequest()`，`pending` 时文案为「正在估算…」并禁用。`PlannerPrototype` 的 `KnownPlanScreen` 里用 `useServerFn(recommendBudget)` 实现回调：成功后 `onBrief({ ...brief, totalBudget: advice.total })` 并 `toast.success(`建议预算 ¥${advice.total}`)`；失败或未配置时 `toast.error(...)`，不改动预算。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx tsx --test src/components/planner/plan-output/plan-output.test.tsx && npm run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/components/planner/plan-output/TravelerBudgetFields.tsx src/components/planner/PlannerPrototype.tsx src/components/planner/plan-output/plan-output.test.tsx
git commit -m "feat: add ai budget recommendation button"
```

---

### Task 4: 骨架类型、解析与提示词

**Files:**
- Create: `src/lib/planner-skeleton.ts`
- Test: `src/lib/planner-skeleton.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type PlannerSkeletonNode = {
    type: "transport" | "transfer" | "attraction" | "meal" | "rest" | "hotel" | "night-activity";
    startTime: string; endTime: string; name: string; location?: string;
    transportMode?: "economy" | "balanced" | "speed" | "train" | "flight" | "drive" | "bus" | "ship";
    transportMinutes?: number; stayMinutes?: number; estimatedCost: number; tips?: string;
  };
  export type PlannerSkeletonDay = { day: number; theme: string; nodes: PlannerSkeletonNode[]; radar: { physical: number; childFit: number; weatherSensitivity: number; timeCost: number; crowding: number } };
  export type PlannerSkeleton = { title: string; summary: string; days: PlannerSkeletonDay[] };
  export function parsePlannerSkeleton(content: string): PlannerSkeleton;
  export function buildSkeletonInstruction(input: SkeletonInstructionInput): string;
  export function buildSkeletonRepairInstruction(violations: PlanViolation[]): string;
  ```
- `SkeletonInstructionInput`：`{ brief, route, weather, candidates }`（candidates 为 `{ name: string; summary: string; source: string }[]`）

- [ ] **Step 1: 写失败测试**

```ts
test("骨架解析接受合法结构并保留节点顺序", () => {
  const skeleton = parsePlannerSkeleton(JSON.stringify(validSkeleton));
  assert.equal(skeleton.days[0]?.nodes.length, 3);
  assert.equal(skeleton.days[0]?.nodes[0]?.type, "attraction");
});

test("骨架解析拒绝缺失雷达或越界分值", () => {
  assert.throws(() => parsePlannerSkeleton(JSON.stringify({ ...validSkeleton, days: [{ day: 1, theme: "x", nodes: [] }] })));
  assert.throws(() => parsePlannerSkeleton(JSON.stringify(withRadar({ physical: 120 }))));
});

test("重排指令包含违规清单与两条硬约束", () => {
  const instruction = buildSkeletonRepairInstruction([
    { code: "OVER_BUDGET", message: "预计 9000 超出预算 8000", detail: { expected: "≤8000", actual: "9000" } },
  ]);
  assert.match(instruction, /只改/);
  assert.match(instruction, /不得引入/);
  assert.match(instruction, /9000/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx tsx --test src/lib/planner-skeleton.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

用 zod 定义骨架 schema（节点类型、时间格式 `/^\d{2}:\d{2}$/`、雷达 0–100、`days.min(1)`），`parsePlannerSkeleton` 解析并返回；`buildSkeletonInstruction` 生成中文提示词，写明：只能在候选里挑景点、不得输出 URL、时间必须落在用户窗口、必须包含用餐/住宿/休息节点、预算上限、节奏上限、标题与摘要必须与排程一致；`buildSkeletonRepairInstruction` 复用 `violationSummary`。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx tsx --test src/lib/planner-skeleton.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/lib/planner-skeleton.ts src/lib/planner-skeleton.test.ts
git commit -m "feat: add planner skeleton schema and prompts"
```

---

### Task 5: 违规清单与确定性校验器

**Files:**
- Create: `src/lib/plan-validator.ts`
- Test: `src/lib/plan-validator.test.ts`

**Interfaces:**
- Consumes: `PlannerSkeleton`（Task 4 定义，直接 `import type`）
- Produces:
  ```ts
  export type ViolationCode = "TIME_WINDOW" | "DAY_COVERAGE" | "MISSING_SLOT" | "OVER_BUDGET" | "OVER_CAPACITY" | "PACE_EXCEEDED" | "UNKNOWN_PLACE" | "TRANSPORT_CONFLICT";
  export type PlanViolation = { code: ViolationCode; day?: number; nodeIndex?: number; message: string; detail: { expected: string; actual: string } };
  export type PlanValidationInput = {
    skeleton: { days: { day: number; nodes: { type: string; startTime: string; endTime: string; name: string; stayMinutes?: number; estimatedCost: number }[] }[] };
    brief: { days: number; startTime: string; endTime: string; totalBudget: number; pace: "relaxed" | "balanced" | "deep"; transport: string | null; waypoints: string[]; destination: string };
    candidates: string[];
  };
  export function validateSkeleton(input: PlanValidationInput): PlanViolation[];
  export function violationSummary(violations: PlanViolation[]): string;   // 逐行中文，供提示条与重排指令复用
  ```

- [ ] **Step 1: 写失败测试**

覆盖 8 条规则，每条一个用例：

```ts
test("时间窗违规会被指出具体节点", () => {
  const violations = validateSkeleton({
    skeleton: skeletonWith({ endTime: "22:00" }),
    brief: balancedBrief({ endTime: "18:00" }),
    candidates: ["黄山风景区"],
  });
  assert.equal(violations[0]?.code, "TIME_WINDOW");
  assert.equal(violations[0]?.nodeIndex, 0);
});

test("预算超支按差额给出 detail", () => {
  const violations = validateSkeleton({ skeleton: skeletonWith({ estimatedCost: 9000 }), brief: balancedBrief({ totalBudget: 8000 }), candidates: ["黄山风景区"] });
  const budget = violations.find((item) => item.code === "OVER_BUDGET");
  assert.ok(budget);
  assert.match(budget.detail.actual, /9000/);
});

test("候选资料外的景点被判为未知地点", () => {
  const violations = validateSkeleton({ skeleton: skeletonWith({ name: "凭空古城" }), brief: balancedBrief({}), candidates: ["黄山风景区"] });
  assert.ok(violations.some((item) => item.code === "UNKNOWN_PLACE"));
});

test("缺少住宿与用餐会各报一条槽位违规", () => {
  const violations = validateSkeleton({ skeleton: skeletonMissingSlots(), brief: balancedBrief({}), candidates: ["黄山风景区"] });
  assert.deepEqual(violations.filter((item) => item.code === "MISSING_SLOT").map((item) => item.day), [1]);
});

// 其余四条同理：DAY_COVERAGE、OVER_CAPACITY、PACE_EXCEEDED、TRANSPORT_CONFLICT
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx tsx --test src/lib/plan-validator.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现八条规则**

关键实现要点（其余按同一模式补齐）：

```ts
const CAPACITY_MINUTES: Record<Pace, number> = { relaxed: 0, balanced: 0, deep: 0 }; // 用窗口分钟数代入
const PACE_LIMIT: Record<Pace, number> = { relaxed: 2, balanced: 3, deep: 4 };

function minutesOf(value: string): number | null {
  const matched = /^(\d{2}):(\d{2})$/.exec(value);
  if (!matched) return null;
  return Number(matched[1]) * 60 + Number(matched[2]);
}
```

- `TIME_WINDOW`：节点时间解析失败、早于 `brief.startTime`、晚于 `brief.endTime`、与前一节点重叠 → 各报一条，带 `day` 与 `nodeIndex`。
- `DAY_COVERAGE`：天数不等 → 一条（`detail.expected` = 用户天数）；某天无非休息节点 → 一天一条。
- `MISSING_SLOT`：每天检查 `meal`、`hotel`、`rest` 是否存在，缺哪个报哪个。
- `OVER_BUDGET`：全部 `estimatedCost` 求和 > 预算 → 一条，`detail` 写实际与上限。
- `OVER_CAPACITY`：当天景点 `stayMinutes` 合计 > 窗口分钟数 − 用餐 60 − 休息 30 − 交通（每个节点 `transportMinutes ?? 0`）→ 一天一条。
- `PACE_EXCEEDED`：当天 `attraction` + `night-activity` 数量 > `PACE_LIMIT[pace]` → 一天一条。
- `UNKNOWN_PLACE`：景点名不在 `candidates`（按去空格后的子串匹配）→ 一条，带 `nodeIndex`。
- `TRANSPORT_CONFLICT`：`brief.transport` 非空且节点里出现不匹配的交通方式 → 一条。

`violationSummary` 返回逐行中文，例如：
```
- [时间] 第 2 天 第 5 个节点结束时间 22:00 晚于你设定的 18:00（期望 ≤18:00，实际 22:00）
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx tsx --test src/lib/plan-validator.test.ts`
Expected: PASS（8 条规则用例全绿）

- [ ] **Step 5: 提交**

```bash
git add src/lib/plan-validator.ts src/lib/plan-validator.test.ts
git commit -m "feat: add deterministic plan validator"
```

---

### Task 6: 每日文案类型与解析

**Files:**
- Create: `src/lib/planner-day-copy.ts`
- Test: `src/lib/planner-day-copy.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type PlannerDayCopy = {
    day: number; purpose: string; highlights: string[]; cautions: string[];
    history: { title: string; background: string; source: string }[];
  };
  export function parsePlannerDayCopy(content: string): PlannerDayCopy;
  export function buildDayCopyInstruction(input: { day: number; theme: string; nodes: { name: string; type: string }[] }): string;
  ```

- [ ] **Step 1: 写失败测试**

```ts
test("文案解析丢弃没有来源的历史条目", () => {
  const copy = parsePlannerDayCopy(
    JSON.stringify({
      day: 1, purpose: "目的", highlights: ["黄山：奇松怪石"],
      cautions: ["注意保暖", "带雨具"],
      history: [{ title: "黄山", background: "背景", source: "《黄山志》" }, { title: "宏村", background: "背景", source: "" }],
    }),
  );
  assert.equal(copy.history.length, 1);
  assert.equal(copy.history[0]?.source, "《黄山志》");
});

test("文案解析拒绝少于两条注意事项", () => {
  assert.throws(() => parsePlannerDayCopy(JSON.stringify({ day: 1, purpose: "p", highlights: ["a：b"], cautions: ["只有一条"], history: [] })));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx tsx --test src/lib/planner-day-copy.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

zod schema + 清理函数：`highlights` 取 3–5 条、`cautions` 取 2–5 条、`history` 过滤空 source；`buildDayCopyInstruction` 生成提示词，要求只依据给定的当日节点写「今日目的 / 核心重点 / 注意事项 / 历史背景」，历史背景必须带可核验来源，给不出就不写。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx tsx --test src/lib/planner-day-copy.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/lib/planner-day-copy.ts src/lib/planner-day-copy.test.ts
git commit -m "feat: add planner day copy parser"
```

---

### Task 7: 编排器（骨架 → 校验 → 重排 → 并行文案 → 结尾）

**Files:**
- Create: `src/lib/planner-orchestrator.server.ts`
- Test: `src/lib/planner-orchestrator.server.test.ts`

**Interfaces:**
- Consumes: `validateSkeleton`（Task 5）、`parsePlannerSkeleton` / `buildSkeletonInstruction` / `buildSkeletonRepairInstruction`（Task 4）、`parsePlannerDayCopy` / `buildDayCopyInstruction`（Task 6）、`buildTripClosingWithDeepSeek`（已有）
- Produces:
  ```ts
  export type ButlerPlanResult =
    | { status: "ok"; skeleton: PlannerSkeleton; violations: PlanViolation[]; dayCopy: PlannerDayCopy[]; closing: TripClosing; attempts: number }
    | { status: "needs_configuration"; missing: string[] }
    | { status: "fallback"; reason: string };
  export async function planWithButler(input: ButlerPlanInput, deps?: ButlerDeps): Promise<ButlerPlanResult>;
  ```
  `ButlerDeps` 至少包含 `{ fetchImpl?: typeof fetch; apiKey?: string; tavilyKey?: string }`，便于契约测试注入假响应。

- [ ] **Step 1: 写契约测试（假 fetch）**

```ts
test("正常路径：骨架一次、文案按天并行、结尾一次", async () => {
  const calls: string[] = [];
  const result = await planWithButler(butlerInput, { apiKey: "k", fetchImpl: fakeFetch(calls) });
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.attempts, 1);
  assert.equal(result.dayCopy.length, 2);
  assert.equal(calls.filter((url) => url.includes("chat/completions")).length, 4); // 骨架 + 2 文案 + 结尾
});

test("首次骨架超预算时只重排一次", async () => {
  const result = await planWithButler(butlerInput, { apiKey: "k", fetchImpl: fakeFetchOverBudgetOnce() });
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.attempts, 2);
  assert.equal(result.violations.length, 0);
});

test("重排后仍不合规则带违规清单返回", async () => {
  const result = await planWithButler(butlerInput, { apiKey: "k", fetchImpl: fakeFetchOverBudgetAlways() });
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.attempts, 3);           // 1 正常 + 1 技术重试额度未用 + 1 重排
  assert.ok(result.violations.some((item) => item.code === "OVER_BUDGET"));
});

test("骨架连续失败后走兜底", async () => {
  const result = await planWithButler(butlerInput, { apiKey: "k", fetchImpl: failingFetch() });
  assert.equal(result.status, "fallback");
});

test("缺少 API key 时返回 needs_configuration", async () => {
  const result = await planWithButler(butlerInput, { apiKey: "" });
  assert.equal(result.status, "needs_configuration");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx tsx --test src/lib/planner-orchestrator.server.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

流程：取候选资料（无 Tavily key 时只用灵感库）→ 骨架请求（失败或解析错误计入 3 次额度）→ `validateSkeleton` → 有违规且未重排过：带上重排指令再请求一次 → 再校验 → 并行 `Promise.all` 发每日文案与结尾 → 汇总返回。任何阶段超时都不得抛出未捕获错误。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx tsx --test src/lib/planner-orchestrator.server.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/lib/planner-orchestrator.server.ts src/lib/planner-orchestrator.server.test.ts
git commit -m "feat: orchestrate butler plan with validation and repair"
```

---

### Task 8: 适配器新增「骨架 + 文案 + 数据 → TripPlan」

**Files:**
- Modify: `src/lib/plan-output-adapter.ts`
- Test: `src/lib/plan-output-adapter.test.ts`

**Interfaces:**
- Consumes: `PlannerSkeleton`、`PlannerDayCopy`、`TripClosing`、`RoutePlan`、`WeatherDay`
- Produces:
  ```ts
  export function buildTripPlanFromSkeleton(input: {
    skeleton: PlannerSkeleton;
    dayCopy?: PlannerDayCopy[];
    origin: string; destination: Destination; startDate: string;
    travelers: Travelers; totalBudget: number; pace: Pace; interests: string[];
    roundTrip: boolean; returnMode: ReturnMode; routePlan: RoutePlan;
    weather: WeatherDay[]; closing?: TripClosing; violations?: PlanViolation[];
    transportPreference: "economy" | "balanced" | "speed";
  }): TripPlan;
  ```

- [ ] **Step 1: 写失败测试**

```ts
test("骨架转 TripPlan 保留模型给的时间与费用", () => {
  const plan = buildTripPlanFromSkeleton(skeletonInputFixture);
  assert.equal(plan.days[0]?.nodes[0]?.startTime, "09:00");
  assert.equal(plan.days[0]?.estimatedCost, 320);
  assert.equal(plan.meta.title, "黄山2日徽州山水古村行程");
});

test("骨架转 TripPlan 用文案覆盖每日分析", () => {
  const plan = buildTripPlanFromSkeleton({ ...skeletonInputFixture, dayCopy: dayCopyFixture });
  assert.equal(plan.days[0]?.purpose, "把主景区放在体力最好的上午。");
});

test("缺少文案时退回本地默认文案", () => {
  const plan = buildTripPlanFromSkeleton(skeletonInputFixture);
  assert.ok((plan.days[0]?.purpose ?? "").length > 0);
  assert.ok((plan.days[0]?.cautions.length ?? 0) >= 2);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx tsx --test src/lib/plan-output-adapter.test.ts`
Expected: FAIL（`buildTripPlanFromSkeleton` 未定义）

- [ ] **Step 3: 实现**

逐日映射骨架节点（补 `timeLabel` = `startTime–endTime`、`navigation: null`），日期用 `addDays(startDate, index)`，天气取 `weather[index]`，当日费用为节点求和；文案优先、缺省时用与 `travel-schedule` 同款的本地兜底句子；`violations` 原样挂到返回的 `TripPlan` 上供 UI 使用（新增可选字段 `violations?: PlanViolation[]`）。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx tsx --test src/lib/plan-output-adapter.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/lib/plan-output-adapter.ts src/lib/plan-output-adapter.test.ts src/lib/travel-plan.ts src/lib/travel-plan.test.ts
git commit -m "feat: assemble trip plan from butler skeleton"
```

---

### Task 9: 服务端函数接线与开关

**Files:**
- Modify: `src/lib/live-planner.functions.ts`
- Test: `src/lib/live-planner.test.ts`

**Interfaces:**
- Consumes: `planWithButler`（Task 7）
- Produces: `LivePlanResult` 的 ok 分支新增 `mode: "butler" | "legacy"`；butler 模式额外返回 `skeleton`、`dayCopy`、`violations`、`attempts`。

- [ ] **Step 1: 写失败测试**

```ts
test("开关关闭时走原链路且 mode 为 legacy", async () => {
  const result = await runLivePlannerWith({ env: { BUTLER_PLANNER: "0" }, fetchImpl: fakeLegacyFetch() });
  assert.equal(result.status === "ok" && result.mode, "legacy");
});

test("开关打开时走管家链路并带回违规清单", async () => {
  const result = await runLivePlannerWith({ env: { BUTLER_PLANNER: "1" }, fetchImpl: fakeButlerFetch() });
  assert.equal(result.status === "ok" && result.mode, "butler");
  assert.ok(Array.isArray(result.status === "ok" ? result.violations : null));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx tsx --test src/lib/live-planner.test.ts`
Expected: FAIL（没有 mode 字段）

- [ ] **Step 3: 实现**

`generateLiveItinerary` 进入后读取 `process.env.BUTLER_PLANNER === "1"`：为真则调用 `planWithButler`，把结果映射为 `{ status:"ok", mode:"butler", skeleton, dayCopy, violations, attempts, closing, sources: [], discoveries: [] }`，兜底时沿用现有 `needs_configuration` / 本地兜底行为；为假时保持今天的返回结构并补 `mode:"legacy"`。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx tsx --test src/lib/live-planner.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/lib/live-planner.functions.ts src/lib/live-planner.test.ts
git commit -m "feat: switch live planner between butler and legacy modes"
```

---

### Task 10: 客户端接线与约束提示条

**Files:**
- Modify: `src/components/planner/PlannerPrototype.tsx`
- Modify: `src/lib/guidebook-html.server.ts`（总览页与每日执行提醒）
- Test: `src/lib/guidebook-html.server.test.ts`

**Interfaces:**
- Consumes: Task 9 的 `mode` / `skeleton` / `dayCopy` / `violations`；Task 8 的 `buildTripPlanFromSkeleton`
- Produces: `TripPlan.violations` 在结果页顶部、路书总览页、受影响日期的执行提醒中呈现。

- [ ] **Step 1: 写失败测试**

```ts
test("总览页展示未满足约束清单", () => {
  const html = renderGuidebookHtml({ ...fixturePlan, violations: [
    { code: "OVER_BUDGET", message: "预计 ¥18,420，超出预算 ¥420", detail: { expected: "≤¥18,000", actual: "¥18,420" } },
  ] });
  assert.match(html, /未满足/);
  assert.match(html, /18,420/);
});

test("受影响日期的执行提醒包含违规项", () => {
  const html = renderGuidebookHtml({ ...fixturePlan, violations: [
    { code: "TIME_WINDOW", day: 2, message: "第 2 天比设定结束时间晚 1 小时 30 分", detail: { expected: "≤18:00", actual: "19:30" } },
  ] });
  const dayRight = pageFragments(html, "day-right")[1];
  assert.match(dayRight ?? "", /未满足条件/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx tsx --test src/lib/guidebook-html.server.test.ts`
Expected: FAIL（没有提示条）

- [ ] **Step 3: 实现**

- `TripPlan` 增加可选 `violations`（Task 8 已加）。
- `PlannerPrototype`：butler 模式下用 `buildTripPlanFromSkeleton(...)` 生成 `executionPlan`；`violations` 非空时在结果 hero 下方渲染提示条（沿用原型的暖色告警样式：左侧 rust 竖线、标题「本次有 N 项未满足你设定的条件」、逐条消息、底部一句已尝试降级说明）。
- `guidebook-html.server.ts`：`renderOverview` 顶部插入同款提示块；`renderDaySummary` 的注意事项之前插入当天相关违规（`violations.filter(v => v.day === index + 1)`）。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx tsx --test src/lib/guidebook-html.server.test.ts src/components/planner/plan-output/plan-output.test.tsx && npm run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/components/planner/PlannerPrototype.tsx src/lib/guidebook-html.server.ts src/lib/guidebook-html.server.test.ts
git commit -m "feat: surface unmet constraints on page and guidebook"
```

---

### Task 11: 端到端验收与回归

**Files:**
- Modify: `scripts/task-6-plan-output.e2e.test.mjs`
- Test: 同上

**Interfaces:**
- Consumes: 全部前置任务
- Produces: 真实链路下的逐页路书 + 一致性断言

- [ ] **Step 1: 写失败断言**

在现有 e2e 的路书就绪断言之后加入：

```js
// 摘要里提到的景点必须出现在当天页面里（按名称双向匹配）
const summary = await page.locator("section.result-hero p").first().innerText();
const dayText = await guidebookFrame.locator("section.page").allInnerTexts();
const dayOneNames = ["黄山风景区", "屯溪老街"];
for (const name of dayOneNames) {
  assert.ok(summary.includes(name), `摘要缺少当天景点 ${name}`);
  assert.ok(dayText.some((text) => text.includes(name)), `路书缺少景点 ${name}`);
}

// 若出现约束提示条，则必须同时出现在执行提醒里
const banner = page.getByText(/未满足你设定的条件/);
if ((await banner.count()) > 0) {
  assert.ok((await guidebookFrame.getByText(/未满足条件/).count()) > 0, "提示条与执行提醒必须一致");
}
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test --test-concurrency=1 scripts/task-6-plan-output.e2e.test.mjs`
Expected: FAIL（摘要与页面尚未同源）

- [ ] **Step 3: 打开开关并跑通**

Run: `set BUTLER_PLANNER=1 && npm run dev` 起服务后重跑 Step 2 的命令；若本地不方便设置环境变量，则在 `.grok/app-env.json` 中临时加 `"BUTLER_PLANNER": "1"`（该文件只放 `VITE_` 前缀变量，因此开关改读 `process.env.BUTLER_PLANNER`，由启动命令注入）。
Expected: PASS

- [ ] **Step 4: 跑全套回归**

Run: `npm run typecheck && npm test && npm run build:dev`
Expected: 全绿

- [ ] **Step 5: 提交**

```bash
git add scripts/task-6-plan-output.e2e.test.mjs
git commit -m "test: assert summary matches scheduled guidebook"
```

---

### Task 12: 文档更新与切换说明

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-09-20-travel-plan-output-pdf-design.md`（§5 时间轴规则、§7 雷达）

- [ ] **Step 1: 更新 README**

在「功能」列表补一条：「AI 管家式排程：在人数、预算、交通与节奏条件内生成完整计划，摘要与每日排程同源」，并在「环境变量」补 `BUTLER_PLANNER`（=1 启用新链路）。

- [ ] **Step 2: 修订旧设计文档**

把 2026-09-20 设计文档里「时间轴由本地按容量重排」的表述改为「由 DeepSeek 在条件内排程，本地只做确定性校验与最多 1 次带清单重排」，并注明本文档由 2026-09-21 设计取代的部分。

- [ ] **Step 3: 提交**

```bash
git add README.md docs/superpowers/specs/2026-09-20-travel-plan-output-pdf-design.md
git commit -m "docs: document butler planner switch"
```

---

## Self-Review

**Spec coverage**

| 规格章节 | 对应任务 |
| --- | --- |
| §2 规则表 | Task 4（骨架）、Task 5（校验）、Task 7（上限）、Task 1–3（预算） |
| §5 生成时序 | Task 7 |
| §6 数据结构 | Task 4、6、8 |
| §7 校验与重排 | Task 4、5、7 |
| §8 失败降级 | Task 7（骨架/文案/结尾）、既有降级链路保持不变 |
| §9 调用预算 | Task 7 |
| §10 预算改动 | Task 1、2、3 |
| §11 新增视觉元素 | Task 10 |
| §12 测试与验收 | Task 4–8 单测、Task 7 契约、Task 11 e2e |
| §13 替换范围与迁移 | Task 8、9、12 |
| §14 风险与回滚 | Task 9 的开关 |

**Placeholder scan**：无 TBD/TODO；每个代码步骤都给出了可直接落地的代码或明确的规则表。

**Type consistency**：`PlannerSkeleton` / `PlannerDayCopy` / `PlanViolation` / `buildTripPlanFromSkeleton` / `planWithButler` / `violations` 在各任务中的命名与签名一致。

**已知未覆盖项**：Task 11 需要手工注入 `BUTLER_PLANNER=1`；这一步在实施时若发现更顺手的注入方式，可在该任务内调整并记录。
