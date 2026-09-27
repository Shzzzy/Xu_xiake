import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import {
  loadPricingEntitlement,
  PricingBook,
  type PricingEntitlement,
} from "@/components/billing/PricingBook";
import { normalizeReturnTo } from "@/lib/auth/return-to";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { getMyWallet } from "@/lib/credits.functions";

export const Route = createFileRoute("/pricing")({
  validateSearch: (search: Record<string, unknown>) => ({
    returnTo: typeof search.returnTo === "string" ? normalizeReturnTo(search.returnTo) : undefined,
  }),
  component: PricingRoute,
});

function PricingRoute() {
  const { returnTo } = Route.useSearch();
  const { user, isPending } = useCurrentUserState();
  const loadWallet = useServerFn(getMyWallet);
  const [entitlementState, setEntitlementState] = useState<{
    userId: string;
    value: PricingEntitlement | null;
  } | null>(null);

  useEffect(() => {
    const userId = user?.id;
    let cancelled = false;
    if (!userId) {
      setEntitlementState(null);
      return;
    }

    void loadPricingEntitlement({
      userId,
      fetchWallet: () => loadWallet(),
      onEntitlement: (nextEntitlement) => {
        if (!cancelled) setEntitlementState({ userId, value: nextEntitlement });
      },
    }).catch((error) => {
      if (cancelled) return;
      console.error("点册状态加载失败", error);
      setEntitlementState({ userId, value: null });
    });

    return () => {
      cancelled = true;
    };
    // loadWallet 由 useServerFn 返回稳定代理；只跟随当前用户变化重新取数。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

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
      entitlement={user?.id === entitlementState?.userId ? (entitlementState?.value ?? null) : null}
      returnTo={returnTo}
      onCheckout={() => {
        // 真实支付订单由后续任务接入；本任务只暴露确认回调。
      }}
    />
  );
}
