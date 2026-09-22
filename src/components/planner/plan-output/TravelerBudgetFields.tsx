import { LoaderCircle, Sparkles } from "lucide-react";
import type { TripBrief, VehicleEnergy } from "@/lib/travel-plan";
import { cn } from "@/lib/utils";

const vehicleEnergyOptions: { id: VehicleEnergy; label: string }[] = [
  { id: "fuel", label: "燃油" },
  { id: "electric", label: "纯电" },
  { id: "hybrid", label: "混动" },
];

// 将 AI 建议的预算合并到最新 brief 上，避免用点击时的快照覆盖用户在请求期间的新编辑。
export function applySuggestedBudget<T extends { totalBudget: number }>(
  prev: T,
  total: number,
): T {
  return { ...prev, totalBudget: total };
}

export function TravelerBudgetFields({
  value,
  onChange,
  showVehicleEnergy = false,
  budgetAdvice,
}: {
  value: TripBrief;
  onChange: (value: TripBrief) => void;
  showVehicleEnergy?: boolean;
  // AI 推荐由调用方注入：没有该 prop 时按钮不渲染。
  budgetAdvice?: {
    pending: boolean;
    hint?: string;
    /** 估算依据，例如「2 人」「5 天」「飞机」，让用户知道 AI 按什么算的。 */
    basis?: string[];
    onRequest: () => void;
  };
}) {
  const update = (patch: Partial<TripBrief>) => onChange({ ...value, ...patch });

  return (
    <section className="rounded-[var(--v-card-radius)] border border-[var(--v-line)] bg-[var(--v-soft)] p-4 sm:p-5">
      <div>
        <p className="text-[0.62rem] tracking-[0.16em] text-[var(--v-accent)]">
          TRAVELERS / 同行与预算
        </p>
        <h3 className="mt-1 font-serif text-lg text-[var(--v-ink)]">把人数和每天的时间定下来</h3>
        <p className="mt-1 text-xs leading-5 text-[var(--v-muted)]">
          预算按全团计算，出发和结束时间用于控制每日行程密度。
        </p>
      </div>

      <div className="mt-5 grid gap-4 sm:grid-cols-3">
        <label>
          <span className="planner-field-label">成人数</span>
          <input
            aria-label="成人数"
            type="number"
            min="1"
            step="1"
            value={value.adults}
            onChange={(event) => update({ adults: Number(event.target.value) })}
            className="planner-input"
          />
        </label>
        <label>
          <span className="planner-field-label">儿童数</span>
          <input
            aria-label="儿童数"
            type="number"
            min="0"
            step="1"
            value={value.children}
            onChange={(event) => update({ children: Number(event.target.value) })}
            className="planner-input"
          />
        </label>
        <label>
          <span className="planner-field-label">全团总预算</span>
          <div className="relative">
            <input
              aria-label="全团总预算"
              type="number"
              min="0"
              step="100"
              value={value.totalBudget}
              onChange={(event) => update({ totalBudget: Number(event.target.value) })}
              className="planner-input pr-10"
            />
            <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-[var(--v-muted)]">
              元
            </span>
          </div>
        </label>
      </div>

      {budgetAdvice ? (
        <div className="budget-advice-panel">
          <div className="budget-advice-copy">
            <strong>不知道该填多少？</strong>
            <span id="budget-advice-hint">
              {budgetAdvice.hint ?? "按人数、天数和交通方式给你一个参考预算。"}
            </span>
            {budgetAdvice.basis && budgetAdvice.basis.length > 0 ? (
              <ul className="budget-advice-basis" aria-label="估算依据">
                {budgetAdvice.basis.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            ) : null}
          </div>
          <button
            type="button"
            aria-label="AI 推荐预算"
            aria-describedby="budget-advice-hint"
            disabled={budgetAdvice.pending}
            onClick={budgetAdvice.onRequest}
            className="budget-advice-action"
          >
            {budgetAdvice.pending ? (
              <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Sparkles className="size-3.5" aria-hidden="true" />
            )}
            <span>{budgetAdvice.pending ? "正在估算" : "AI 推荐"}</span>
          </button>
        </div>
      ) : null}

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label>
          <span className="planner-field-label">每日出发时间</span>
          <input
            aria-label="每日出发时间"
            type="time"
            value={value.startTime}
            onChange={(event) => update({ startTime: event.target.value })}
            className="planner-input"
          />
        </label>
        <label>
          <span className="planner-field-label">每日最晚结束时间</span>
          <input
            aria-label="每日最晚结束时间"
            type="time"
            value={value.endTime}
            onChange={(event) => update({ endTime: event.target.value })}
            className="planner-input"
          />
        </label>
      </div>

      {showVehicleEnergy ? (
        <fieldset className="mt-5">
          <legend className="planner-field-label">自驾车辆能源</legend>
          <div className="route-style-segmented w-full">
            {vehicleEnergyOptions.map((option) => (
              <button
                key={option.id}
                type="button"
                aria-pressed={value.vehicleEnergy === option.id}
                className={cn("flex-1", value.vehicleEnergy === option.id && "is-active")}
                onClick={() => update({ vehicleEnergy: option.id })}
              >
                {option.label}
              </button>
            ))}
          </div>
        </fieldset>
      ) : null}
    </section>
  );
}
