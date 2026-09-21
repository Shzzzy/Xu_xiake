# 目的地候选与长途交通修复报告

日期：2026-09-21
分支：`codex/ai-butler-guidebook`
基线：`d6ff7ef`

## 根因

1. 详细规划入口把 Tavily 目的地搜索结果和本地 seed 直接作为候选。北京不在本地 seed 中，Tavily 返回空时 `sources` 为空，管家骨架只能生成「上午活动 / 自由休整 / 夜游」。
2. 通用交通偏好 `economy | balanced | speed` 没有按距离和省份归一化。厦门到北京约 2000 公里仍按均衡交通保留，地图链路把均衡交通映射为驾车，预算也按短途口径计算。
3. 骨架提示词没有携带交通价格资料和本地最低价，模型可以生成明显低于合理下限的交通费用。

## 改动

### 1. 高德 POI 成为目的地景点主来源

- 新增 `src/lib/planner-context.server.ts`。
- 服务端读取 `AMAP_WEB_SERVICE_KEY / AMAP_API_KEY / AMAP_KEY`，使用现有 `createAmapClient` 与 `searchPoi`。
- 按「热门景点、风景名胜、博物馆、公园、地标」搜索目的地城市 POI，转换为 `{ name, summary, source }`。
- 来源使用公开的高德地点链接（`https://www.amap.com/place/...`），不携带任何 key。
- AMap 候选优先；本地 seed 作为兜底保留；Tavily 摘要只能补充已有候选，不能新增候选，也不能用空结果清空候选。
- 详细规划入口不再调用 Tavily 做目的地景点发现。途经点发现也从 live planner 路径移除，Tavily 在详细规划中只用于交通价格资料。

### 2. 长途通用交通自动切飞机

- 使用 AMap geocode 获取 route leg 两端经纬度和省份。
- 通用偏好 `economy | balanced | speed`、跨省且单程约 `>= 800km` 时，规划输入中的该 leg 切换为 `flight`。
- 用户显式选择 `drive` 或 `train`（以及其他显式交通方式）时保持原选择，不强制改写。
- 服务端返回归一化后的 `route`，结果页使用返回值构建地图与执行计划，不再回退到前端原始 `balanced` 路线。

### 3. Tavily 价格资料与本地最低价

- 对每个非自驾 leg 构造包含出发地、目的地、交通方式、日期、距离和单程字样的 Tavily 查询。
- Tavily 摘要随交通参考一同进入骨架提示词。
- 本地最低参考价：
  - 飞机：`max(500, 0.55 * km) / 人 / 单程`
  - 高铁 / 火车：`max(150, 0.35 * km) / 人 / 单程`
  - 其余非自驾方式也有对应距离最低价。
- 按人数计算 `minimumPartyTotal`，并按 route leg 汇总去返程最低总价。
- `buildSkeletonInstruction` 明确要求交通节点费用覆盖每个 leg、去返程全部计入、总交通费用不得低于本地最低总价。
- `enforceTransportPriceFloors` 在骨架解析后做确定性兜底：低于最低价的交通节点会被抬高到对应 leg 的 `minimumPartyTotal`，并修正交通方式。

## 测试输出

新增或补充的确定性测试：

- `src/lib/planner-context.server.test.ts`
  - 高德 POI 转候选且来源不含 key
  - 高德无结果时保留已有候选，Tavily 摘要只补充不新增
  - 跨省 `>=800km` 通用偏好切飞机
  - 显式 `drive` / `train` 不改
  - Tavily 摘要与本地最低总价进入参考
  - AMap key 环境变量优先级
- `src/lib/planner-skeleton.test.ts`
  - 交通价格资料和最低总价进入骨架提示词
  - 低费用交通节点确定性抬高并修正交通方式
- `src/lib/live-planner.test.ts`
  - 高德候选进入管家 `sources`
  - 长距离路线返回 `flight`，Tavily 查询只包含票价用途

实际执行结果：

- 聚焦测试：25/25 通过
- `npm run typecheck`：通过
- `npm test`：通过
  - 2 个 Playwright 向导/路书测试通过
  - 320 个 Node 测试通过
  - 6 个组件测试通过
- `npm run build:dev`：通过
- 未运行 `npm run build`

## 遗留问题

1. 目的地候选依赖部署环境提供 AMap key；key 缺失时会退回本地 seed，无法保证陌生城市仍有候选。
2. Tavily 价格资料只作为模型综合依据，真实票价仍需用户在出发前核验。
3. 工作区中原有的未跟踪文件 `output/`、`scripts/_demo.cjs`、`src/components/planner/PlaceAdvice.tsx`、`src/lib/place-advice.functions.ts` 未纳入本次提交。
4. 工作区中原有的 `src/components/planner/plan-output/GuidebookPreview.tsx` 改动未纳入本次提交。
5. 工具测试期间误创建的未跟踪临时文件 `tmp_apply_patch_test.txt` 为避免未授权删除而保留，等待用户允许清理。
