import { Cloud, CloudRain, CloudSun, Sun, Wind } from "lucide-react";
import type { DesignVariant } from "@/lib/design-variants";
import { classifyWeather, type WeatherDay } from "@/lib/planner";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";

function WeatherGlyph({ code, className }: { code: number; className?: string }) {
  const tone = classifyWeather(code).tone;
  if (tone === "clear") return <Sun className={className} />;
  if (tone === "rain" || tone === "storm") return <CloudRain className={className} />;
  if (tone === "cloudy") return <CloudSun className={className} />;
  return <Cloud className={className} />;
}

function shortDate(date: string) {
  const parts = date.split("-");
  return parts.length === 3 ? `${Number(parts[1])}/${Number(parts[2])}` : date;
}

export function WeatherStrip({
  days,
  variant,
  loading,
  error,
}: {
  days: WeatherDay[];
  variant: DesignVariant;
  loading: boolean;
  error?: string | null;
}) {
  if (loading) {
    return (
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-28 rounded-[var(--v-card-radius)]" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-[var(--v-card-radius)] border border-[var(--v-line)] bg-[var(--v-soft)] px-4 py-3 text-sm text-[var(--v-muted)]">
        天气服务暂时不可用：{error}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "grid overflow-hidden border border-[var(--v-line)] bg-[var(--v-surface)]",
        variant === "atlas" ? "md:grid-cols-4" : "sm:grid-cols-2 lg:grid-cols-4",
      )}
    >
      {days.map((day, index) => {
        const weather = classifyWeather(day.code);
        const rainy = weather.tone === "rain" || weather.tone === "storm";
        return (
          <article
            key={day.date}
            className={cn(
              "relative min-h-28 px-4 py-3",
              index > 0 && "border-t border-[var(--v-line)] sm:border-l sm:border-t-0",
              variant === "journal" && "journal-weather-cell",
              rainy && "bg-[var(--v-weather-rain)]",
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[11px] uppercase tracking-[0.18em] text-[var(--v-muted)]">
                  DAY {String(index + 1).padStart(2, "0")}
                </p>
                <p className="mt-1 font-serif text-lg text-[var(--v-ink)]">{shortDate(day.date)}</p>
              </div>
              <WeatherGlyph code={day.code} className="size-6 text-[var(--v-accent)]" />
            </div>
            <div className="mt-3 flex items-end justify-between gap-3">
              <div>
                <p className="text-2xl font-semibold tracking-tight text-[var(--v-ink)]">
                  {Math.round(day.tempMax)}°
                  <span className="ml-1 text-sm font-normal text-[var(--v-muted)]">
                     / {Math.round(day.tempMin)}°
                  </span>
                </p>
                <p className="mt-1 text-xs text-[var(--v-muted)]">{weather.label}</p>
              </div>
              <div className="text-right text-[11px] leading-5 text-[var(--v-muted)]">
                <span className="flex items-center justify-end gap-1">
                  <CloudRain className="size-3" /> {day.precipProb ?? 0}%
                </span>
                <span className="flex items-center justify-end gap-1">
                  <Wind className="size-3" /> {Math.round(day.windMax ?? 0)} km/h
                </span>
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}
