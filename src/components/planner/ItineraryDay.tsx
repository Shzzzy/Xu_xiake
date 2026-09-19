import { ArrowUpRight, CloudRain, MapPin, Timer } from "lucide-react";
import type { DesignVariant } from "@/lib/design-variants";
import { classifyWeather, formatDuration, type PlannedDay, type Place } from "@/lib/planner";
import { cn } from "@/lib/utils";

export function ItineraryDay({
  day,
  variant,
  onPlace,
}: {
  day: PlannedDay;
  variant: DesignVariant;
  onPlace: (place: Place) => void;
}) {
  const weather = day.weather ? classifyWeather(day.weather.code) : undefined;
  const rainy = weather?.tone === "rain" || weather?.tone === "storm";

  if (variant === "atlas") {
    return (
      <section className="atlas-day grid gap-5 border-t border-[var(--v-line)] py-7 lg:grid-cols-[10rem_1fr]">
        <div className="lg:sticky lg:top-28 lg:self-start">
          <p className="text-xs tracking-[0.28em] text-[var(--v-accent)]">
            ROUTE {String(day.day).padStart(2, "0")}
          </p>
          <p className="mt-2 font-serif text-4xl text-[var(--v-ink)]">{day.day}</p>
          {day.weather ? (
            <p className="mt-3 text-sm text-[var(--v-muted)]">
              {weather?.label} · {Math.round(day.weather.tempMin)}–{Math.round(day.weather.tempMax)}°
            </p>
          ) : null}
        </div>
        <div>
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <p className="max-w-2xl text-sm leading-6 text-[var(--v-muted)]">{day.note}</p>
            {rainy ? (
              <span className="inline-flex items-center gap-1.5 text-xs text-[var(--v-accent)]">
                <CloudRain className="size-4" /> 已启用雨天顺序
              </span>
            ) : null}
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {day.places.map((place, index) => (
              <button
                key={place.id}
                type="button"
                onClick={() => onPlace(place)}
                className="group grid grid-cols-[3rem_1fr] gap-4 border border-[var(--v-line)] bg-[var(--v-surface)] p-4 text-left transition hover:border-[var(--v-accent)]"
              >
                <span className="font-mono text-xl text-[var(--v-accent)]">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span>
                  <span className="flex items-center justify-between gap-3 text-base font-medium text-[var(--v-ink)]">
                    {place.name}
                    <ArrowUpRight className="size-4 transition group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
                  </span>
                  <span className="mt-1 flex items-center gap-2 text-xs text-[var(--v-muted)]">
                    <MapPin className="size-3.5" /> {place.area}
                    <Timer className="ml-1 size-3.5" /> {formatDuration(place.duration)}
                  </span>
                  <span className="mt-3 block text-sm leading-6 text-[var(--v-muted)]">
                    {place.summary}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>
      </section>
    );
  }

  if (variant === "journal") {
    return (
      <section className="journal-day border-t border-[var(--v-ink)] py-8 md:grid md:grid-cols-[11rem_1fr] md:gap-10">
        <div>
          <p className="text-xs font-medium tracking-[0.22em] text-[var(--v-seal)]">DAY</p>
          <p className="font-serif text-6xl leading-none text-[var(--v-ink)]">
            {String(day.day).padStart(2, "0")}
          </p>
          {day.weather ? (
            <div className="mt-4 inline-flex rotate-[-1deg] border border-[var(--v-ink)] px-3 py-1.5 text-xs text-[var(--v-ink)]">
              {weather?.label} · {Math.round(day.weather.tempMin)}–{Math.round(day.weather.tempMax)}°
            </div>
          ) : null}
        </div>
        <div className="mt-6 md:mt-0">
          <p className="max-w-2xl font-serif text-xl leading-8 text-[var(--v-ink)]">{day.note}</p>
          <div className="mt-6 divide-y divide-[var(--v-line)]">
            {day.places.map((place) => (
              <button
                key={place.id}
                type="button"
                onClick={() => onPlace(place)}
                className="group grid w-full gap-4 py-5 text-left transition hover:px-2 md:grid-cols-[1fr_auto]"
              >
                <span>
                  <span className="block font-serif text-xl text-[var(--v-ink)]">{place.name}</span>
                  <span className="mt-1 block text-sm leading-6 text-[var(--v-muted)]">
                    {place.summary}
                  </span>
                </span>
                <span className="flex items-start gap-2 text-xs text-[var(--v-muted)]">
                  <MapPin className="size-4 text-[var(--v-seal)]" />
                  {place.area} · {formatDuration(place.duration)}
                </span>
              </button>
            ))}
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="scroll-day relative grid gap-5 pb-10 md:grid-cols-[6rem_1fr] md:gap-7">
      <div className="relative">
        <div className="sticky top-24 flex size-16 items-center justify-center rounded-full border border-[var(--v-accent)] bg-[var(--v-paper)] font-serif text-2xl text-[var(--v-accent)] shadow-[inset_0_0_0_4px_var(--v-paper),inset_0_0_0_5px_var(--v-line)]">
          {day.day}
        </div>
        <div className="absolute left-8 top-16 hidden h-[calc(100%-2rem)] w-px bg-[var(--v-line)] md:block" />
      </div>
      <div>
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-xs tracking-[0.22em] text-[var(--v-accent)]">
              DAY {String(day.day).padStart(2, "0")}
            </p>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--v-muted)]">{day.note}</p>
          </div>
          {day.weather ? (
            <span
              className={cn(
                "rounded-full px-3 py-1 text-xs",
                rainy
                  ? "bg-[var(--v-weather-rain)] text-[var(--v-accent)]"
                  : "bg-[var(--v-soft)] text-[var(--v-muted)]",
              )}
            >
              {weather?.label} {Math.round(day.weather.tempMin)}–{Math.round(day.weather.tempMax)}°
            </span>
          ) : null}
        </div>
        <div className="grid gap-3">
          {day.places.map((place, index) => (
            <button
              key={place.id}
              type="button"
              onClick={() => onPlace(place)}
              className="group relative grid gap-3 overflow-hidden border-l border-[var(--v-line)] bg-[var(--v-surface)]/70 px-5 py-4 text-left shadow-[0_10px_35px_color-mix(in_oklab,var(--v-ink)_5%,transparent)] transition hover:translate-x-1 hover:border-[var(--v-accent)]"
            >
              <span className="absolute right-4 top-3 font-serif text-4xl text-[var(--v-ink)]/8">
                {String(index + 1).padStart(2, "0")}
              </span>
              <span className="flex flex-wrap items-center gap-2 pr-12 font-serif text-lg text-[var(--v-ink)]">
                {place.name}
                {place.indoor ? (
                  <span className="rounded-full bg-[var(--v-soft)] px-2 py-0.5 font-sans text-[10px] text-[var(--v-muted)]">
                    室内
                  </span>
                ) : null}
              </span>
              <span className="max-w-2xl text-sm leading-6 text-[var(--v-muted)]">
                {place.summary}
              </span>
              <span className="flex items-center gap-3 text-xs text-[var(--v-muted)]">
                <MapPin className="size-3.5" /> {place.area}
                <Timer className="size-3.5" /> {formatDuration(place.duration)}
              </span>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
