# 徐霞客旅行规划：代码架构

> 基线：`codex/ai-butler-guidebook`，提交 `698ebcf`。本文按当前实现整理，不把设计计划中的未接线能力写成已完成。

## 1. 技术栈

| 层 | 技术 |
| --- | --- |
| 前端 | React 19、TypeScript、Tailwind CSS 4、Radix UI、Lucide、Recharts |
| 应用框架 | TanStack Start、TanStack Router、TanStack React Query |
| 构建 | Vite 8、Nitro 3 |
| 生产部署 | Netlify Functions + 静态资源 |
| 数据库 | Supabase Postgres；本地无 `DATABASE_URL` 时回退 PGlite |
| 数据库驱动 | `pg`、Kysely、PGlite；Supabase 当前只作为托管 Postgres |
| 校验 | Zod |
| AI/API | DeepSeek Chat Completions、高德 Web 服务、Tavily、Open-Meteo MCP |
| 测试 | Node Test、tsx、Playwright、组件测试 |
| 认证底座 | Better Auth、Grok gate；当前旅行主流程不依赖登录 |

## 2. 运行时边界

```text
浏览器 React UI
  -> TanStack Start server function / route handler
    -> 本地确定性规划模块
      -> 高德 REST
      -> Tavily REST
      -> DeepSeek REST
      -> Open-Meteo MCP
      -> Postgres / PGlite
    -> TripPlan
  -> 路书逐页 HTML
  -> 浏览器打印为 PDF
```

关键原则：

- API Key 只在服务端读取。
- 浏览器只接收行程结果、页面内容和非敏感配置。
- 高德负责事实数据；本地模块负责算术和时间；DeepSeek 负责选择、排序和文案。
- 页面预览与 PDF 共用同一份 `TripPlan` 和文案校验结果。
- Netlify serverless 环境不启动 Playwright，PDF 由浏览器打印。

## 3. 目录结构

| 路径 | 职责 |
| --- | --- |
| `src/routes/index.tsx` | 唯一主页面，挂载 `PlannerPrototype` |
| `src/routes/__root.tsx` | 文档壳、字体、Toaster、预览桥、AuthProvider |
| `src/routes/api/guidebook-preview.ts` | 路书 NDJSON 逐页预览接口 |
| `src/routes/api/guidebook-probe.ts` | 流式响应诊断接口 |
| `src/components/planner/PlannerPrototype.tsx` | 入口、已知/未知表单、结果页和主要状态编排 |
| `src/components/planner/plan-output/` | 路书预览、导出、预算、雷达、可行性方案等组件 |
| `src/lib/live-planner.functions.ts` | 详细行程和长线规划 server function、外部数据装配 |
| `src/lib/planner-orchestrator.server.ts` | DeepSeek 调用、候选选择校验、骨架、逐日文案和预算编排 |
| `src/lib/planner-context.server.ts` | 高德路线、POI 候选、交通价格上下文、地点过滤与合并 |
| `src/lib/amap.server.ts` | 高德 REST 客户端和 URL 构造 |
| `src/lib/tavily.server.ts` | Tavily 搜索客户端和结果归一化 |
| `src/lib/planner.functions.ts` | Open-Meteo 天气 server function 和 MCP JSON-RPC 调用 |
| `src/lib/transport-planner.server.ts` | 交通方式、门到门时间、最低价和自驾分段 |
| `src/lib/trip-feasibility.ts` | 长期自驾可行性判断和 A/B/C 方案生成 |
| `src/lib/day-timeline.ts` | 每日时间轴和休息上限 |
| `src/lib/budget-planner.ts` | 交通、住宿、餐饮、门票、其他费用算术 |
| `src/lib/planning-run.ts` | `route -> pois -> selection -> timeline -> prices -> budget -> narrative -> pages` 状态机 |
| `src/lib/plan-output-adapter.ts` | 管家骨架、预算、每日文案组装为统一 `TripPlan` |
| `src/lib/trip-plan-schema.ts` | 预览和导出共用的行程 schema |
| `src/lib/guidebook-stream.server.ts` | 逐页事件、runId、页码和 checksum 协议 |
| `src/lib/guidebook-map.server.ts` | 静态地图、POI 补全、每日地图聚焦与重试 |
| `src/lib/guidebook-html.server.ts` | 路书 HTML/CSS 渲染 |
| `src/lib/guidebook-narrative.server.ts` | 每日文案校验、历史背景和注意事项 |
| `src/lib/guidebook-pdf.server.ts` | 服务端 PDF 能力与安全兜底；当前生产导出主要走浏览器打印 |
| `src/lib/db.ts` | Postgres/PGlite 统一 SQL 接口和迁移启动 |
| `src/lib/discovered-places.*` | 共享动态地点仓储 |
| `src/lib/app-data/` | Grok 通用连接器/MCP 底座，当前不是旅行业务主链路 |
| `migrations/` | 生产数据库迁移 |
| `netlify.toml` | Netlify 构建、Nitro 预设和 Node 版本 |
| `scripts/migrate.mjs` | 部署时迁移执行器 |
| `docs/superpowers/` | 历史设计与实施计划；以本目录的当前实现文档为准 |

## 4. 前端状态与页面状态机

主页面 `Screen` 状态：

```text
landing -> known -> result
landing -> unknown -> result
result -> known/unknown
```

结果页内部规划状态：

```text
idle -> loading -> ready
                -> fallback
                -> needs_decision
```

- `needs_decision`：显示长途自驾 A/B/C 可行性方案卡。
- `ready`：挂载 `GuidebookStage` 和 `GuidebookPreview`。
- `fallback`：只显示错误或配置说明；确定性硬前置失败时不挂载正式路书。
- 保存行程只保存浏览器本地标识，不上传行程正文。

## 5. 详细行程规划时序

### 5.1 准备阶段

```text
前端提交 TripBrief
  -> getOpenMeteoForecast(坐标或地名, 天数)
  -> generateLiveItinerary(TripBrief + route + weather + seedPlaces)
```

服务端 `runLivePlannerWith`：

1. 检查 `DEEPSEEK_API_KEY`。
2. 解析高德 Key。
3. 查询目的地候选 POI。
4. 查询途经点候选 POI。
5. 调用高德准备每段路线和交通计划。
6. 用 Tavily 补充非自驾价格资料。
7. 判断长途自驾是否不可行。
8. 合并高德候选与种子候选。
9. 进入默认管家管线；`BUTLER_PLANNER=0` 时才走 legacy。

### 5.2 确定性状态机

```text
route
  -> pois
  -> selection
  -> timeline
  -> prices
  -> budget
  -> narrative
  -> pages
```

| 阶段 | 输入 | 输出 | 失败策略 |
| --- | --- | --- | --- |
| `route` | 用户路线、交通计划 | 每日交通映射 | 硬失败 |
| `pois` | 高德候选 | 去重且带来源的候选 | 硬失败 |
| `selection` | 候选 ID、每日所在地、偏好 | DeepSeek 选择结果 | 一次修复；仍越界则失败 |
| `timeline` | 选择结果、时间窗、交通 | 每日骨架节点 | 硬失败 |
| `prices` | 交通和门票参考价 | 价格引用 | 可降级为本地兜底价 |
| `budget` | 人数、天数、交通、票价 | 五类预算 | 低于交通底线则失败 |
| `narrative` | 每日骨架、天气 | 目的、亮点、注意、历史 | 单日失败只降级当天 |
| `pages` | 结尾内容 | 可组装页面 | 失败使用确定性结尾 |

### 5.3 关键校验

- 候选必须来自高德或带来源的种子数据。
- DeepSeek 的选择必须命中候选 ID。
- 景点必须位于当天城市或允许的邻近距离。
- 同一景点默认不跨天重复。
- 交通时间不能超过每日时间窗。
- 交通预算不能低于本地最低总价。
- 每日文案不能提及未安排的景点。
- 所有页面必须通过 `runId`、连续页码和 checksum 校验。

## 6. 数据模型

### 6.1 用户输入

`TripBrief` 的核心字段：

- 路线：出发地、目的地、途经点、往返、返程模式、单段偏好。
- 时间：出发日期、天数、每日出发/结束时间、每日小时数。
- 人群：成人数、儿童数。
- 偏好：节奏、兴趣、旅行风格。
- 预算：全团总预算、自驾能源。

### 6.2 规划结果

`TripPlan` 的核心字段：

- `meta`：标题、路线、日期、人数、兴趣、候选景点和文案来源。
- `budget`：预算上限、预计总费用、五类分项、房间数。
- `route`：静态地图、去程/返程坐标、分段、总距离和总时长。
- `days`：日期、主题、天气、地图、时间轴、费用、雷达、亮点、注意事项、历史背景。
- `violations`：最终仍未满足的约束。
- `closing`：引用、来源和结尾文案。

### 6.3 数据库表

当前生产迁移只包含：

- `_migrations`：迁移记录。
- `discovered_places`：共享动态地点，包含规范化名称、地区、来源快照、置信度、状态和配图种子。

`migrations/auth/0001_auth.sql` 存在，但位于子目录，当前迁移器不会自动应用。

## 7. 预算架构

`calculateBudget` 是预算算术的权威实现：

- 交通优先使用价格引用；缺失时使用本地最低价。
- 交通可按人或按车计价。
- 住宿使用 `房间数 × 晚数 × 每晚价格`。
- 餐饮使用 `人数 × 天数 × 每人每日餐标`。
- 门票支持成人、儿童、统一票。
- 其他费用为 `max(200, 前四项 × 10%)`。
- 每一项输出 `amount`、`quantity`、`total`、`source` 和 `confidence`。

高风险点：确定性管线把房间数设为同行人数，而旧 `calculateRooms` 仍是两人一间。后续应统一为一个明确业务规则。

## 8. 路书与地图架构

- `guidebook-stream.server.ts` 生成页面事件。
- 前端 `GuidebookPreview` 接收 NDJSON 并写入同源 iframe。
- `guidebook-map.server.ts` 对路线地图和每日地图分别生成高德静态地图。
- 每日地图优先聚焦当天景点，避免整条跨省路线把城市细节压缩到不可读。
- 地图图片请求有并发限制、超时、缓存和安全 URL 清洗。
- `guidebook-html.server.ts` 同时服务预览 HTML 和打印样式。
- `use-guidebook-export.ts` 在 Netlify 上直接调用浏览器打印窗口。

## 9. 安全与边界

- 所有外部 API Key 只在服务端读取。
- 高德和 Tavily 结果必须归一化后才能进入模型上下文。
- DeepSeek 输出必须经过 Zod/业务校验，不能直接进入时间轴和预算。
- 路书预览请求体上限 2 MB。
- 静态地图和图片 URL 会移除敏感查询参数。
- 路书页面 HTML 在进入 iframe 前校验 checksum。
- 高德和 DeepSeek 调用设置超时；DeepSeek 对瞬时故障有限次重试。
- 用户输入的途经点和地点会进入 Tavily/DeepSeek 上下文，需避免记录到共享数据库。

## 10. 测试结构

- 纯函数：路线、交通、时间轴、预算、雷达、可行性、校验器。
- 服务编排：`planner-orchestrator.server.test.ts`、`live-planner.test.ts`。
- 外部 API 契约：高德、Tavily、DeepSeek、天气 MCP 均通过注入 `fetch` 测试。
- 数据库：`discovered-places.integration.test.ts`。
- Golden E2E：`trip-pipeline.golden.test.ts`。
- 路书：HTML、地图、文案、流式协议、导出和空白页测试。
- 组件：计划输出、可行性卡和 PDF 相关组件测试。

## 11. 当前架构风险

1. 天气使用第三方 MCP，额外依赖和故障点高于 Open-Meteo 官方 REST。
2. Open-Meteo 官方列式数组与当前 MCP 行式解析不兼容；直连时必须重写 `normalizeDaily`。
3. 高德天气封装未使用，接口清单和真实数据血缘容易混淆。
4. 房间数规则在确定性预算和旧适配器之间不一致。
5. AI 推荐预算与最终详细规划使用不同的默认住宿、餐饮和门票价格，存在前后金额不一致风险。
6. 共享 `discovered_places` 与详细规划主链路的关系已经分叉，需明确是否保留双路径。
7. 生产密钥轮换、Netlify/Supabase 环境一致性和迁移回滚仍需补齐运维制度。
8. 预览和导出共用 `TripPlan`，但服务端 PDF 与浏览器打印仍保留两套导出路径，文档和测试需持续同步。
