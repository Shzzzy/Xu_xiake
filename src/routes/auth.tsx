import { createFileRoute } from "@tanstack/react-router";
import { AuthBookPage } from "@/components/auth/AuthBookPage";

export const Route = createFileRoute("/auth")({
  validateSearch: (search: Record<string, unknown>) => ({
    returnTo: typeof search.returnTo === "string" ? search.returnTo : undefined,
  }),
  component: AuthRoute,
});

function AuthRoute() {
  const { returnTo } = Route.useSearch();
  return <AuthBookPage returnTo={returnTo} />;
}
