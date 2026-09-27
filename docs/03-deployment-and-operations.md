# 徐霞客旅行规划：部署与运维手册

> 基线：`codex/ai-butler-guidebook`，提交 `698ebcf`。
> 本文只记录配置项名称和操作方式，不记录真实密钥。

## 1. 当前生产环境

| 项目 | 当前值 |
| --- | --- |
| Git 远程 | `git@github.com:Shzzzy/Xu_xiake.git` |
| 部署分支 | `codex/ai-butler-guidebook` |
| 前端与函数平台 | Netlify |
| Netlify 站点 | `chipper-blini-e3c045` |
| 生产地址 | https://chipper-blini-e3c045.netlify.app/ |
| 数据库平台 | Supabase Postgres |
| Supabase 项目 ref | `ykyvvaoynksevmeffuji` |
| Node.js | 22 |
| Nitro 预设 | `netlify` |
| 构建命令 | `npm run build` |
| 发布目录 | `dist` |

2026-09-27 对生产首页执行 HEAD 检查返回 `200`，服务端为 `Netlify`。

## 2. 本地开发

### 2.1 安装与启动

```bash
npm install
npm run dev
```

默认端口为 `8080`。此前本地浏览器联调使用过：

```bash
npm run dev -- --port 8083 --strictPort
```

### 2.2 `.env`

本地 `.env` 由 `scripts/with-app-env.mjs` 在启动前加载，只允许放在本机，不得提交。

当前项目中出现过的变量名：

```dotenv
DEEPSEEK_API_KEY=
AMAP_API_KEY=
TAVILY_API_KEY=
DATABASE_URL=
SUPABASE_URL=
SUPABASE_PUBLISHABLE_KEY=
SUPABASE_JWKS_URL=
SUPABASE_DB_PASSWORD=
```

注意：

- 代码当前直接读取的是 `DATABASE_URL`、`DEEPSEEK_API_KEY`、高德 Key、`TAVILY_API_KEY` 和 `OPEN_METEO_MCP_URL`。
- 当前代码没有引用 `SUPABASE_URL`、`SUPABASE_PUBLISHABLE_KEY`、`SUPABASE_JWKS_URL` 和 `SUPABASE_DB_PASSWORD`。
- 这些 Supabase 变量属于保留配置，不能据此判断 Supabase Auth、Storage 或 SDK 已经接入。
- 如果更改 `DATABASE_URL` 的数据库密码，必须对密码做 URL 编码；`SUPABASE_DB_PASSWORD` 保存原始密码仅用于人工构造或更新连接串。

## 3. 环境变量

### 3.1 业务必需

| 变量 | 用途 | 要求 |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | 候选景点选择、排序、每日文案、历史背景、结尾 | 详细管家规划必需 |
| `AMAP_WEB_SERVICE_KEY` | 高德 Web 服务首选 Key | 与 `AMAP_API_KEY` / `AMAP_KEY` 至少一个存在 |
| `AMAP_API_KEY` | 兼容高德 Key | 当前 `.env` 使用此名称 |
| `AMAP_KEY` | 兼容高德 Key | 可选别名 |
| `DATABASE_URL` | Supabase Postgres 连接串 | 共享地点持久化；缺失时使用 PGlite |
| `TAVILY_API_KEY` | 非自驾交通价格和门票资料 | 可选；缺失时用参考价/兜底价 |

### 3.2 接口覆盖项

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | DeepSeek API 地址覆盖 |
| `DEEPSEEK_MODEL` | `deepseek-chat` | 模型覆盖 |
| `TAVILY_SEARCH_URL` | `https://api.tavily.com/search` | Tavily 地址覆盖 |
| `OPEN_METEO_MCP_URL` | `https://open-meteo.caseyjhand.com/mcp` | 当前天气 MCP 地址覆盖 |
| `BUTLER_PLANNER` | 默认启用 | 设为 `0` 才回退 legacy 路径 |
| `DEBUG_SELECTION_FIX` | 空 | 设为 `1` 输出景点修复调试日志 |
| `GUIDEBOOK_EXPORT_TIMING` | 空 | 路书导出阶段耗时日志 |
| `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` | 空 | 仅服务端 Playwright PDF 路径；Netlify 不使用 |

### 3.3 商业化账号与支付

生产环境必须开启真实账号和支付能力：

| 变量 | 用途 | 要求 |
| --- | --- | --- |
| `VITE_AUTH_ENABLED` | 开启真实手机号账号登录 | 生产必须为 `true` |
| `BETTER_AUTH_SECRET` | Better Auth 会话签名 | 生产必需，使用高强度随机值 |
| `PAYMENT_PROVIDER` | 支付服务商 | 生产使用 `wechat` |
| `WECHAT_PAY_MCH_ID` | 微信支付商户号 | 微信支付必需 |
| `WECHAT_PAY_APP_ID` | 微信支付 AppID | 微信支付必需 |
| `WECHAT_PAY_SERIAL_NO` | 商户 API 证书序列号 | 微信支付必需 |
| `WECHAT_PAY_PRIVATE_KEY` | 商户 RSA 私钥 | 微信支付必需，只存服务端 |
| `WECHAT_PAY_API_V3_KEY` | 微信支付 API v3 密钥 | 必须为 32 字节 |
| `WECHAT_PAY_PLATFORM_CERT` | 微信支付平台证书或公钥 | 微信支付必需 |
| `WECHAT_PAY_PLATFORM_SERIAL_NO` | 平台证书序列号覆盖项 | 可选 |
| `WECHAT_PAY_NOTIFY_URL` | 支付回调地址 | 必须是公网 HTTPS，例如 `https://chipper-blini-e3c045.netlify.app/api/payments/webhook` |

`PAYMENT_PROVIDER=test` 只允许 `NODE_ENV=test` 或 `development`；生产环境会 fail closed。

首次管理员创建：

```sql
-- 先通过普通注册页注册手机号账号，再在 Supabase SQL Editor 执行：
update "user"
set role = 'admin'
where phone = '这里替换为管理员手机号';
```

### 3.4 Auth/Grok 底座变量

这些变量来自工程模板，不属于旅行主流程，但如果启用登录或通用连接器会使用：

- `BETTER_AUTH_SECRET`
- `BETTER_AUTH_URL`
- `GROK_AUTH_CLIENT_ID`
- `GROK_AUTH_CLIENT_SECRET`
- `GROK_AUTH_ISSUER`
- `GROK_CONNECTORS_URL`
- `GROK_CONNECTOR_ACCESS_TOKEN`
- `GROK_GATE_ORIGIN`
- `GROK_PROJECT_ID`
- `VITE_AUTH_ENABLED`
- `VITE_PUBLIC_HOSTNAME`
- `VITE_STUN_URLS`

当前 `.grok/app-env.json` 中 `VITE_AUTH_ENABLED` 为 `false`。

## 4. 生产构建

```bash
npm run typecheck
npm test
npm run build
```

`npm run build` 执行：

1. `vite build`。
2. 读取 `NITRO_PRESET=netlify` 并产出 Netlify 函数。
3. 执行 `npm run db:migrate`。
4. `db:migrate` 使用 `DATABASE_URL` 连接 Supabase。
5. 按文件名顺序应用 `migrations/*.sql`，并写入 `_migrations`。

重要：

- `npm run build` 会触碰生产数据库迁移，不得把它当成本地预览构建。
- 只做本地界面或类型构建时使用 `npm run build:dev`。
- 迁移器只读取 `migrations` 根目录，不递归 `migrations/auth/`。
- 当前生产迁移包括 `0002_discovered_places.sql` 和 `0003_clear_discovered_route_context.sql`。
- 数据库迁移是前向执行，没有自动 down migration。

## 5. Netlify 部署

### 5.1 自动部署流程

```text
提交到 codex/ai-butler-guidebook
  -> push 到 GitHub
  -> Netlify 检测分支更新
  -> npm run build
  -> Nitro 生成 Netlify Functions
  -> 静态资源发布到 dist
  -> db:migrate 更新 Supabase
  -> 生产地址切换到新部署
```

### 5.2 Netlify 环境配置

在 Netlify 站点环境变量页面配置：

- `DEEPSEEK_API_KEY`
- `AMAP_API_KEY`，或优先使用 `AMAP_WEB_SERVICE_KEY`
- `TAVILY_API_KEY`
- `DATABASE_URL`
- 可选的 `OPEN_METEO_MCP_URL`
- 可选的 `DEEPSEEK_BASE_URL`、`DEEPSEEK_MODEL`、`TAVILY_SEARCH_URL`
- 可选的 `BUTLER_PLANNER`

`NITRO_PRESET` 和 `NODE_VERSION` 已在 `netlify.toml` 中设置，通常不需要重复配置。

### 5.3 发布后检查

1. 访问生产地址，确认首页不是空白页。
2. 打开浏览器控制台，确认没有未捕获异常。
3. 运行一次“已知目的地”流程，确认天气、规划结果和路书预览。
4. 检查 Netlify Functions 日志，重点看 DeepSeek、高德、Tavily 和数据库错误。
5. 测试 PDF 按钮，确认浏览器打印窗口可以打开。
6. 如提交了迁移，确认 `_migrations` 已记录新文件名。

## 6. Supabase 操作

### 6.1 当前数据职责

Supabase 当前只承担托管 Postgres：

- 通过 `DATABASE_URL` 直接连接。
- 使用 `pg`/Kysely/PGlite SQL 接口。
- 项目代码没有使用 Supabase JS SDK、Supabase Auth、Storage 或 RLS 策略。
- `discovered_places` 是无归属共享表，不包含 `user_id`，不适合保存个人行程或敏感信息。

### 6.2 主要表

| 表 | 用途 |
| --- | --- |
| `_migrations` | 已应用迁移文件名 |
| `discovered_places` | 已验证或候选的共享动态地点 |
| `credit_wallets` | 用户点数余额、预占和首次免费状态 |
| `credit_ledger` | 点数流水 |
| `credit_reservations` | 生成前的点数预占 |
| `payment_orders` | 微信支付订单 |
| `payment_events` | 支付回调幂等事件 |
| `travel_plans` | 用户保存的行程和路书 JSON |
| `plan_shares` | 只读分享令牌 |
| `admin_audit_logs` | 管理员操作审计 |
| `generation_entitlements` | 访客、免费和付费生成的一次性凭证 |

商业化上线后数据库会保存手机号账号、点数、订单、行程和分享记录。密码由 Better Auth 哈希保存，不保存明文密码；支付密码和银行卡信息由支付服务商处理。

### 6.3 迁移操作

标准方式：

```text
修改或新增 migrations/xxxx_*.sql
  -> 本地检查 SQL
  -> 提交并推送
  -> Netlify 构建时自动执行
```

也可以在具备 `DATABASE_URL` 的环境中单独执行：

```bash
npm run db:migrate
```

修改生产数据库前应先备份或确认变更可回滚。由于当前没有 down migration，回滚通常需要：

- 恢复 Supabase 备份。
- 或编写单独的补偿 SQL。
- 或回滚应用代码并保留新表向后兼容。

## 7. PDF 导出

当前生产使用浏览器原生打印：

1. 用户点击“生成路书 PDF”。
2. 前端打开路书打印窗口。
3. 用户在目标打印机中选择“另存为 PDF”。

原因：

- Netlify Functions 不自带 Playwright Chromium。
- 安装完整 Chromium 会显著增加冷启动和部署体积。
- 浏览器打印与预览使用同一份 HTML/CSS，排版更直接。

不要在 Netlify 上把 `renderGuidebookPdf` 作为默认导出来修复 PDF 错误；除非改为独立容器或对象存储渲染服务。

## 8. 常用运维排查

| 现象 | 优先检查 |
| --- | --- |
| “AI 规划服务暂时不可用” | `DEEPSEEK_API_KEY`、余额、模型名、Netlify 出口网络、DeepSeek 状态 |
| 高德搜索不到地点 | 高德 Key、配额、地点名称是否正确；应提示用户更换地点，不能用其他城市景点补位 |
| 地图空白 | 高德静态地图配额、Key 权限、静态图 URL、Netlify 函数日志、图片代理是否成功 |
| 地图看不到起终点 | 每日地图是否错误使用全程锚点；检查路线/每日地图焦点半径和内边距 |
| 预算与表单不一致 | 检查是否使用旧缓存；确认规划结果和 PDF 都来自同一个 `TripPlan` |
| 规划一直加载 | DeepSeek/高德超时；查看 Netlify Functions 日志和浏览器网络请求 |
| 数据库连接失败 | `DATABASE_URL` 是否为空、密码是否 URL 编码、Supabase 是否暂停、连接池是否可用 |
| 迁移未执行 | 构建是否设置 `DATABASE_URL`，文件名是否位于 `migrations` 根目录，`_migrations` 是否已有同名记录 |
| 路书空白页 | 页面分页高度、地图/图片加载和流式页面事件；检查 checksum 与页面总数 |
| 预览自动跳页或双滚动条 | 检查 `GuidebookPreview` 高度和 `GuidebookStage` 挂载条件 |

## 9. 回滚与降级

### 应用回滚

- 在 Netlify 部署列表中选择上一个成功部署并重新发布。
- 不要在未检查数据库兼容性的情况下强制重写 Git 历史。

### 规划路径降级

- 设置 `BUTLER_PLANNER=0` 可显式回退 legacy 规划链路。
- 该开关只适用于故障对照；legacy 与管家路径的输出契约和预算口径并不完全相同。

### 外部服务降级

- Tavily 缺失：使用本地价格兜底。
- 天气 MCP 失败：不阻塞规划，但天气相关文案和注意事项能力下降。
- DeepSeek 失败：详细管家路线不可用，不能伪造正式路书。
- 高德硬前置失败：停止规划并显示配置或地点错误。

## 10. 安全与密钥轮换

建议立即执行的运维措施：

1. 因为生产密钥曾出现在聊天记录中，轮换 DeepSeek、高德、Tavily 和 Supabase 数据库密码。
2. 更新 Netlify 环境变量后重新部署并验证。
3. 不在文档、提交、截图或对话中粘贴真实值。
4. 为高德 Key 区分本地和生产配额，避免调试消耗生产 QPS。
5. Supabase 优先使用连接池地址；如果使用直连地址，注意 serverless 并发下的连接数。
6. 定期检查 `_migrations`、`discovered_places` 体积和 Supabase 日志。

## 11. 发布前检查清单

- [ ] `git status` 干净或只包含本次预期变更。
- [ ] 已运行 `npm run typecheck`。
- [ ] 已按改动范围运行相关测试。
- [ ] 已确认 `netlify.toml` 和分支设置没有变化。
- [ ] 已确认 Netlify 环境变量完整。
- [ ] 已确认迁移只影响预期表。
- [ ] 已测试首页、规划、路书预览和 PDF 打印。
- [ ] 已检查 Netlify Functions 日志。
- [ ] 已确认生产站点返回 200。
- [ ] `VITE_AUTH_ENABLED=true`，手机号注册、登录和退出可用。
- [ ] `BETTER_AUTH_SECRET` 已设置且没有写入代码或文档。
- [ ] `DATABASE_URL` 指向 Supabase，且 `_migrations` 已包含 `0001`–`0013`。
- [ ] `PAYMENT_PROVIDER=wechat`，微信支付商户配置完整。
- [ ] `WECHAT_PAY_NOTIFY_URL` 可从公网访问，回调验签和金额校验通过。
- [ ] 首次管理员账号已通过 Supabase 将 `role` 升级为 `admin`，普通注册不能创建管理员。
- [ ] 已验证首次免费、点数购买、扣点、失败释放和重复回调不重复加点。
- [ ] 已验证分享链接无需登录可只读查看，且不包含手机号、订单和钱包信息。
- [ ] 已验证 `/pricing`、`/account`、`/admin` 和 `/share/:token` 的线上页面。
