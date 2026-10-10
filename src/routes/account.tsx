import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import {
  AccountBookRouteView,
  loadAccountSummary,
  type AccountBookSummary,
} from "@/components/account/AccountBookPage";
import { RedirectToSignIn } from "@/lib/auth/gates";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { getMyWallet } from "@/lib/credits.functions";

type WalletLoadFailure = {
  userId: string;
  message: string;
};

export const Route = createFileRoute("/account")({
  // 私有或仅限持有链接访问的页面：明确 noindex，不参与收录，也不声明 canonical。
  head: () => ({
    meta: [
      { title: "账号 · 徐霞客旅行规划" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: AccountRoute,
});

function AccountRoute() {
  const { user, isPending } = useCurrentUserState();
  const loadWallet = useServerFn(getMyWallet);
  const [summary, setSummary] = useState<AccountBookSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<WalletLoadFailure | null>(null);
  const [authRequiredFor, setAuthRequiredFor] = useState<string | null>(null);

  useEffect(() => {
    const userId = user?.id;
    if (!userId) {
      setSummary(null);
      setFailure(null);
      setAuthRequiredFor(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setSummary(null);
    setFailure(null);
    setAuthRequiredFor(null);
    setLoading(true);

    void loadAccountSummary({
      userId,
      fetchWallet: () => loadWallet(),
      onSuccess: (nextSummary) => {
        if (!cancelled) setSummary(nextSummary);
      },
      onAuthRequired: () => {
        if (!cancelled) setAuthRequiredFor(userId);
      },
      onError: (message) => {
        if (!cancelled) setFailure({ userId, message });
      },
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });

    return () => {
      cancelled = true;
    };
    // loadWallet 由 useServerFn 返回稳定代理；只跟随当前用户变化重新取数。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  if (isPending) {
    return (
      <AccountBookRouteView
        user={user}
        isPending
        summary={summary}
        loading={loading}
        error={null}
      />
    );
  }

  if (!user || authRequiredFor === user.id) {
    return <RedirectToSignIn />;
  }

  return (
    <AccountBookRouteView
      user={user}
      isPending={false}
      summary={summary}
      loading={loading}
      error={failure?.userId === user.id ? failure.message : null}
    />
  );
}
