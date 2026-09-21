# 徐霞客旅行规划

一个中文旅行行程规划应用，支持目的地与多途经点路线、实时天气、DeepSeek 行程编排，以及 Tavily 地点资料检索。

## 功能

- 目的地、日期、天数、节奏与兴趣偏好设置
- 多途经点路线和分段交通方式
- 实时天气与逐日行程规划
- 未知途经点的 Tavily 检索与 DeepSeek 地区校核
- 经过校核的地点沉淀到所有访客共享的灵感景点库
- 动态灵感地点使用稳定且唯一的 SVG 配图
- AI 管家式排程：在人数、预算、交通与节奏条件内生成完整计划，摘要与每日排程同源

## 开发

```bash
npm install
npm run dev
```

默认开发服务绑定 `0.0.0.0:8080`。

## 环境变量

部署时需要按平台配置：

- `BUTLER_PLANNER`：设置为 `1` 时启用 AI 管家链路；默认关闭并使用 legacy 链路。启用时需要同时配置 `DEEPSEEK_API_KEY` 与 `TAVILY_API_KEY`。
- `DEEPSEEK_API_KEY`：DeepSeek 行程规划、地点校核与管家式排程
- `TAVILY_API_KEY`：目的地及途经点资料检索
- `DATABASE_URL`：持久化共享灵感景点；本地未配置时使用 PGlite 回退

不要提交 `.env` 或任何密钥文件。

## 验证

```bash
npm test
npm run typecheck
npm run build
```
