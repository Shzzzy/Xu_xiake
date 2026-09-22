import { CalendarPlus, MapPin, Navigation, Route, X } from "lucide-react";
import type {
  TripFeasibilityChoice,
  TripFeasibilityDecision,
  TripFeasibilityOption,
} from "@/lib/trip-feasibility";
import { cn } from "@/lib/utils";

type TripFeasibilityCardsProps = {
  decision: TripFeasibilityDecision;
  pending?: boolean;
  onSelect: (choice: TripFeasibilityChoice) => void;
  onCancel: () => void;
};

const optionIcons = {
  direct: Navigation,
  extend: CalendarPlus,
  focus: MapPin,
} as const;

function OptionCard({
  option,
  pending,
  onSelect,
}: {
  option: TripFeasibilityOption;
  pending: boolean;
  onSelect: (choice: TripFeasibilityChoice) => void;
}) {
  const Icon = optionIcons[option.strategy.type];
  return (
    <article
      className={cn(
        "flex h-full flex-col rounded-[var(--v-card-radius)] border bg-[var(--v-surface)] p-5 shadow-[0_18px_50px_rgba(35,42,35,0.06)]",
        option.recommended
          ? "border-[var(--v-accent)]/55 ring-1 ring-[var(--v-accent)]/15"
          : "border-[var(--v-line)]",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <span className="inline-flex size-10 items-center justify-center rounded-full bg-[var(--v-soft)] text-[var(--v-accent)]">
          <Icon className="size-5" aria-hidden="true" />
        </span>
        {option.recommended ? (
          <span className="rounded-full bg-[var(--v-accent)] px-2.5 py-1 text-[10px] font-medium tracking-[0.14em] text-white">
            推荐
          </span>
        ) : null}
      </div>

      <p className="mt-5 text-[11px] font-medium tracking-[0.2em] text-[var(--v-accent)]">
        方案 {option.eyebrow.replace(" / ", " · ")}
      </p>
      <h3 className="mt-2 font-serif text-2xl text-[var(--v-ink)]">{option.title}</h3>
      <p className="mt-3 text-sm leading-6 text-[var(--v-muted)]">{option.summary}</p>
      <p className="mt-3 text-xs leading-6 text-[var(--v-muted)]">{option.detail}</p>

      <div className="mt-4 flex flex-wrap gap-2">
        {option.metrics.map((metric) => (
          <span
            key={metric}
            className="rounded-full border border-[var(--v-line)] bg-[var(--v-soft)] px-2.5 py-1 text-[11px] text-[var(--v-muted)]"
          >
            {metric}
          </span>
        ))}
      </div>

      {option.strategy.type === "focus" ? (
        <div className="mt-auto pt-5">
          <p className="mb-2 text-xs text-[var(--v-muted)]">选择要保留的区域</p>
          <div className="flex flex-wrap gap-2">
            {option.strategy.targets.map((target) => (
              <button
                key={target}
                type="button"
                disabled={pending}
                className="rounded-full border border-[var(--v-accent)]/35 px-3 py-2 text-xs font-medium text-[var(--v-accent)] transition hover:bg-[var(--v-accent)] hover:text-white disabled:cursor-wait disabled:opacity-55"
                onClick={() => onSelect({ strategy: "focus", focusTarget: target })}
              >
                专注 {target}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <button
          type="button"
          disabled={pending}
          className={cn(
            "mt-auto w-full rounded-full px-4 py-3 text-sm font-medium transition disabled:cursor-wait disabled:opacity-55",
            option.recommended
              ? "bg-[var(--v-accent)] text-white hover:opacity-90"
              : "border border-[var(--v-line)] bg-[var(--v-soft)] text-[var(--v-ink)] hover:border-[var(--v-accent)]/40",
          )}
          onClick={() => {
            if (option.strategy.type === "direct") onSelect({ strategy: "direct" });
            if (option.strategy.type === "extend") onSelect({ strategy: "extend" });
          }}
        >
          {pending ? "正在重新规划…" : `选择方案 ${option.eyebrow.slice(0, 1)}`}
        </button>
      )}
    </article>
  );
}

export function TripFeasibilityCards({
  decision,
  pending = false,
  onSelect,
  onCancel,
}: TripFeasibilityCardsProps) {
  return (
    <section
      className="rounded-[calc(var(--v-card-radius)+8px)] border border-[var(--v-line)] bg-[linear-gradient(145deg,rgba(255,255,255,0.88),rgba(245,242,233,0.96))] p-5 sm:p-7"
      aria-labelledby="trip-feasibility-title"
    >
      <div className="flex flex-col gap-4 border-b border-[var(--v-line)] pb-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="max-w-3xl">
          <p className="text-[11px] font-medium tracking-[0.22em] text-[var(--v-accent)]">
            FEASIBILITY CHECK / 行程可行性
          </p>
          <h2 id="trip-feasibility-title" className="mt-2 font-serif text-3xl text-[var(--v-ink)]">
            时间不够，先确认调整方式
          </h2>
          <p className="mt-3 text-sm leading-7 text-[var(--v-muted)]">{decision.reason}</p>
        </div>
        <button
          type="button"
          className="inline-flex shrink-0 items-center gap-2 rounded-full border border-[var(--v-line)] px-4 py-2 text-xs text-[var(--v-muted)] transition hover:text-[var(--v-ink)] disabled:cursor-wait disabled:opacity-55"
          disabled={pending}
          onClick={onCancel}
        >
          <X className="size-3.5" aria-hidden="true" />
          取消调整
        </button>
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-3">
        {decision.options.map((option) => (
          <OptionCard
            key={option.strategy.type}
            option={option}
            pending={pending}
            onSelect={onSelect}
          />
        ))}
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3 rounded-[var(--v-card-radius)] bg-[var(--v-soft)] px-4 py-3 text-xs leading-6 text-[var(--v-muted)]">
        <Route className="size-4 text-[var(--v-accent)]" aria-hidden="true" />
        只有在你选择方案后才会修改路线、交通方式或天数；系统不会静默替换你的条件。
      </div>
    </section>
  );
}
