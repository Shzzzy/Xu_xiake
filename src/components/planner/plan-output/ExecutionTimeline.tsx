import type { TimelineNodeType, TripDay, TripTimelineNode } from "../../../lib/travel-plan";

const nodeMeta: Record<TimelineNodeType, { label: string; badgeClass: string; dotClass: string }> =
  {
    transport: {
      label: "交通",
      badgeClass: "bg-[#e3eef1] text-[#356474]",
      dotClass: "bg-[#4a7c8a]",
    },
    transfer: {
      label: "换乘",
      badgeClass: "bg-[#e9e4f0] text-[#66527a]",
      dotClass: "bg-[#8b7a9e]",
    },
    attraction: {
      label: "景点",
      badgeClass: "bg-[#e8f1eb] text-[#35634d]",
      dotClass: "bg-[#5f8f75]",
    },
    meal: { label: "用餐", badgeClass: "bg-[#f7edda] text-[#86621f]", dotClass: "bg-[#d9a441]" },
    rest: { label: "休息", badgeClass: "bg-[#edf0f1] text-[#58656c]", dotClass: "bg-[#81949d]" },
    hotel: { label: "酒店", badgeClass: "bg-[#f5e7e1] text-[#8c4934]", dotClass: "bg-[#c96442]" },
    "night-activity": {
      label: "夜游",
      badgeClass: "bg-[#e8e9f4] text-[#4b527f]",
      dotClass: "bg-[#6670aa]",
    },
  };

function currency(value: number) {
  return `¥${Math.round(value).toLocaleString("zh-CN")}`;
}

function dateLabel(date: string) {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!matched) return date;
  return `${matched[1]}年${Number(matched[2])}月${Number(matched[3])}日`;
}

function nodeHint(node: TripTimelineNode) {
  const hints: string[] = [];
  if (node.transportMinutes) hints.push(`交通约 ${node.transportMinutes} 分钟`);
  if (node.stayMinutes) hints.push(`停留约 ${node.stayMinutes} 分钟`);
  return hints.join(" · ");
}

function TimelineNode({ node }: { node: TripTimelineNode }) {
  const meta = nodeMeta[node.type];
  const hint = nodeHint(node);

  return (
    <li className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-3 sm:grid-cols-[7rem_minmax(0,1fr)]">
      <div className="pt-3 text-right">
        <p className="text-xs font-medium text-[var(--v-ink)]">{node.timeLabel}</p>
        {node.timeLabel !== `${node.startTime}–${node.endTime}` ? (
          <p className="mt-1 text-[10px] text-[var(--v-muted)]">
            {node.startTime}–{node.endTime}
          </p>
        ) : null}
      </div>
      <div className="relative border-l border-[var(--v-line)] pb-5 pl-5">
        <span
          className={`absolute -left-[5px] top-4 size-[9px] rounded-full ring-4 ring-[var(--v-surface)] ${meta.dotClass}`}
        />
        <article className="rounded-[var(--v-card-radius)] border border-[var(--v-line)] bg-[var(--v-surface)] p-4 shadow-[0_10px_30px_color-mix(in_oklab,var(--v-ink)_5%,transparent)]">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <span
                className={`inline-flex rounded-full px-2.5 py-1 text-[10px] ${meta.badgeClass}`}
              >
                {meta.label}
              </span>
              <h3 className="mt-2 font-serif text-lg leading-6 text-[var(--v-ink)]">{node.name}</h3>
              {node.location ? (
                <p className="mt-1 text-xs text-[var(--v-muted)]">{node.location}</p>
              ) : null}
            </div>
            <span className="shrink-0 text-xs font-medium text-[var(--v-ink)]">
              {node.estimatedCost > 0 ? currency(node.estimatedCost) : "无额外费用"}
            </span>
          </div>
          {hint ? <p className="mt-2 text-xs text-[var(--v-muted)]">{hint}</p> : null}
          {node.tips ? (
            <p className="mt-3 text-xs leading-5 text-[var(--v-muted)]">{node.tips}</p>
          ) : null}
          {node.navigation ? (
            <a
              href={node.navigation}
              target="_blank"
              rel="noreferrer"
              className="mt-3 inline-flex text-xs font-medium text-[var(--v-accent)] underline decoration-[var(--v-line)] underline-offset-4"
            >
              打开导航
            </a>
          ) : null}
        </article>
      </div>
    </li>
  );
}

export function ExecutionTimeline({ day, dayNumber }: { day: TripDay; dayNumber: number }) {
  const focusNodes = day.nodes.filter(
    (node) => node.type === "attraction" || node.type === "night-activity",
  ).length;

  return (
    <section className="rounded-[var(--v-card-radius)] border border-[var(--v-line)] bg-[var(--v-surface)] p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl">
          <p className="text-[0.62rem] tracking-[0.18em] text-[var(--v-accent)]">
            DAY {String(dayNumber).padStart(2, "0")} · {dateLabel(day.date)}
          </p>
          <h2 className="mt-2 font-serif text-2xl text-[var(--v-ink)]">{day.theme}</h2>
          <p className="mt-2 text-sm leading-6 text-[var(--v-muted)]">{day.purpose}</p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs text-[var(--v-muted)]">
          {day.weather ? (
            <span className="rounded-full bg-[var(--v-soft)] px-3 py-1">{day.weather}</span>
          ) : null}
          <span className="rounded-full bg-[var(--v-soft)] px-3 py-1">
            {day.nodes.length} 个节点
          </span>
          <span className="rounded-full bg-[var(--v-soft)] px-3 py-1">{focusNodes} 个重点</span>
          <span className="rounded-full bg-[var(--v-soft)] px-3 py-1">
            预计 {currency(day.estimatedCost)}
          </span>
        </div>
      </div>

      <ol className="mt-6">
        {day.nodes.map((node, index) => (
          <TimelineNode key={`${node.startTime}-${node.name}-${index}`} node={node} />
        ))}
      </ol>

      {day.highlights.length > 0 || day.cautions.length > 0 ? (
        <div className="mt-2 grid gap-3 border-t border-[var(--v-line)] pt-4 md:grid-cols-2">
          {day.highlights.length > 0 ? (
            <div>
              <p className="text-xs font-medium text-[var(--v-ink)]">当日亮点</p>
              <ul className="mt-2 space-y-1.5 text-xs leading-5 text-[var(--v-muted)]">
                {day.highlights.map((highlight) => (
                  <li key={highlight}>· {highlight}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {day.cautions.length > 0 ? (
            <div>
              <p className="text-xs font-medium text-[var(--v-ink)]">执行提醒</p>
              <ul className="mt-2 space-y-1.5 text-xs leading-5 text-[var(--v-muted)]">
                {day.cautions.map((caution) => (
                  <li key={caution}>· {caution}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
