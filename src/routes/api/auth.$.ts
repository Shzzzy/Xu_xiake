import { createFileRoute } from "@tanstack/react-router";
import { auth } from "@/lib/auth/server";

// 将 Better Auth 的登录、注册和 Session 请求转发到应用自己的认证实例。
const handleAuthRequest = ({ request }: { request: Request }) => auth.handler(request);

export const Route = createFileRoute("/api/auth/$")({
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
