import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { AdminDashboard } from "@/components/admin/AdminDashboard";
import {
  adjustCreditsFn,
  getAdminDashboardData,
  revealFullPhoneFn,
  setUserStatusFn,
} from "@/lib/admin.functions";
import type { AdminDashboardData } from "@/lib/admin.server";
import { RedirectToSignIn } from "@/lib/auth/gates";
import { useCurrentUserState } from "@/lib/auth/use-current-user";

export const Route = createFileRoute("/admin")({
  // 私有或仅限持有链接访问的页面：明确 noindex，不参与收录，也不声明 canonical。
  head: () => ({
    meta: [
      { title: "管理后台 · 徐霞客旅行规划" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: AdminRoute,
});

function AdminRoute() {
  const { user, isPending } = useCurrentUserState();
  const loadDashboard = useServerFn(getAdminDashboardData);
  const adjust = useServerFn(adjustCreditsFn);
  const setStatus = useServerFn(setUserStatusFn);
  const revealPhone = useServerFn(revealFullPhoneFn);
  const [data, setData] = useState<AdminDashboardData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!user || user.role !== "admin") return;
    let cancelled = false;
    setLoading(true);
    setError("");
    void loadDashboard()
      .then((next) => {
        if (!cancelled) setData(next);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "管理数据加载失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // loadDashboard 是 useServerFn 返回的稳定代理；管理员变化或操作成功后重新加载。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, reloadKey]);

  if (isPending) {
    return (
      <main className="grid min-h-dvh place-items-center bg-[var(--v-bg)] px-5 text-sm text-[var(--v-muted)]">
        正在验证管理员身份…
      </main>
    );
  }

  if (!user) return <RedirectToSignIn />;

  if (user.role !== "admin") {
    return <ForbiddenPage />;
  }

  if (loading && !data) {
    return (
      <main className="grid min-h-dvh place-items-center bg-[var(--v-bg)] px-5 text-sm text-[var(--v-muted)]">
        正在加载运营数据…
      </main>
    );
  }

  if (error || !data) {
    if (error.includes("管理员权限")) return <ForbiddenPage />;
    return (
      <main className="grid min-h-dvh place-items-center bg-[var(--v-bg)] px-5">
        <section className="w-full max-w-lg rounded-[var(--v-card-radius)] border border-[var(--v-line)] bg-[var(--v-surface)] p-7 text-center">
          <h1 className="font-serif text-2xl text-[var(--v-ink)]">管理后台暂时不可用</h1>
          <p className="mt-3 text-sm leading-6 text-[var(--v-muted)]">{error || "请稍后重试"}</p>
          <button
            type="button"
            className="mt-6 h-10 rounded-lg bg-[var(--v-accent)] px-5 text-sm font-medium text-white"
            onClick={() => setReloadKey((value) => value + 1)}
          >
            重新加载
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="min-h-dvh bg-[var(--v-bg)] px-4 py-5 text-[var(--v-ink)] sm:px-6 sm:py-8">
      <div className="mx-auto max-w-[1500px] rounded-[var(--v-card-radius)] border border-[var(--v-line)] bg-[var(--v-surface)] p-4 shadow-[0_18px_50px_color-mix(in_oklab,var(--v-ink)_7%,transparent)] sm:p-6">
        <AdminDashboard
          {...data}
          onAdjustCredits={async (input) => {
            await adjust({ data: input });
            setReloadKey((value) => value + 1);
          }}
          onSetUserStatus={async (input) => {
            await setStatus({ data: input });
            setReloadKey((value) => value + 1);
          }}
          onRevealPhone={async (userId) => {
            const result = await revealPhone({ data: { userId } });
            return result.phone;
          }}
        />
      </div>
    </main>
  );
}

function ForbiddenPage() {
  return (
    <main className="grid min-h-dvh place-items-center bg-[var(--v-bg)] px-5">
      <section className="w-full max-w-md rounded-[var(--v-card-radius)] border border-[var(--v-line)] bg-[var(--v-surface)] p-7 text-center">
        <h1 className="font-serif text-2xl text-[var(--v-ink)]">403 · 无访问权限</h1>
        <p className="mt-3 text-sm leading-6 text-[var(--v-muted)]">
          当前账号不是管理员，无法访问运营后台。
        </p>
        <a
          className="mt-6 inline-flex h-10 items-center rounded-lg bg-[var(--v-accent)] px-5 text-sm font-medium text-white no-underline"
          href="/"
        >
          返回首页
        </a>
      </section>
    </main>
  );
}
