# Task 9 报告：确定性旅行管线接入生产链路


## 状态

已完成并提交。

- 实现提交：`58ec775` `feat: wire deterministic trip pipeline`
- 分支：`codex/ai-butler-guidebook`
- `BUTLER_PLANNER=1` 走确定性管线；`BUTLER_PLANNER=0` 保持 legacy。
- 确定性阶段失败时服务端 fail closed，不再静默切回 legacy。

## 已完成内容

1. **生产阶段机接线**
   - `planWithButler` 现在真实调用 `runDeterministicPipeline`。
   - 固定顺序：`route → pois → selection → timeline → prices → budget → narrative → pages`。
   - 每个 handler 显式返回 `{ handled: true }`。
   - 任一阶段 final failure 立即停止，后续阶段不会启动。

2. **候选 ID 全链路保留**
   - `SharedPlannerContext`、`ButlerPlanInput`、`ButlerPlanResult` 保留高德候选的 `id/name/summary/source/location/address/type/publicUrl/areaKey`。
   - selection 只接受候选 `candidateId`。
   - 越界或格式非法时只修复一次；仍失败则终止在 `selection`，不会请求文案、预算或页面。
   - 兼容 DeepSeek `json_object` 的 `{ selections: [...] }` 包装，同时兼容直接数组。

3. **交通确定性**
   - 使用 `prepareRouteTransportPlan` 产出的 `TransportPlanLeg[]`。
   - route/timeline/budget 不再重新猜交通方式。
   - 长途 ≥800 km、跨省、通用偏好默认飞机。
   - 交通按单人最低价 × 人数 × 去返 leg 计算，Tavily/模型不能把价格压到本地最低价以下。

4. **时间轴确定性**
   - 通勤、换乘、用餐、休息、酒店先从每日容量扣除，再排当天选中景点。
   - 移动日按剩余容量少量安排；非移动日必须包含真实候选景点。
   - 不再出现所有日期都填“自由活动/自由休整”的确定性问题。

5. **预算确定性**
   - 调用 `calculateBudget`。
   - 住宿按 `ceil(人数/2)` 房间 × `days - 1` 晚。
   - 餐饮按人数 × 天数。
   - 门票按当前确定性参考价乘同行人数。
   - 其他按前四项 10%、最低 ¥200。
   - UI/PDF 的 `TripPlan.budget` 优先使用确定性预算，不再被模型节点费用覆盖。
   - 交通、路线距离/门到门时长从归一化 leg 进入 `TripRoute`。

6. **逐日文案与页流**
   - 每日文案继续逐日生成、逐日校验。
   - 单日失败只降级当天，继续后续日期。
   - 保持 runId + index + checksum 页流协议，不破坏既有预览/PDF 固化逻辑。

7. **Golden 验收**
   - 新增 `src/lib/trip-pipeline.golden.test.ts`。
   - 覆盖北京→四川约 1964 km、5 人、5 天、往返：
     - 默认 flight；
     - 单程距离 ≥1963 km；
     - 交通预算 ≥¥10,800；
     - 住宿数量为 3 间 × 4 晚 = 12 间夜；
     - 非移动日必须出现真实候选景点；
     - 越界 selection 最多修复一次，且不触达文案/预算/页面阶段。
   - 新 Golden 已加入 `npm test` 标准入口。

## 修改文件

- `package.json`
- `src/components/planner/PlannerPrototype.tsx`
- `src/lib/live-planner.functions.ts`
- `src/lib/live-planner.test.ts`
- `src/lib/plan-output-adapter.ts`
- `src/lib/plan-output-adapter.test.ts`
- `src/lib/planner-orchestrator.server.ts`
- `src/lib/planner-orchestrator.server.test.ts`
- `src/lib/planner-skeleton.ts`
- `src/lib/planner-skeleton.test.ts`
- `src/lib/trip-pipeline.golden.test.ts`

## 验收命令与结果

- `npm run typecheck`：通过。
- `npm test`：通过。
  - E2E：2/2 通过。
  - 单元与集成测试：402/402 通过。
  - 组件测试：11/11 通过。
- `npm run build:dev`：通过。
- `git diff --check`：通过。

## 剩余风险

1. 门票、住宿、餐饮当前使用本地确定性参考价；Task 10 可继续接入 Tavily 门票资料并记录来源/置信度。
2. 多 leg 同时落在同一天时，时间轴只对第一条 transport leg 做详细命名，其余 leg 的时长仍计入总交通容量；后续可按 leg 渲染多个交通节点。
3. 旧 legacy 编排辅助函数仍保留在 `planner-orchestrator.server.ts` 中但不再被生产入口调用；删除需单独确认。
4. 历史别名行政映射仍采用显式白名单；新增类似“徽州→黄山”的历史区域时需要补映射测试。
