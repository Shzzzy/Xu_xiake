import type { BudgetCategory, TripBudget } from "../../../lib/travel-plan";

const categoryDefinitions: {
  key: keyof Pick<TripBudget, "transport" | "lodging" | "food" | "tickets" | "other">;
  label: string;
  color: string;
  dotClass: string;
}[] = [
  { key: "transport", label: "交通", color: "#4a7c8a", dotClass: "bg-[#4a7c8a]" },
  { key: "lodging", label: "住宿", color: "#c96442", dotClass: "bg-[#c96442]" },
  { key: "food", label: "餐饮", color: "#d9a441", dotClass: "bg-[#d9a441]" },
  { key: "tickets", label: "门票", color: "#6b8e6a", dotClass: "bg-[#6b8e6a]" },
  { key: "other", label: "其他", color: "#8b7a9e", dotClass: "bg-[#8b7a9e]" },
];

function currency(value: number) {
  return `¥${Math.round(value).toLocaleString("zh-CN")}`;
}

function categoryRatio(category: BudgetCategory, total: number) {
  if (total <= 0) return category.ratio > 0 ? category.ratio : 0;
  return category.amount / total;
}

function buildConicGradient(budget: TripBudget) {
  const pairs = categoryDefinitions.map((definition) => ({
    color: definition.color,
    ratio: Math.max(0, categoryRatio(budget[definition.key], budget.estimatedTotal)),
  }));
  const ratioTotal = pairs.reduce((sum, item) => sum + item.ratio, 0);
  if (ratioTotal <= 0) return "conic-gradient(#d7d2c8 0 100%)";

  let cursor = 0;
  const stops = pairs.map((item, index) => {
    const start = cursor * 100;
    cursor += item.ratio / ratioTotal;
    const end = index === pairs.length - 1 ? 100 : cursor * 100;
    return `${item.color} ${start}% ${end}%`;
  });
  return `conic-gradient(${stops.join(", ")})`;
}

export function BudgetPanel({ budget }: { budget: TripBudget }) {
  const difference = budget.overBudget > 0 ? -budget.overBudget : budget.remaining;
  const overBudget = budget.overBudget > 0;

  return (
    <aside
      className="rounded-[var(--v-card-radius)] border border-[var(--v-line)] bg-[var(--v-surface)] p-5 xl:sticky xl:top-24"
      aria-label="预算侧栏"
    >
      <p className="text-[0.62rem] tracking-[0.16em] text-[var(--v-accent)]">BUDGET / 预算侧栏</p>
      <h3 className="mt-1 font-serif text-xl text-[var(--v-ink)]">全团总预算</h3>

      <div className="mt-5 grid grid-cols-2 gap-3">
        <div className="rounded-xl bg-[var(--v-soft)] p-3">
          <span className="text-xs text-[var(--v-muted)]">预算</span>
          <strong className="mt-1 block font-serif text-xl text-[var(--v-ink)]">
            {currency(budget.totalBudget)}
          </strong>
        </div>
        <div className="rounded-xl bg-[var(--v-soft)] p-3">
          <span className="text-xs text-[var(--v-muted)]">预计费用</span>
          <strong className="mt-1 block font-serif text-xl text-[var(--v-ink)]">
            {currency(budget.estimatedTotal)}
          </strong>
        </div>
      </div>

      <div
        className={`mt-3 rounded-xl border px-3 py-2.5 text-sm ${
          overBudget
            ? "border-[#d97757]/40 bg-[#f7e8e1] text-[#a54a32]"
            : "border-[#5f8f75]/35 bg-[#e8f1eb] text-[#35634d]"
        }`}
      >
        <span>{overBudget ? "超出预算" : "预算差额"}</span>
        <strong className="float-right">
          {difference >= 0 ? "+" : "−"}
          {currency(Math.abs(difference))}
        </strong>
      </div>

      <div className="mt-5 flex items-center gap-4">
        <div
          role="img"
          aria-label="预算构成饼图"
          className="size-28 shrink-0 rounded-full border-[6px] border-white shadow-[0_10px_25px_color-mix(in_oklab,var(--v-ink)_10%,transparent)]"
          style={{ background: buildConicGradient(budget) }}
        />
        <div className="min-w-0 flex-1 space-y-2">
          {categoryDefinitions.map((definition) => {
            const category = budget[definition.key];
            const ratio = categoryRatio(category, budget.estimatedTotal) * 100;
            return (
              <div key={definition.key} className="flex items-center justify-between gap-2 text-xs">
                <span className="flex min-w-0 items-center gap-2 text-[var(--v-muted)]">
                  <span className={`size-2.5 shrink-0 rounded-full ${definition.dotClass}`} />
                  <span className="truncate">{definition.label}</span>
                </span>
                <span className="shrink-0 font-medium text-[var(--v-ink)]">
                  {currency(category.amount)} · {Math.round(ratio)}%
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <dl className="mt-5 grid grid-cols-2 gap-3 border-t border-[var(--v-line)] pt-4 text-xs">
        <div>
          <dt className="text-[var(--v-muted)]">人均预算</dt>
          <dd className="mt-1 font-medium text-[var(--v-ink)]">
            {currency(budget.perPersonBudget)}
          </dd>
        </div>
        <div>
          <dt className="text-[var(--v-muted)]">人均预计</dt>
          <dd className="mt-1 font-medium text-[var(--v-ink)]">
            {currency(budget.perPersonEstimated)}
          </dd>
        </div>
      </dl>
    </aside>
  );
}
