import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { SharedGuidebookPage } from "@/components/share/SharedGuidebookPage";
import { getSharedPlan } from "@/lib/shares.functions";
import type { TripPlan } from "@/lib/travel-plan";

type SharedPageState =
  | { status: "loading" }
  | { status: "ready"; plan: TripPlan }
  | { status: "error"; message: string };

export const Route = createFileRoute("/share/$token")({
  component: ShareRoute,
});

function ShareRoute() {
  const { token } = Route.useParams();
  const fetchSharedPlan = useServerFn(getSharedPlan);
  const [state, setState] = useState<SharedPageState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    void fetchSharedPlan({ data: { token } })
      .then((result) => {
        if (!cancelled) setState({ status: "ready", plan: result.plan });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            status: "error",
            message: error instanceof Error ? error.message : "链接不存在或已失效",
          });
        }
      });
    return () => {
      cancelled = true;
    };
    // fetchSharedPlan 是 useServerFn 返回的稳定代理；只跟随分享令牌变化。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  if (state.status === "loading") {
    return (
      <main className="grid min-h-dvh place-items-center bg-[var(--v-bg)] px-5 text-sm text-[var(--v-muted)]">
        正在打开分享路书…
      </main>
    );
  }

  if (state.status === "error") {
    return (
      <main className="grid min-h-dvh place-items-center bg-[var(--v-bg)] px-5">
        <section className="w-full max-w-md rounded-[var(--v-card-radius)] border border-[var(--v-line)] bg-[var(--v-surface)] p-7 text-center">
          <h1 className="font-serif text-2xl text-[var(--v-ink)]">分享路书不可用</h1>
          <p className="mt-3 text-sm leading-6 text-[var(--v-muted)]">
            {state.message || "链接不存在或已失效"}
          </p>
          <a
            className="mt-6 inline-flex h-10 items-center justify-center rounded-lg bg-[var(--v-accent)] px-5 text-sm font-medium text-white no-underline"
            href="/"
          >
            返回首页
          </a>
        </section>
      </main>
    );
  }

  return <SharedGuidebookPage plan={state.plan} token={token} />;
}
