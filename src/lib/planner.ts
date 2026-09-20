import type { RoutePlan } from "./route-planner";

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

function routeStopPlace(name: string, area: string, idPrefix: string, index: number): Place {
  return {
    id: `${idPrefix}:${index}:${name}`,
    name,
    area,
    indoor: false,
    duration: 180,
    summary: "作为路线中的实际停留点，建议到达后按现场情况安排游玩，并给下一段交通留出缓冲。",
    source: "https://maps.google.com",
  };
}

function fallbackDayNote(weather?: WeatherDay) {
  const condition = weather ? classifyWeather(weather.code) : undefined;
  if (condition?.tone === "rain" || condition?.tone === "storm") {
    return "优先安排短时或室内停留，下午根据降水情况调整。";
  }
  if (condition?.tone === "fog") {
    return "能见度有限，优先近景区域，暂缓登高观景。";
  }
  if (condition?.tone === "clear") {
    return "晴好天气，优先安排视野最好的户外路段。";
  }
  return "按填写顺序推进路线，减少来回折返。";
}

export function buildRouteFallbackDays(input: {
  route: RoutePlan;
  days: number;
  destinationPlaces: Place[];
  weather: WeatherDay[];
  pace: Pace;
}): PlannedDay[] {
  const dayCount = Math.max(1, input.days);
  const waypointStops = input.route.waypoints.map((name, index) =>
    routeStopPlace(name, `途经点 ${index + 1}`, "fallback-waypoint", index),
  );
  const destinationAnchor = routeStopPlace(
    input.route.destination,
    "目的地",
    "fallback-destination",
    0,
  );
  const destinationStops =
    input.destinationPlaces.length > 0 ? input.destinationPlaces : [destinationAnchor];
  const maxStops = Math.max(waypointStops.length + 1, dayCount * PACE_LIMIT[input.pace]);
  const orderedStops = [...waypointStops, ...destinationStops].slice(0, maxStops);

  const baseSize = Math.floor(orderedStops.length / dayCount);
  const extra = orderedStops.length % dayCount;
  let cursor = 0;

  return Array.from({ length: dayCount }, (_, index) => {
    const size = baseSize + (index < extra ? 1 : 0);
    const places = orderedStops.slice(cursor, cursor + size);
    const weather = input.weather[index];
    cursor += size;
    return {
      day: index + 1,
      places,
      weather,
      note: fallbackDayNote(weather),
    };
  });
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
