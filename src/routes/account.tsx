import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import {
  AccountBookRouteView,
  getWalletLoadErrorAction,
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

    loadWallet()
      .then((result) => {
        if (!cancelled) {
          setSummary({ ...result, userId });
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;

        if (getWalletLoadErrorAction(err) === "redirect") {
          setAuthRequiredFor(userId);
          return;
        }

        // 只向用户展示统一文案；详细错误留在控制台供排查，避免泄露内部信息。
        console.error("[account] 钱包加载失败", err);
        setFailure({ userId, message: "暂时无法加载账号信息，请稍后重试。" });
      })
      .finally(() => {
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
