import { createFileRoute } from "@tanstack/react-router";
import { PricingBook } from "@/components/billing/PricingBook";
import { normalizeReturnTo } from "@/lib/auth/return-to";
import { useCurrentUserState } from "@/lib/auth/use-current-user";

export const Route = createFileRoute("/pricing")({
  validateSearch: (search: Record<string, unknown>) => ({
    returnTo: typeof search.returnTo === "string" ? normalizeReturnTo(search.returnTo) : undefined,
  }),
  component: PricingRoute,
});

function PricingRoute() {
  const { returnTo } = Route.useSearch();
  const { user, isPending } = useCurrentUserState();

  if (isPending) {
    return (
      <main className="grid min-h-dvh place-items-center bg-bg px-5 text-sm text-muted">
        正在打开行旅点册…
      </main>
    );
  }

  return (
    <PricingBook
      authenticated={Boolean(user)}
      returnTo={returnTo}
      onCheckout={() => {
        // 真实支付订单由后续任务接入；本任务只暴露确认回调。
      }}
    />
  );
}
