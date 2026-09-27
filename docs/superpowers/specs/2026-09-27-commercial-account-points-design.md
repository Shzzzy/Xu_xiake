# 商业化账号、点数与支付系统设计

> 状态：待用户最终审核  
> 日期：2026-09-27  
> 基线分支：`codex/ai-butler-guidebook`  
> 关联原型：  
> - `public/prototypes/commercial-payment-directions.html`  
> - `public/prototypes/auth-roadbook-prototype.html`

## 1. 目标

为徐霞客旅行规划增加一套可直接进入开发的商业化基础能力：

- 用户账号、登录与注册。
- 用户钱包、点数余额和完整点数流水。
- 一次性付费购买点数，不采用订阅。
- 首次免费完整体验。
- 入口采用已选定的 B「路引册页」方向。
- 管理员账号和管理后台基础能力。
- 支付成功、生成消耗、退款、失败回滚均有服务端记录。
- 所有商业化能力不破坏当前旅行规划、路书预览和分享主流程。

## 2. 非目标

首版不包含：

- 订阅制、自动续费、会员周期。
- 手机号短信验证。
- 微信登录、邮箱登录和跨账号合并。
- 用户之间的点数转账。
- 优惠券、邀请返利、积分商城。
- 多支付服务商同时上线。
- 完整企业发票系统。
- 大型管理后台、复杂报表和客服工单系统。

## 3. 已确认产品决策

### 3.1 目标用户

- 核心付费用户：2–6 人自由行的主要组织者。
- 兼容用户：1 人自由行。
- 核心价值：省时、预算与时间可信、可分享。
- 小红书和朋友圈文案属于附加权益，不替代行程规划的核心价值。

### 3.2 收费模式

采用点数制，不采用订阅制。

点数规则：

- 首次完整体验：1 次，免费。
- 单次购买：¥0.99，获得 1 点。
- 10 次购买：¥9.41，获得 10 点，相当于 9.5 折。
- 30 次购买：¥26.73，获得 30 点，相当于 9 折。
- 点数为整数。
- 每次成功生成一份新的旅行方案消耗 1 点。
- 失败、超时、服务异常不扣点。
- PDF 下载、链接分享和社交文案不再单独扣点，随已生成的行程一并解锁。
- 分享链接的接收者无需登录、无需购买，可只读查看。

### 3.3 免费体验

- 首次生成不要求登录。
- 用户可以完整查看和检查第一份行程。
- 用户点击保存、下载 PDF 或分享链接时，要求登录或注册。
- 登录后，将当前行程关联到账号，并消费该账号的首次免费体验。
- 首次免费体验每个账号只有 1 次。
- 再次生成新方案前，必须登录并确认消耗 1 点。
- 未登录访客的生成行为必须做 IP 和浏览器频率限制，避免绕过账号反复免费生成。

### 3.4 页面入口

采用 B「路引册页」方向。

入口包括：

1. 顶部低调入口：`行旅点册 / 价格说明`。
2. 结果页和路书结尾主入口：保存、下载 PDF、分享或再次规划时进入。
3. 账号页入口：查看余额和购买点数。
4. 点数不足时入口：生成新方案前进入。
5. 分享链接接收者不显示购买强提示。

不使用首页大面积强推购买。

## 4. 用户角色

| 角色 | 能力 |
| --- | --- |
| 访客 | 填写条件、生成第一份预览、登录/注册 |
| 普通用户 | 管理账号、查看钱包、购买点数、生成和分享路书 |
| 管理员 | 普通用户能力 + 用户、订单、点数、审计和统计管理 |

角色字段统一为：

- `user`
- `admin`

管理员不允许通过公开注册页选择。管理员先按普通用户注册，再由受控数据库操作将 `role` 改为 `admin`。

## 5. 核心用户流程

### 5.1 首次免费流程

```text
访客进入首页
  -> 填写旅行条件
  -> 生成第一份行程，不登录
  -> 查看完整预览
  -> 点击保存 / PDF / 分享
  -> 跳转登录或注册
  -> 登录成功
  -> claim 当前行程
  -> 标记账号首次免费体验已使用
  -> 行程归属账号
  -> 解锁 PDF 和分享
```

### 5.2 后续生成流程

```text
已登录用户点击生成新方案
  -> 检查免费次数和可用点数
  -> 若免费次数未用：消费免费体验
  -> 若免费次数已用：
       - 余额 >= 1：确认消耗 1 点
       - 余额 = 0：打开 B 点册
  -> 预留 1 点
  -> 执行规划
  -> 成功：确认消耗并保存行程
  -> 失败：释放预留，不扣点
```

### 5.3 购买流程

```text
选择套餐
  -> 登录检查
  -> 创建支付订单
  -> 选择支付方式
  -> 跳转或唤起支付服务商
  -> 服务商回调
  -> 校验签名与订单金额
  -> 幂等加点
  -> 写入点数流水
  -> 返回行旅点册
```

### 5.4 管理员流程

```text
管理员普通注册
  -> Supabase 将 role 改为 admin
  -> 重新登录
  -> 显示管理后台入口
  -> 查看用户、钱包、订单、流水
  -> 手动调整点数时填写原因
  -> 写入管理员审计日志
```

## 6. 账号与认证设计

### 6.1 注册和登录

- 登录标识：中国大陆手机号。
- 密码：至少 8 位。
- 注册字段：手机号、密码、确认密码。
- 不发送短信验证码。
- 手机号标准化为 11 位数字。
- 手机号全局唯一。
- 注册成功即创建账号和钱包。
- 不要求昵称、邮箱和头像。
- 页面明确提示：当前手机号不验证，忘记密码暂不支持自助找回。

### 6.2 技术约束

- 复用现有 Better Auth 的密码哈希与 Session 能力。
- 使用 Better Auth username 插件或等价 credentials 方案，将标准化手机号作为用户名。
- Better Auth 用户表仍要求唯一邮箱时，可使用不可投递的内部占位邮箱，例如 `<phone>@phone.invalid`，该邮箱只在服务端存在，不展示给用户。
- 禁止自研明文密码或弱哈希。
- Session Cookie 使用 `HttpOnly`、`Secure`、`SameSite=Lax`。
- 登录和注册按手机号、IP、设备限流。
- 连续失败登录需要短期锁定。

### 6.3 密码找回

首版：

- 登录后可以修改密码。
- 忘记密码不提供自助找回。
- 管理员也不能查看用户密码。
- 后续可增加邮箱或短信验证找回；当前账号结构必须允许未来补充验证字段。

## 7. 数据模型

所有结构变更必须通过 `migrations/*.sql`，禁止在业务代码中临时建表。

### 7.1 用户扩展

在现有 Better Auth `user` 表增加：

- `phone text unique`：标准化手机号。
- `phoneVerified boolean not null default false`。
- `role text not null default 'user'`，仅允许 `user`、`admin`。
- `status text not null default 'active'`，仅允许 `active`、`disabled`。

### 7.2 `credit_wallets`

- `id text primary key`
- `user_id text unique not null`
- `balance integer not null default 0`
- `reserved integer not null default 0`
- `free_trial_claimed boolean not null default false`
- `version integer not null default 0`
- `created_at timestamptz`
- `updated_at timestamptz`

约束：

- `balance >= 0`
- `reserved >= 0`
- `reserved <= balance`
- 可用点数 = `balance - reserved`

### 7.3 `credit_ledger`

- `id text primary key`
- `wallet_id text not null`
- `delta integer not null`
- `balance_after integer not null`
- `reason text not null`
- `order_id text`
- `plan_id text`
- `operator_user_id text`
- `note text`
- `created_at timestamptz`

允许的原因：

- `free_trial`
- `purchase`
- `generation`
- `refund`
- `admin_adjustment`
- `expiration`
- `migration`

点数余额不能直接由客户端修改。所有余额变化都必须写流水。

### 7.4 `credit_reservations`

- `id text primary key`
- `wallet_id text not null`
- `plan_id text`
- `status text not null`
- `expires_at timestamptz not null`
- `created_at timestamptz`
- `updated_at timestamptz`

状态：

- `reserved`
- `consumed`
- `released`
- `expired`

用途：规划开始前预留点数，成功时消费，失败时释放，避免生成成功但扣点失败。

### 7.5 `payment_orders`

- `id text primary key`
- `user_id text not null`
- `wallet_id text not null`
- `package_code text not null`
- `points integer not null`
- `amount_cents integer not null`
- `currency text not null default 'CNY'`
- `provider text not null`
- `provider_order_id text`
- `provider_transaction_id text`
- `status text not null`
- `paid_at timestamptz`
- `expires_at timestamptz`
- `created_at timestamptz`
- `updated_at timestamptz`

套餐固定映射：

| package_code | points | amount_cents |
| --- | ---: | ---: |
| `single` | 1 | 99 |
| `ten` | 10 | 941 |
| `thirty` | 30 | 2673 |

### 7.6 `payment_events`

- `id text primary key`
- `provider text not null`
- `provider_event_id text not null unique`
- `order_id text`
- `payload jsonb not null`
- `status text not null`
- `processed_at timestamptz`
- `created_at timestamptz`

支付回调必须幂等：同一个 `provider_event_id` 只能加点一次。

### 7.7 `travel_plans`

- `id text primary key`
- `user_id text not null`
- `title text not null`
- `origin text not null`
- `destination text not null`
- `days integer not null`
- `status text not null`
- `plan_data jsonb not null`
- `created_at timestamptz`
- `updated_at timestamptz`

首版只保存账号用户的正式行程。访客未登录前不写正式行程表。

### 7.8 `plan_shares`

- `id text primary key`
- `plan_id text not null`
- `owner_user_id text not null`
- `token_hash text not null unique`
- `status text not null`
- `expires_at timestamptz`
- `created_at timestamptz`

分享链接使用随机 Token，数据库只保存哈希。接收者只读访问。

### 7.9 `admin_audit_logs`

- `id text primary key`
- `admin_user_id text not null`
- `action text not null`
- `target_user_id text`
- `target_order_id text`
- `target_plan_id text`
- `details jsonb not null`
- `created_at timestamptz`

以下操作必须写审计：

- 修改用户状态。
- 调整点数。
- 退款。
- 修改管理员角色。
- 查看完整手机号等敏感信息。

## 8. 服务端模块设计

建议新增：

- `src/lib/credits.server.ts`：钱包、余额、预留、消费、退款。
- `src/lib/credits.functions.ts`：当前余额、流水、点数预留接口。
- `src/lib/payments.server.ts`：支付服务商适配、订单状态机。
- `src/lib/payments.functions.ts`：创建订单、查询订单。
- `src/lib/entitlements.server.ts`：首次免费和生成权限判断。
- `src/lib/plans.repository.ts`：旅行方案保存与读取。
- `src/lib/shares.server.ts`：分享 Token 和只读访问。
- `src/lib/admin.server.ts`：管理员授权与审计。
- `src/lib/admin.functions.ts`：管理员 API。
- `src/routes/api/payments/webhook.ts`：支付回调。

钱包修改必须在一个数据库事务中完成，并使用行锁或原子更新，防止并发双花。

## 9. 客户端页面与组件

新增路由：

- `/auth`：登录与注册。
- `/pricing`：B 路引点册。
- `/account`：账号、钱包、订单和行程。
- `/admin`：管理员后台。
- `/share/$token`：只读分享路书。

现有页面改造：

- `PlannerPrototype`：顶部增加低调入口、登录状态、余额提示和结果页购买入口。
- `GuidebookPreview`：未登录访客在保存、下载、分享时触发账号流程。
- `use-guidebook-export`：导出前检查账号与点数。
- 账号流程完成后使用 `returnTo` 返回原页面和原行程。
- 所有客户端只调用 server function，不直接修改钱包和订单。

## 10. 支付状态机

订单状态：

```text
created
  -> pending
  -> paid
  -> refunded

pending
  -> failed
  -> expired

created / pending
  -> closed
```

规则：

- `paid` 只能由服务端回调或主动查单确认后写入。
- 金额、币种、套餐和点数必须与本地订单完全匹配。
- 支付回调必须验签。
- 同一个回调重复到达不得重复加点。
- 支付成功后写入钱包流水 `purchase`。
- 退款成功后扣除未消费点数；已消费点数需要管理员人工处理。

## 11. 点数预留与消费规则

规划开始前：

1. 读取账号钱包。
2. 判断免费次数是否可用。
3. 免费或付费生成都建立幂等 `planId`。
4. 付费生成预留 1 点。
5. 规划成功时转为消费。
6. 规划失败时释放预留。
7. 超过 15 分钟未完成的预留自动过期并释放。

同一个 `planId` 只能消费或释放一次。重复请求返回相同结果。

## 12. 管理员设计

首版管理后台：

- 用户列表：手机号脱敏、状态、角色、余额、免费次数。
- 订单列表：金额、套餐、支付状态、时间。
- 点数流水：来源、正负值、余额、关联订单或行程。
- 手动调整点数：必须填写原因。
- 账号停用：不允许删除用户。
- 管理员审计日志。
- 基础统计：用户数、订单数、收入、生成次数。

管理员识别：

- 使用同一个 `/auth` 页面登录。
- `role=admin` 时显示管理入口。
- 不在公开页面展示管理员入口。
- 不在代码或迁移中写默认管理员密码。
- 首个管理员通过普通注册后，在 Supabase 中将 `role` 改为 `admin`。

## 13. 安全要求

- 密码只能由 Better Auth 哈希保存。
- 不记录密码、支付凭证和完整敏感回调内容。
- 管理员查看完整手机号必须写审计日志。
- 所有钱包修改必须服务端鉴权。
- 所有管理员 API 必须验证 `role=admin`。
- 支付回调必须验证签名和金额。
- 分享 Token 不能可预测。
- 分享页面不能暴露用户手机号、订单和钱包信息。
- 防止重复消费、负数余额、并发双花和重复加点。
- 关键接口必须限流。
- 错误信息不得泄露数据库、支付密钥和内部堆栈。

## 14. 测试策略

### 单元测试

- 手机号标准化。
- 套餐金额与点数映射。
- 钱包可用余额。
- 预留、消费、释放、过期。
- 免费体验只能使用一次。
- 支付回调幂等。
- 订单金额校验。
- 管理员权限判断。

### 集成测试

- 注册 -> 钱包创建。
- 首次免费 -> claim -> 第二次生成需要点数。
- 购买 -> 回调 -> 加点 -> 消费。
- 并发生成不能双花。
- 支付重复回调不能重复加点。
- 生成失败不扣点。
- 分享链接无需登录。
- 普通用户不能访问管理员接口。

### 浏览器测试

- 登录与注册表单。
- B 点册在桌面和移动端的布局。
- 支付确认抽屉。
- 从结果页和路书结尾进入账号或购买。
- 登录后回到原行程。
- 分享链接只读展示。

## 15. 实施切片

### 切片 1：账号与钱包

- 手机号 + 密码注册登录。
- 用户角色、状态、手机号字段。
- 钱包自动创建。
- 登录与注册页面正式接入。
- 基础账号页。

### 切片 2：首次免费与权益

- 访客首次生成。
- 保存、PDF、分享前的登录 claim。
- 免费体验消费记录。
- 行程归属账号。

### 切片 3：B 点册与订单

- `/pricing`。
- 套餐选择。
- 点数不足入口。
- 订单创建与查询。
- 后端支付服务商适配层。

### 切片 4：支付回调与点数流水

- 支付回调验签。
- 订单幂等。
- 支付加点。
- 钱包流水。
- 生成预留、消费、失败释放。

### 切片 5：管理员后台

- 角色授权。
- 用户、订单、流水。
- 手动调整点数。
- 审计日志。
- 基础统计。

### 切片 6：分享与跨设备

- 行程持久化。
- 分享 Token。
- 只读分享页。
- 账号登录后跨设备查看行程和点数。

## 16. 验收标准

- 用户不登录可以生成并预览第一份行程。
- 点击保存、PDF 或分享时，可以进入登录/注册并返回原行程。
- 注册成功自动创建钱包。
- 首次免费每个账号只能消费一次。
- 第二份行程必须登录并确认消耗 1 点。
- 生成失败不会扣点。
- 支付成功只由服务端确认。
- 重复支付回调不会重复加点。
- 点数和流水始终可以核对。
- 分享链接接收者无需登录。
- 管理员不能通过公开注册获得管理员角色。
- 管理员调整点数必须留审计记录。
- 手机号未验证和无法自助找回的提示清楚可见。
- 商业化能力不影响现有规划、路书和地图主链路。

## 17. 设计审查清单

- [ ] 已确认账号采用手机号 + 密码，不使用短信验证。
- [ ] 已确认首次生成不登录，保存/PDF/分享时登录。
- [ ] 已确认首次免费归属账号且每账号仅一次。
- [ ] 已确认点数套餐和价格。
- [ ] 已确认点数用于新方案生成，PDF 和分享不额外扣点。
- [ ] 已确认支付失败和生成失败均不扣点。
- [ ] 已确认分享者不登录、不扣点。
- [ ] 已确认管理员由普通账号升级，不设置默认密码。
- [ ] 已确认管理员操作写入审计日志。
- [ ] 已确认后续先写实施计划，再开始编码。
