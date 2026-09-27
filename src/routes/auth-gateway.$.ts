import { createFileRoute } from "@tanstack/react-router";
import { auth } from "@/lib/auth/server";

// 生产构建使用不含 api 的认证路径，避免部分浏览器扩展直接拦截认证请求。
const handleAuthRequest = ({ request }: { request: Request }) => auth.handler(request);

export const Route = createFileRoute("/auth-gateway/$")({
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
