import { createFileRoute } from "@tanstack/react-router";
import { auth } from "@/lib/auth/server";

// 生产构建使用独立认证路径，避免浏览器扩展拦截 /api/auth/*。
const handleAuthRequest = ({ request }: { request: Request }) => auth.handler(request);

export const Route = createFileRoute("/auth-api/$")({
  server: {
    handlers: {
      GET: handleAuthRequest,
      POST: handleAuthRequest,
      PUT: handleAuthRequest,
      PATCH: handleAuthRequest,
      DELETE: handleAuthRequest,
      OPTIONS: handleAuthRequest,
      HEAD: handleAuthRequest,
    },
  },
});
