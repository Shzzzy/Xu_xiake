import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { AccountBookPage } from "@/components/account/AccountBookPage";
import { RedirectToSignIn } from "@/lib/auth/gates";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { getMyWallet } from "@/lib/credits.functions";
import type { CreditLedgerEntry, CreditWallet } from "@/lib/credits/types";

type WalletSummary = {
  wallet: CreditWallet;
  ledger: CreditLedgerEntry[];
};

export const Route = createFileRoute("/account")({
  component: AccountRoute,
});

function AccountRoute() {
  const { user, isPending } = useCurrentUserState();
  const loadWallet = useServerFn(getMyWallet);
  const [summary, setSummary] = useState<WalletSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!user) {
      setSummary(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError("");
    loadWallet()
      .then((result) => {
        if (!cancelled) setSummary(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "钱包加载失败，请稍后重试。");
        }
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
    return <AccountRouteMessage message="正在确认真实行程账号…" />;
  }

  if (!user) {
    return <RedirectToSignIn />;
  }

  if (loading && !summary) {
    return <AccountRouteMessage message="正在整理你的行旅点册…" />;
  }

  if (error && !summary) {
    return <AccountRouteMessage message={error} tone="error" />;
  }

  if (!summary) {
    return <AccountRouteMessage message="钱包正在准备中，请稍后刷新。" />;
  }

  return (
    <AccountBookPage
      user={{
        id: user.id,
        phone: user.phone,
        role: user.role,
        status: user.status,
      }}
      wallet={summary.wallet}
      ledger={summary.ledger}
    />
  );
}

function AccountRouteMessage({
  message,
  tone = "neutral",
}: {
  message: string;
  tone?: "neutral" | "error";
}) {
  return (
    <main className="grid min-h-dvh place-items-center bg-bg px-4 text-fg">
      <div
        className={`w-full max-w-md rounded-[24px] border bg-surface p-7 text-center shadow-soft ${
          tone === "error" ? "border-warn/25" : "border-border"
        }`}
        role={tone === "error" ? "alert" : "status"}
      >
        <span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-primary text-lg font-bold text-primary-fg">
          徐
        </span>
        <p className="mt-4 text-sm leading-6 text-muted">{message}</p>
        {tone === "error" ? (
          <a
            className="mt-4 inline-flex text-sm font-semibold text-primary no-underline"
            href="/account"
          >
            重新加载
          </a>
        ) : null}
      </div>
    </main>
  );
}
