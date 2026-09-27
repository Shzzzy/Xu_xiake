# 徐霞客旅行规划：API 与 MCP 集成清单

> 基线：`codex/ai-butler-guidebook`，提交 `698ebcf`。  
> 本清单按“运行时实际调用、已封装但未调用、开发期工具”三类标注，避免把底座误报成业务能力。

## 1. 总览

| 系统 | 当前状态 | 业务职责 | 鉴权 |
| --- | --- | --- | --- |
| DeepSeek | 运行时实际调用 | 候选选择、排序、旅行分析、每日文案、历史背景、注意事项、结尾、预算说明 | Bearer API Key |
| 高德 | 运行时实际调用 | 路线、坐标、POI、距离、驾车时长、静态地图、导航 | Key 查询参数 |
| Tavily | 运行时实际调用 | 非自驾交通价格、景点门票资料、长线地点发现 | Bearer API Key |
| Open-Meteo MCP | 运行时实际调用 | 地名转坐标、最多 16 天天气预报 | MCP 端点当前无额外 Key |
| Supabase Postgres | 运行时通过 SQL 连接 | 共享动态地点持久化 | `DATABASE_URL` |
| Grok 通用连接器/MCP | 底座存在，业务未接入 | 未来可调用 Google Drive、Gmail、Calendar、通用 MCP | Gate Token |
| Supabase MCP | 开发期操作工具 | 查看数据库、执行迁移、检查日志 | 开发环境 MCP 配置 |
| QR Server | 运行时图片 URL | 路书导航二维码 | 无 Key |
| Google Fonts / jsDelivr | 前端/打印资源 | 字体和 Tabler Icons | 无 Key |

## 2. DeepSeek API

### 2.1 端点

```text
POST https://api.deepseek.com/chat/completions
Authorization: Bearer <DEEPSEEK_API_KEY>
Content-Type: application/json
```

默认模型：`deepseek-chat`。

可通过以下变量覆盖：

- `DEEPSEEK_BASE_URL`
- `DEEPSEEK_MODEL`
- `DEEPSEEK_API_KEY`

### 2.2 业务分工

DeepSeek 允许：

- 从高德候选中选择景点。
- 给景点排序并分析适配度。
- 生成每日主题、亮点和注意事项。
- 为具体景点生成历史背景说明。
- 生成旅行分析、预算解释和结尾文案。

DeepSeek 不允许：

- 修改高德返回的距离或路线时间。
- 覆盖本地交通方式判断。
- 修改人数、房间数和乘算结果。
- 修改预算算术和最终总价。
- 发明不属于候选集的景点。
- 写入用户输入以外的敏感身份数据。

### 2.3 调用点

| 文件 | 用途 | 输出约束 |
| --- | --- | --- |
| `planner-orchestrator.server.ts` | 选择、每日文案、结尾 | JSON、候选 ID、逐日校验 |
| `live-planner.functions.ts` | legacy 行程和长线阶段 | JSON 对象 |
| `travel-plan.server.ts` | 旅行分析、预算、总结、结尾 | JSON/Zod 校验 |
| `budget-advice.server.ts` | 预算说明文案 | 本地金额为权威，模型只整理说明 |
| `place-discovery.server.ts` | 未知地点校核 | 置信度、来源和状态 |
| `planner-context.server.ts` | 部分 Tavily 资料分析 | 不新增高德候选 |

### 2.4 稳定性

- 默认超时约 60 秒。
- 管家骨架调用有最多 3 次统一预算。
- 瞬时网络/限流/5xx 使用退避重试。
- 选择越界最多修复一次；仍失败则停止规划。
- 单日文案失败只降级当天。
- 结尾失败使用确定性中文文案。

## 3. 高德 Web 服务

### 3.1 Key 解析优先级

1. `AMAP_WEB_SERVICE_KEY`
2. `AMAP_API_KEY`
3. `AMAP_KEY`

### 3.2 REST 端点

基础地址：`https://restapi.amap.com`

| 端点 | 用途 | 返回使用方式 |
| --- | --- | --- |
| `/v3/place/text` | 热门景点、风景名胜、博物馆、公园、地标 POI | 名称、类型、地址、坐标、行政区、来源 |
| `/v3/direction/driving` | 驾车路线 | 距离、时长、路径点、步骤 |
| `/v3/direction/walking` | 步行路线 | 距离、时长、路径点 |
| `/v4/direction/bicycling` | 骑行路线 | 距离、时长、路径点 |
| `/v3/direction/transit/integrated` | 公交/地铁换乘 | 距离、时长、换乘步骤 |
| `/v3/geocode/geo` | 地址转坐标 | 省、市、区、adcode、坐标 |
| `/v3/weather/weatherInfo` | 天气 | 已封装，当前业务未调用 |
| `/v3/staticmap` | 路线地图和每日地图 | PNG 图片字节 |

导航链接生成：

```text
https://uri.amap.com/navigation
```

### 3.3 业务约束

- POI 必须先过滤为景点类，不把酒店、餐厅、交通站当作游玩景点。
- 每天只能选择当天所在地附近的候选。
- 长距离跨省且至少 800 km 时，通用交通偏好默认飞机。
- 地图必须显示路线起终点；每日地图聚焦当天景点和当天城市。
- 高德失败时，路线/POI 硬前置阶段 fail closed。
- 高德无法解析地点时，应提示用户更换旅行地点，不能用其他城市补位。

### 3.4 重试与超时

- 高德请求默认 15 秒超时。
- 命中 QPS 限流错误后等待约 700 ms 再重试一次。
- 静态地图和图片有额外缓存、并发控制和重试。

## 4. Tavily API

### 4.1 端点

```text
POST https://api.tavily.com/search
Authorization: Bearer <TAVILY_API_KEY>
```

请求参数当前包括：

- `query`
- `search_depth: advanced`
- `max_results: 8`
- `include_answer: false`
- `include_raw_content: false`

超时约 30 秒。

### 4.2 业务边界

Tavily 用于：

- 非自驾交通价格资料。
- 景点门票和优惠资料。
- 长线途经点发现。
- 给已有高德候选补充摘要和来源。

Tavily 不用于：

- 创建或替换详细管家路径的高德候选景点。
- 决定最终时间轴。
- 修改预算算术。
- 直接覆盖本地最低价。

### 4.3 价格置信度

- `verified`：明确来源和适用范围，可作为已核验参考。
- `reference`：检索到的参考区间。
- `fallback`：本地公式或最低价兜底。

## 5. Open-Meteo 天气 MCP

### 5.1 当前真实实现

`src/lib/planner.functions.ts` 当前调用：

```text
POST https://open-meteo.caseyjhand.com/mcp
Content-Type: application/json
Accept: application/json, text/event-stream
MCP-Protocol-Version: 2025-03-26
```

请求体：

```json
{
  "jsonrpc": "2.0",
  "id": 10,
  "method": "tools/call",
  "params": {
    "name": "openmeteo_search_locations",
    "arguments": {
      "name": "北京",
      "country": "CN",
      "count": 5,
      "language": "zh"
    }
  }
}
```

预报工具：

```text
openmeteo_get_forecast
latitude
longitude
timezone
forecast_days
temperature_unit: celsius
wind_speed_unit: kmh
daily_variables:
  - weather_code
  - temperature_2m_max
  - temperature_2m_min
  - precipitation_probability_max
  - wind_speed_10m_max
  - sunrise
  - sunset
```

可通过 `OPEN_METEO_MCP_URL` 覆盖端点。

### 5.2 MCP 响应协议

- 支持 JSON 和 SSE。
- `parseMcpSse` 从 `data:` 行解析 JSON-RPC 消息。
- 按请求 `id` 匹配响应帧。
- 读取 `result.structuredContent`、`content` 和 `isError`。
- 当前 `normalizeDaily` 按 MCP 的“逐日行对象”格式解析。

### 5.3 当前风险

- 这是第三方域名中转，不是 Open-Meteo 官方 REST 直连。
- 端点可用性、限流、协议变更和隐私边界不由本项目控制。
- Open-Meteo 官方 REST 的 `daily` 是列式数组，与当前行对象解析不兼容。
- 直连改造必须同步重写 `normalizeDaily`，并补充列式数组测试。

### 5.4 待改造目标

官方免费直连目标：

```text
地理编码：
GET https://geocoding-api.open-meteo.com/v1/search
  ?name=北京&count=1&language=zh&format=json

天气预报：
GET https://api.open-meteo.com/v1/forecast
  ?latitude=...
  &longitude=...
  &daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max,sunrise,sunset
  &timezone=Asia/Shanghai
  &forecast_days=N
  &temperature_unit=celsius
  &wind_speed_unit=kmh
```

官方预报 `daily` 的形态：

```json
{
  "daily": {
    "time": ["2026-09-27"],
    "weather_code": [1],
    "temperature_2m_max": [28],
    "temperature_2m_min": [18]
  }
}
```

因此需要按 `time` 下标组装每天的 `WeatherDay`。

## 6. 高德天气接口

`AmapClient.weather()` 已实现：

```text
GET https://restapi.amap.com/v3/weather/weatherInfo
```

支持：

- `extensions=base`：实况天气。
- `extensions=all`：未来预报。

但当前旅行业务没有调用这个方法，所有天气数据来自 Open-Meteo MCP。保留它是客户端能力，不是当前数据源。

## 7. Supabase 与数据库 API

### 7.1 运行时连接

当前不通过 Supabase REST API 或 SDK 查询，而是：

```text
应用服务端 -> DATABASE_URL -> Postgres 连接池/pg -> Supabase
```

环境：

- 部署：Supabase Postgres。
- 本地无 `DATABASE_URL`：PGlite 内存回退。

### 7.2 表与访问

- `_migrations`
- `discovered_places`

`discovered_places` 是无归属共享表：

- 没有 `user_id`。
- 只保存地点资料、来源、置信度和配图信息。
- 不保存行程正文、身份、IP、设备或输入历史。
- 使用直接 Postgres 连接时，Supabase RLS 不负责此连接的权限控制。

### 7.3 Supabase 保留变量

以下变量当前没有代码引用：

- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_JWKS_URL`
- `SUPABASE_DB_PASSWORD`

不要在没有新增代码和迁移的情况下宣称 Supabase Auth、RLS 或 Storage 已接入。

## 8. Grok 通用连接器与 MCP

### 8.1 底座能力

`src/lib/app-data/client.server.ts` 实现了通用连接器调用：

```text
POST <connectors-base>/call-tool
Authorization: Bearer <connector-token>
```

支持连接器类型：

- GoogleDrive
- Gmail
- GoogleCalendar
- Outlook
- OutlookCalendar
- MicrosoftTeams
- Mcp

通用 MCP 调用要求：

```text
connectorType = "Mcp"
connectorCatalogId = 具体 MCP 目录 ID
tool_name = MCP 工具名
arguments = MCP 工具参数
```

### 8.2 当前是否在旅行主链路

当前没有业务 `createServerFn` 导入 `callTool`。因此：

- Google Drive、Gmail、Calendar 不是当前旅行规划数据源。
- 通用 Grok MCP 是预留底座，不是当前已上线功能。
- 预览宿主桥只负责接收连接器访问 Token，供未来连接器使用。

## 9. Supabase MCP

Supabase MCP 是开发期的数据库操作入口，不属于应用运行时 API。用于：

- 查看 Supabase 项目 `ykyvvaoynksevmeffuji`。
- 检查表、数据、迁移和日志。
- 必要时执行受控 SQL 或迁移。

应用生产环境仍通过 `DATABASE_URL` 使用 Postgres，不依赖 Supabase MCP 在线。

## 10. 内部 HTTP 接口

### 10.1 `POST /api/guidebook-preview`

用途：逐页流式生成路书预览。

请求头：

```text
x-guidebook-run-id: <本次运行 ID>
Content-Type: application/json
```

请求体：`TripPlan`，最大 2 MB。

响应：`application/x-ndjson`。

事件类型：

- `meta`：总页数、标题、head。
- `page`：runId、连续 index、页面 id、label、checksum、HTML。
- `error`：runId 和错误信息。

客户端只接受当前 `runId`、连续页码和匹配 checksum。

### 10.2 `GET /api/guidebook-probe`

用途：验证流式响应和代理缓冲配置的诊断接口，不参与正式业务。

## 11. Server Functions

| Server Function | 方法 | 用途 |
| --- | --- | --- |
| `getOpenMeteoForecast` | GET | 当前位置/地名的天气预报 |
| `generateLiveItinerary` | POST | 1–16 天详细行程 |
| `generateLongItinerary` | POST | 17–365 天长线阶段规划 |
| `recommendBudget` | POST | AI 推荐预算与本地预算基础 |
| `exportGuidebook` | POST | 服务端 PDF/打印 HTML 兜底 |
| `getSharedInspirations` | GET | 读取共享动态地点 |
| `getConnectorReadiness` | POST | 通用连接器 Token 就绪状态 |

## 12. 外部资源与生产依赖

| 资源 | 地址 | 用途 | 业务是否必需 |
| --- | --- | --- | --- |
| DeepSeek | `https://api.deepseek.com/chat/completions` | AI 编排和文案 | 详细行程必需 |
| 高德 REST | `https://restapi.amap.com` | 路线、POI、地图 | 必需 |
| 高德导航 | `https://uri.amap.com/navigation` | 导航链接 | 必需 |
| Tavily | `https://api.tavily.com/search` | 价格和门票资料 | 可选 |
| Open-Meteo MCP | `https://open-meteo.caseyjhand.com/mcp` | 天气 | 当前必需，但失败不阻塞规划 |
| QR Server | `https://api.qrserver.com/v1/create-qr-code/` | 导航二维码 | 非硬前置 |
| Google Fonts | `fonts.googleapis.com` | 路书字体 | 非硬前置 |
| jsDelivr Tabler | `cdn.jsdelivr.net` | 路书图标 | 非硬前置 |

## 13. 数据血缘与责任矩阵

| 数据 | 权威来源 | 允许 AI 修改 | 可能降级 |
| --- | --- | --- | --- |
| 距离 | 高德 | 否 | 无 |
| 驾车时长 | 高德 | 否 | 按距离估算 |
| 门到门时长 | 本地交通模块 | 否 | 显式公式 |
| POI 名称和坐标 | 高德 | 只能选择，不能改写 | 带来源种子候选 |
| 景点顺序 | DeepSeek 从候选中选择 | 是 | 本地按当天所在地修复 |
| 每日时间轴 | 本地时间轴 | 否 | 跳过放不下的节点 |
| 交通价格 | Tavily 资料 + 本地最低价 | 否 | fallback |
| 门票价格 | Tavily 资料 + 本地参考价 | 否 | fallback |
| 住宿和餐饮 | 本地预算公式 | 否 | 参考价 |
| 预算总额 | 本地预算算术 | 否 | 不允许模型覆盖 |
| 天气 | Open-Meteo MCP | 否 | 天气功能降级，不阻塞规划 |
| 历史背景 | DeepSeek + 来源约束 | 是 | 本地安全说明 |
| PDF 排版 | 本地 HTML/CSS | 否 | 浏览器打印 |

## 14. 调用安全要求

- 所有含 Key 的请求必须在服务端发出。
- 不允许把 `Authorization`、高德 Key、数据库连接串返回浏览器。
- 外部结果先归一化、过滤、限长，再给模型。
- 模型输出必须通过 Zod 或业务规则校验后才能进入结果。
- 每次规划使用独立 `runId`，拒绝旧运行和乱序页面。
- 预览请求限制 2 MB；详细行程最多 16 天。
- 错误信息不应包含完整 Key、密码或上游原始敏感内容。
