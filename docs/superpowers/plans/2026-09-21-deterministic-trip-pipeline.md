# Deterministic Trip Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace model-authored timing, transport, capacity and pricing with a staged deterministic pipeline, validate every stage before the next starts, and stream only validated guidebook pages.

**Architecture:** A `TripPlanningRun` state machine coordinates local AMap/Tavily/DeepSeek stages. AMap provides route/POI facts, local modules calculate transport time, daily capacity, price arithmetic and budgets, and DeepSeek is restricted to attraction selection/analysis/narrative. Each stage has a typed output and validator; failed stages are retried or degraded locally before downstream work begins.

**Tech Stack:** React 19, TanStack Start, TypeScript 5.7, zod 4, node:test, AMap server client, Tavily, DeepSeek Chat Completions.

**Spec:** `docs/superpowers/specs/2026-09-21-deterministic-trip-pipeline-design.md`

## Global Constraints

- All code comments and user-facing copy are Chinese.
- Any delete operation requires explicit user approval first.
- Long-distance default: cross-province and one-way distance >= 800 km uses flight unless the user explicitly chose `drive` or `train`.
- Non-driving transport prices must use Tavily references plus a local per-person minimum; self-driving uses local vehicle arithmetic.
- Prices are per person, then multiplied by traveler count and leg count. Lodging uses rooms x nights.
- DeepSeek never calculates final time or total price. It only selects candidates and writes copy.
- A stage cannot run before its predecessor passes; a daily page cannot stream before that day passes validation.
- Page events carry `runId`, `index`, and `checksum`; stale or duplicate pages are ignored by the client.
- PDF export is disabled until all required pages pass validation.
- Do not run `npm run build` without explicit approval because it executes database migration; use `npm run build:dev`.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/lib/planning-run.ts` | Run ID, stage enum, stage status/result types, transition guards |
| `src/lib/planning-run.test.ts` | State-machine tests |
| `src/lib/transport-planner.server.ts` | Mode selection, door-to-door time, per-person transport price floor |
| `src/lib/transport-planner.server.test.ts` | Route-mode and per-person price tests |
| `src/lib/day-timeline.ts` | Deterministic day capacity and timeline assembly |
| `src/lib/day-timeline.test.ts` | Commute deduction, attraction insertion and rest fallback tests |
| `src/lib/budget-planner.ts` | Deterministic transport/lodging/food/tickets/other arithmetic |
| `src/lib/budget-planner.test.ts` | Per-person, room/night and total arithmetic tests |
| `src/lib/planner-context.server.ts` | AMap POI discovery, filtering, geo clustering and price references |
| `src/lib/planner-orchestrator.server.ts` | Sequential stage coordinator and repair boundaries |
| `src/lib/guidebook-stream.server.ts` | Validate-before-push page streaming with run metadata |
| `src/components/planner/plan-output/GuidebookPreview.tsx` | Run-bound page consumer, fixed-height preview and cancellation |
| `scripts/task-6-plan-output.e2e.test.mjs` | Real golden journey and page-stream assertions |

---

### Task 1: Planning Run State Machine

**Files:**
- Create: `src/lib/planning-run.ts`
- Create: `src/lib/planning-run.test.ts`

**Interfaces:**
- Produces:
```ts
export const PLANNING_STAGES = ["route", "pois", "selection", "timeline", "prices", "budget", "narrative", "pages"] as const;
export type PlanningStage = (typeof PLANNING_STAGES)[number];
export type StageStatus = "pending" | "running" | "passed" | "failed" | "degraded";
export type PlanningRun = { id: string; stages: Record<PlanningStage, { status: StageStatus; error?: string }> };
export function createPlanningRun(id: string): PlanningRun;
export function canStartStage(run: PlanningRun, stage: PlanningStage): boolean;
export function setStageStatus(run: PlanningRun, stage: PlanningStage, status: StageStatus, error?: string): PlanningRun;
```

- [ ] **Step 1: Write the failing test**
```ts
test("后续阶段在前置阶段通过前不能启动", () => {
  const run = createPlanningRun("run-1");
  assert.equal(canStartStage(run, "pois"), false);
  const routePassed = setStageStatus(run, "route", "passed");
  assert.equal(canStartStage(routePassed, "pois"), true);
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `npx tsx --test src/lib/planning-run.test.ts`
Expected: FAIL because the module does not exist.

- [ ] **Step 3: Write minimal implementation**
Implement immutable updates and a guard that permits a stage only when all earlier stages are `passed` or `degraded`.

- [ ] **Step 4: Run test to verify it passes**
Run: `npx tsx --test src/lib/planning-run.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/lib/planning-run.ts src/lib/planning-run.test.ts
git commit -m "feat: add planning run state machine"
```

### Task 2: Deterministic Transport Planner

**Files:**
- Create: `src/lib/transport-planner.server.ts`
- Create: `src/lib/transport-planner.server.test.ts`
- Modify: `src/lib/planner-context.server.ts`

**Interfaces:**
- Consumes: AMap geocodes and route legs.
- Produces:
```ts
export type TransportPlanLeg = {
  id: string;
  kind: "outbound" | "return";
  from: string;
  to: string;
  distanceKm: number;
  mode: "flight" | "train" | "drive" | "bus" | "ship";
  doorToDoorMinutes: number;
  minimumPerPersonCost: number;
};
export function chooseLongDistanceMode(input: { explicit?: string | null; crossProvince: boolean; distanceKm: number }): TransportPlanLeg["mode"];
export function calculateTransportLeg(input: { mode: TransportPlanLeg["mode"]; distanceKm: number; travelers: number }): Pick<TransportPlanLeg, "doorToDoorMinutes" | "minimumPerPersonCost">;
```

- [ ] **Step 1: Write failing tests**
```ts
test("跨省 1963 公里通用偏好默认飞机", () => {
  assert.equal(chooseLongDistanceMode({ explicit: "balanced", crossProvince: true, distanceKm: 1963 }), "flight");
});
test("5 人往返运输按单人价格累加", () => {
  const leg = calculateTransportLeg({ mode: "flight", distanceKm: 1963, travelers: 5 });
  assert.ok(leg.minimumPerPersonCost >= 1000);
  assert.equal(leg.doorToDoorMinutes >= 300, true);
});
```

- [ ] **Step 2: Run tests to verify they fail**
Run: `npx tsx --test src/lib/transport-planner.server.test.ts`
Expected: FAIL because functions are undefined.

- [ ] **Step 3: Implement mode and arithmetic**
Use flight for cross-province >= 800 km when preference is generic. Flight door-to-door is at least 300 minutes; train at least 180; drive uses AMap route duration plus rest. Non-drive cost is per person.

- [ ] **Step 4: Run tests**
Run: `npx tsx --test src/lib/transport-planner.server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/lib/transport-planner.server.ts src/lib/transport-planner.server.test.ts src/lib/planner-context.server.ts
git commit -m "feat: make long-distance transport deterministic"
```

### Task 3: AMap POI Discovery, Filtering and Geo Clustering

**Files:**
- Modify: `src/lib/planner-context.server.ts`
- Modify: `src/lib/planner-context.server.test.ts`

**Interfaces:**
- Produces:
```ts
export type DestinationCandidate = { id: string; name: string; address: string; type: string; location: [number, number]; publicUrl: string; areaKey: string };
export function clusterCandidates(candidates: DestinationCandidate[], maxPerDay: number): DestinationCandidate[][];
```
- Candidate exact query must run before generic queries; generic city query results are accepted only when they contain destination or region text.

- [ ] **Step 1: Write failing tests**
```ts
test("特定景区名称不会被错误解析成北京地标", async () => {
  const result = await searchAmapDestinationCandidates({ client: fakeClientReturningBeijing, destination: "北海银滩", region: "广西" });
  assert.equal(result.some((item) => item.name.includes("故宫")), false);
});
test("同区域景点优先聚到同一天", () => {
  const groups = clusterCandidates(fixtureCandidates, 3);
  assert.ok(groups.some((group) => group.map((item) => item.name).includes("西湖")));
});
```

- [ ] **Step 2: Run tests to verify they fail**
Run: `npx tsx --test src/lib/planner-context.server.test.ts`
Expected: FAIL for missing `clusterCandidates` or wrong fallback.

- [ ] **Step 3: Implement exact-first search, non-scenic filtering, stable dedupe and area clustering**
Remove lodging/food/shopping POIs. Use coordinates to group candidates with a deterministic nearest-area pass.

- [ ] **Step 4: Run tests**
Run: `npx tsx --test src/lib/planner-context.server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/lib/planner-context.server.ts src/lib/planner-context.server.test.ts
git commit -m "feat: filter and cluster destination candidates"
```

### Task 4: Deterministic Day Timeline

**Files:**
- Create: `src/lib/day-timeline.ts`
- Create: `src/lib/day-timeline.test.ts`
- Modify: `src/lib/planner-orchestrator.server.ts`

**Interfaces:**
- Consumes: `PlannerSkeletonDay`, route `TransportPlanLeg[]`, weather and attraction candidates.
- Produces:
```ts
export type TimelineBuildInput = {
  day: PlannerSkeletonDay;
  startTime: string;
  endTime: string;
  transportMinutes: number;
  meals: number[];
  restMinutes: number;
  attractions: { name: string; stayMinutes: number }[];
};
export function buildDayTimeline(input: TimelineBuildInput): PlannerSkeletonNode[];
```
- Rule: subtract transport, meals, rest and hotel before attraction allocation. If less than 75 minutes remain after travel, use no attraction and mark a restful day.

- [ ] **Step 1: Write failing tests**
```ts
test("通勤时间从可用游玩时间扣除", () => {
  const nodes = buildDayTimeline({ day, startTime: "09:00", endTime: "18:00", transportMinutes: 300, meals: [60, 60], restMinutes: 30, attractions: [attraction] });
  assert.equal(nodes.some((node) => node.type === "attraction"), false);
});
test("充足剩余时间必须插入真实景点", () => {
  const nodes = buildDayTimeline({ day, startTime: "08:00", endTime: "20:00", transportMinutes: 60, meals: [60, 60], restMinutes: 30, attractions: [attraction] });
  assert.ok(nodes.some((node) => node.type === "attraction" && node.name === attraction.name));
});
```

- [ ] **Step 2: Run tests to verify they fail**
Run: `npx tsx --test src/lib/day-timeline.test.ts`
Expected: FAIL because `buildDayTimeline` is missing.

- [ ] **Step 3: Implement deterministic timeline construction**
Create transport, meal, rest, hotel and attraction nodes in chronological order, with no overlaps.

- [ ] **Step 4: Run tests**
Run: `npx tsx --test src/lib/day-timeline.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/lib/day-timeline.ts src/lib/day-timeline.test.ts src/lib/planner-orchestrator.server.ts
git commit -m "feat: build timelines from capacity not model filler"
```

### Task 5: Deterministic Budget Engine and Price Provenance

**Files:**
- Create: `src/lib/budget-planner.ts`
- Create: `src/lib/budget-planner.test.ts`
- Modify: `src/lib/planner-orchestrator.server.ts`
- Modify: `src/lib/guidebook-html.server.ts`

**Interfaces:**
- Produces:
```ts
export type PriceReference = { kind: "transport" | "ticket"; label: string; amount: number; currency: "CNY"; source?: string; confidence: "verified" | "reference" | "fallback" };
export type BudgetPlanInput = { travelers: { adults: number; children: number }; days: number; transport: TransportPlanLeg[]; ticketPrices: PriceReference[]; lodgingPerNight: number; foodPerPersonPerDay: number };
export function calculateBudget(input: BudgetPlanInput): { transport: number; lodging: number; food: number; tickets: number; other: number; estimatedTotal: number };
```
- Arithmetic: transport per person, lodging `ceil(travelers / 2) * max(0, days - 1)`, food `travelers * days * foodPerPersonPerDay`, other `max(200, subtotal * 0.1)`.

- [ ] **Step 1: Write failing tests**
```ts
test("5 人往返交通按单人价格乘人数和段数", () => {
  const budget = calculateBudget({ travelers: { adults: 5, children: 0 }, days: 5, transport: [flightLeg, returnFlightLeg], ticketPrices: [], lodgingPerNight: 500, foodPerPersonPerDay: 150 });
  assert.ok(budget.transport >= 10000);
  assert.ok(budget.lodging >= 4000);
  assert.equal(budget.estimatedTotal, budget.transport + budget.lodging + budget.food + budget.tickets + budget.other);
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `npx tsx --test src/lib/budget-planner.test.ts`
Expected: FAIL because budget planner is missing.

- [ ] **Step 3: Implement arithmetic and price provenance**
Every price reference keeps source and confidence. Low-confidence values are marked `参考价` in output.

- [ ] **Step 4: Run tests**
Run: `npx tsx --test src/lib/budget-planner.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/lib/budget-planner.ts src/lib/budget-planner.test.ts src/lib/planner-orchestrator.server.ts src/lib/guidebook-html.server.ts
git commit -m "feat: enforce per-person deterministic budgets"
```

### Task 6: Sequential Attraction Selection and Repair

**Files:**
- Modify: `src/lib/planner-orchestrator.server.ts`
- Modify: `src/lib/planner-skeleton.ts`
- Modify: `src/lib/plan-validator.ts`
- Modify: `src/lib/planner-skeleton.test.ts`

**Interfaces:**
- DeepSeek selection output contains only `day`, `candidateId`, `sequence`, `stayMinutes`, `reason`.
- Local validator rejects candidate IDs not in the current run.

- [ ] **Step 1: Write failing tests**
```ts
test("模型不能在候选之外新增景点", () => {
  const selection = parseAttractionSelection(JSON.stringify([{ day: 1, candidateId: "missing", sequence: 1, stayMinutes: 120, reason: "测试" }]), new Set(["poi-1"]));
  assert.throws(() => validateAttractionSelection(selection, new Set(["poi-1"])), /候选/);
});
test("每一步失败后不会调用下一步", async () => {
  const stages: string[] = [];
  await runDeterministicPipeline({ onStage: (stage) => stages.push(stage), failAt: "selection" });
  assert.deepEqual(stages, ["route", "pois", "selection"]);
});
```

- [ ] **Step 2: Run tests to verify they fail**
Run: `npx tsx --test src/lib/planner-orchestrator.server.test.ts src/lib/planner-skeleton.test.ts`
Expected: FAIL because stage sequencing or candidate-ID validation is missing.

- [ ] **Step 3: Implement stage coordinator and one repair per selection stage**
Do not allow timeline or budget work when selection fails.

- [ ] **Step 4: Run tests**
Run: `npx tsx --test src/lib/planner-orchestrator.server.test.ts src/lib/planner-skeleton.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/lib/planner-orchestrator.server.ts src/lib/planner-skeleton.ts src/lib/plan-validator.ts src/lib/planner-skeleton.test.ts
git commit -m "feat: validate attraction selection before timeline"
```

### Task 7: Sequential Daily Narrative and Page Protocol

**Files:**
- Modify: `src/lib/planner-orchestrator.server.ts`
- Modify: `src/lib/guidebook-stream.server.ts`
- Modify: `src/lib/guidebook-narrative.server.ts`
- Modify: `src/lib/guidebook-stream.server.test.ts`

**Interfaces:**
- Produces page events:
```ts
type GuidebookPageEvent = { type: "page"; runId: string; index: number; id: string; label: string; checksum: string; html: string };
```
- Daily narrative must finish validation before its two pages are emitted. A failed day emits a validated fallback page and continues.

- [ ] **Step 1: Write failing tests**
```ts
test("第 2 天文案未校验通过前不会推送第 2 天页面", async () => {
  const events: GuidebookPageEvent[] = [];
  await streamGuidebookPages(plan, { onEvent: (event) => events.push(event), failNarrativeDay: 2 });
  assert.equal(events.some((event) => event.index === dayTwoMapIndex), false);
});
test("重复 checksum 页面被忽略", () => {
  const state = createPreviewState("run-1");
  assert.equal(acceptPage(state, pageEvent), true);
  assert.equal(acceptPage(state, pageEvent), false);
});
```

- [ ] **Step 2: Run tests to verify they fail**
Run: `npx tsx --test src/lib/guidebook-stream.server.test.ts`
Expected: FAIL because run metadata and page checksum are missing.

- [ ] **Step 3: Implement page checksums, run IDs and sequential day gates**
Generate narrative day N, validate it, render its pages, then continue to day N+1.

- [ ] **Step 4: Run tests**
Run: `npx tsx --test src/lib/guidebook-stream.server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/lib/planner-orchestrator.server.ts src/lib/guidebook-stream.server.ts src/lib/guidebook-narrative.server.ts src/lib/guidebook-stream.server.test.ts
git commit -m "feat: stream only validated guidebook pages"
```

### Task 8: Preview Client Run Fencing and Stable Layout

**Files:**
- Modify: `src/components/planner/plan-output/GuidebookPreview.tsx`
- Modify: `src/styles.css`
- Modify: `src/components/planner/PlannerPrototype.tsx`

**Interfaces:**
- Consumes page events from Task 7.
- Keeps `runId` in a ref; ignores an event whose run is not current.
- Fixed-height shell, internal scroll, no outer document growth, no duplicate page.

- [ ] **Step 1: Write failing component test**
```tsx
test("旧 runId 的页面不会写入当前预览", () => {
  const accepted = shouldAcceptPage({ runId: "old", latestRunId: "new", checksum: "a", seen: new Set() });
  assert.equal(accepted, false);
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `npx tsx --test src/components/planner/plan-output/plan-output.test.tsx`
Expected: FAIL because `shouldAcceptPage` is missing.

- [ ] **Step 3: Implement run fencing, fixed-height scroll and center paper**
Abort the previous fetch when plan key changes. Keep the outer shell height fixed and remove inner iframe scrollbars.

- [ ] **Step 4: Run test and typecheck**
Run: `npx tsx --test src/components/planner/plan-output/plan-output.test.tsx && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/components/planner/plan-output/GuidebookPreview.tsx src/styles.css src/components/planner/PlannerPrototype.tsx src/components/planner/plan-output/plan-output.test.tsx
git commit -m "feat: fence preview pages by run"
```

### Task 9: Golden End-to-End Journey

**Files:**
- Modify: `scripts/task-6-plan-output.e2e.test.mjs`
- Create: `src/lib/trip-pipeline.golden.test.ts`

**Interfaces:**
- Golden journey: Beijing -> Sichuan, 5 travelers, 5 days, round trip.

- [ ] **Step 1: Write failing assertions**
```js
assert.match(heroText, /飞机|航班/);
assert.match(budgetText, /交通\s*¥(?!1,?320)\d{4,}/);
assert.ok(candidateCount > 0);
assert.ok(dayTimelineText.includes("景点"));
assert.doesNotMatch(dayTimelineText, /^.*自由活动.*自由活动.*$/s);
```

- [ ] **Step 2: Run E2E to verify it fails on old behavior**
Run: `node --test --test-concurrency=1 scripts/task-6-plan-output.e2e.test.mjs`
Expected: FAIL before the deterministic pipeline is wired.

- [ ] **Step 3: Wire the pipeline and preserve legacy fallback behind `BUTLER_PLANNER`**
Legacy remains available when the switch is off. Deterministic pipeline is used when it is on.

- [ ] **Step 4: Run full verification**
Run: `npm run typecheck && npm test && npm run build:dev`
Expected: all pass.

- [ ] **Step 5: Commit**
```bash
git add scripts/task-6-plan-output.e2e.test.mjs src/lib/trip-pipeline.golden.test.ts
git commit -m "test: verify deterministic trip pipeline end to end"
```

### Task 10: Documentation and Rollout Notes

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-09-21-deterministic-trip-pipeline-design.md`

- [ ] **Step 1: Document the staged pipeline and switch**

Add the stage list, API roles, price provenance, cache behavior, and `BUTLER_PLANNER` rollout notes.

- [ ] **Step 2: Run documentation checks**
Run: `git diff --check`
Expected: exit 0.

- [ ] **Step 3: Commit**
```bash
git add README.md docs/superpowers/specs/2026-09-21-deterministic-trip-pipeline-design.md
git commit -m "docs: document deterministic trip pipeline"
```
