export type WeatherTone = "clear" | "cloudy" | "rain" | "storm" | "snow" | "fog";
export type Pace = "relaxed" | "balanced" | "deep";

export type WeatherDay = {
  date: string;
  code: number;
  tempMax: number;
  tempMin: number;
  precipProb?: number;
  windMax?: number;
  sunrise?: string;
  sunset?: string;
};

export type Place = {
  id: string;
  name: string;
  area: string;
  indoor: boolean;
  duration: number;
  summary: string;
  source: string;
};

export type PlannedDay = {
  day: number;
  places: Place[];
  weather?: WeatherDay;
  note?: string;
};

const PACE_LIMIT: Record<Pace, number> = {
  relaxed: 2,
  balanced: 3,
  deep: 4,
};

export function classifyWeather(code: number): { tone: WeatherTone; label: string } {
  if (code === 0) return { tone: "clear", label: "晴" };
  if (code >= 1 && code <= 3) return { tone: "cloudy", label: "多云" };
  if (code === 45 || code === 48) return { tone: "fog", label: "有雾" };
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) {
    return { tone: "rain", label: "有雨" };
  }
  if (code >= 71 && code <= 77) return { tone: "snow", label: "有雪" };
  if (code >= 95) return { tone: "storm", label: "雷雨" };
  return { tone: "cloudy", label: "天气多变" };
}

export function splitPlacesAcrossDays(
  places: Place[],
  weather: WeatherDay[],
  pace: Pace,
): PlannedDay[] {
  const dayCount = Math.max(weather.length, 1);
  const perDay = PACE_LIMIT[pace];
  const activePlaces = places.slice(0, perDay * dayCount);
  const baseSize = Math.floor(activePlaces.length / dayCount);
  const extra = activePlaces.length % dayCount;
  let cursor = 0;
  const rows: PlannedDay[] = [];

  for (let dayIndex = 0; dayIndex < dayCount; dayIndex += 1) {
    const currentWeather = weather[dayIndex];
    const size = baseSize + (dayIndex < extra ? 1 : 0);
    const dayPlaces = activePlaces.slice(cursor, cursor + size);
    cursor += size;
    const condition = currentWeather ? classifyWeather(currentWeather.code) : undefined;

    if (condition && (condition.tone === "rain" || condition.tone === "storm")) {
      dayPlaces.sort((a, b) => Number(b.indoor) - Number(a.indoor));
    }

    const note =
      condition?.tone === "rain" || condition?.tone === "storm"
        ? "先安排室内或短时停留点，下午根据降水情况调整。"
        : condition?.tone === "fog"
          ? "能见度有限，优先近景区域，暂缓登高观景。"
          : condition?.tone === "clear"
            ? "晴好天气，优先留给视野最好的户外景区。"
            : "按片区顺路游玩，减少来回穿行。";

    rows.push({ day: dayIndex + 1, places: dayPlaces, weather: currentWeather, note });
  }

  return rows;
}

export function weatherToneClass(tone?: WeatherTone) {
  if (tone === "rain" || tone === "storm") return "weather-rain";
  if (tone === "clear") return "weather-clear";
  if (tone === "fog") return "weather-fog";
  if (tone === "snow") return "weather-snow";
  return "weather-cloudy";
}

export function formatDuration(minutes: number) {
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.round((minutes / 60) * 10) / 10;
  return `${hours} 小时`;
}

