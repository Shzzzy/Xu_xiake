import { BookOpenText, LockKeyhole } from "lucide-react";
import type { TripPlan } from "@/lib/travel-plan";
import { GuidebookPreview } from "@/components/planner/plan-output/GuidebookPreview";

export function SharedGuidebookPage({ plan, token }: { plan: TripPlan; token: string }) {
  return (
    <main className="min-h-dvh bg-[var(--v-bg)] px-4 py-5 text-[var(--v-ink)] sm:px-6 sm:py-8">
      <div className="mx-auto max-w-[1320px]">
        <header className="flex flex-wrap items-center justify-between gap-4 rounded-[var(--v-card-radius)] border border-[var(--v-line)] bg-[var(--v-surface)] px-4 py-3 shadow-[0_12px_32px_color-mix(in_oklab,var(--v-ink)_7%,transparent)] sm:px-6">
          <a className="flex items-center gap-3 text-inherit no-underline" href="/">
            <span className="grid size-10 place-items-center rounded-xl bg-[var(--v-accent)] font-serif text-lg font-bold text-white">
              徐
            </span>
            <span>
              <strong className="block font-serif text-base">你好，徐霞客</strong>
              <small className="block text-[10px] tracking-[0.16em] text-[var(--v-muted)]">
                SHARED GUIDEBOOK / 只读路书
              </small>
            </span>
          </a>
          <div className="flex items-center gap-2 text-xs text-[var(--v-muted)]">
            <BookOpenText className="size-4 text-[var(--v-accent)]" />
            <span>同行者查看无需登录</span>
            <span className="mx-1 text-[var(--v-line)]">|</span>
            <LockKeyhole className="size-3.5" />
            <span>只读分享</span>
          </div>
        </header>

        <section className="mt-5 rounded-[var(--v-card-radius)] border border-[var(--v-line)] bg-[var(--v-surface)] p-4 sm:p-6">
          <GuidebookPreview
            plan={plan}
            planId="shared"
            requestFingerprint="shared"
            shareToken={token}
            readOnly
          />
        </section>

        <footer className="mt-5 text-center text-xs leading-6 text-[var(--v-muted)]">
          本页仅展示分享者生成的路书内容，不展示账号、订单或钱包信息。
        </footer>
      </div>
    </main>
  );
}
