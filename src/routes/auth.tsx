import { createFileRoute } from "@tanstack/react-router";
import { AuthBookPage } from "@/components/auth/AuthBookPage";

export const Route = createFileRoute("/auth")({
  validateSearch: (search: Record<string, unknown>) => ({
    returnTo: typeof search.returnTo === "string" ? search.returnTo : undefined,
  }),
  // 私有或仅限持有链接访问的页面：明确 noindex，不参与收录，也不声明 canonical。
  head: () => ({
    meta: [
      { title: "登录 · 徐霞客旅行规划" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: AuthRoute,
});

function AuthRoute() {
  const { returnTo } = Route.useSearch();
  return <AuthBookPage returnTo={returnTo} />;
}
