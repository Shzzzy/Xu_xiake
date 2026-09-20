import { useState } from "react";
import type { TripDay, TripPlan } from "../../../lib/travel-plan";
import { BudgetPanel } from "./BudgetPanel";
import { ExecutionTimeline } from "./ExecutionTimeline";

function formatDayDate(date: string, index: number) {
  const [, month, day] = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date) ?? [];
  if (!month || !day) return `第 ${index + 1} 天`;
  return `${Number(month)}月${Number(day)}日`;
}

function focusCount(day: TripDay) {
  return day.nodes.filter((node) => node.type === "attraction" || node.type === "night-activity")
    .length;
}

function lodgingOf(day: TripDay) {
  const hotel = day.nodes.find((node) => node.type === "hotel");
  return hotel?.location ?? hotel?.name ?? "住宿待确认";
}

function currency(value: number) {
  return `¥${Math.round(value).toLocaleString("zh-CN")}`;
}

export function TripOverview({ plan }: { plan: TripPlan }) {
  const [activeIndex, setActiveIndex] = useState(0);
  const activeDay = plan.days[activeIndex] ?? plan.days[0];

  if (!activeDay) {
    return (
      <section className="rounded-[var(--v-card-radius)] border border-[var(--v-line)] bg-[var(--v-soft)] p-6 text-sm text-[var(--v-muted)]">
        暂无执行日安排。
      </section>
    );
  }

  return (
    <section className="space-y-4" aria-label="B 布局行程执行结果">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[0.62rem] tracking-[0.18em] text-[var(--v-accent)]">
            EXECUTION / 可执行行程
          </p>
          <h2 className="mt-1 font-serif text-2xl text-[var(--v-ink)]">{plan.meta.title}</h2>
          <p className="mt-1 text-sm text-[var(--v-muted)]">
            {plan.meta.origin} → {plan.meta.destination} · {plan.meta.days} 天 ·{" "}
            {plan.meta.travelers.adults + plan.meta.travelers.children} 人
          </p>
        </div>
        <span className="rounded-full border border-[var(--v-line)] px-3 py-1 text-xs text-[var(--v-muted)]">
          当前第 {activeIndex + 1} / {plan.days.length} 天
        </span>
      </div>

      <div className="grid gap-4 xl:grid-cols-[17rem_minmax(0,1fr)_18rem] xl:items-start">
        <aside
          className="flex gap-3 overflow-x-auto pb-2 xl:sticky xl:top-24 xl:block xl:space-y-3 xl:overflow-visible xl:pb-0"
          aria-label="日期导航"
        >
          {plan.days.map((day, index) => {
            const isActive = index === activeIndex;
            return (
              <button
                key={`${day.date}-${index}`}
                type="button"
                aria-current={isActive ? "date" : undefined}
                onClick={() => setActiveIndex(index)}
                className={`min-w-[15.5rem] rounded-[var(--v-card-radius)] border p-4 text-left transition xl:w-full ${
                  isActive
                    ? "border-[var(--v-accent)] bg-[var(--v-soft)] shadow-[0_14px_35px_color-mix(in_oklab,var(--v-ink)_8%,transparent)]"
                    : "border-[var(--v-line)] bg-[var(--v-surface)] hover:border-[var(--v-accent)]"
                }`}
              >
                <span className="flex items-center justify-between gap-3">
                  <span className="text-[0.62rem] tracking-[0.16em] text-[var(--v-accent)]">
                    DAY {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="text-xs text-[var(--v-muted)]">
                    {formatDayDate(day.date, index)}
                  </span>
                </span>
                <strong className="mt-2 block font-serif text-lg leading-6 text-[var(--v-ink)]">
                  {plan.meta.destination} · {day.theme}
                </strong>
                <span className="mt-3 grid grid-cols-2 gap-2 text-xs text-[var(--v-muted)]">
                  <span>重点 {focusCount(day)} 个</span>
                  <span className="text-right">预计 {currency(day.estimatedCost)}</span>
                </span>
                <span
                  className="mt-2 block truncate text-xs text-[var(--v-muted)]"
                  title={lodgingOf(day)}
                >
                  住宿 · {lodgingOf(day)}
                </span>
              </button>
            );
          })}
        </aside>

        <section className="min-w-0" aria-label="执行时间轴">
          <ExecutionTimeline day={activeDay} />
        </section>

        <BudgetPanel budget={plan.budget} />
      </div>
    </section>
  );
}
