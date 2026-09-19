import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { parseMcpSse } from "./mcp-sse";
import type { WeatherDay } from "./planner";

const DEFAULT_MCP_ENDPOINT = "https://open-meteo.caseyjhand.com/mcp";
const PROTOCOL_VERSION = "2025-03-26";

type McpToolResult = {
  content?: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

type GeoPayload = {
  results?: { name?: string; latitude?: number; longitude?: number; timezone?: string | null }[];
};

type ForecastPayload = {
  daily?: Record<string, unknown>[];
  timezone?: string;
  record_count?: number;
};

async function callMcpTool(
  endpoint: string,
  id: number,
  name: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": PROTOCOL_VERSION,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });

  if (!response.ok) throw new Error(`天气服务请求失败（${response.status}）`);

  const messages = parseMcpSse(await response.text());
  const frame = messages.find((message) => message.id === id);
  if (!frame) throw new Error("天气服务未返回有效结果");
  if (frame.error) throw new Error(frame.error.message ?? "天气服务调用失败");

  const result = frame.result as McpToolResult | undefined;
  if (!result || result.isError) {
    const message = result?.content?.map((item) => item.text).filter(Boolean).join(" ");
    throw new Error(message || "天气服务调用失败");
  }

  return result;
}

async function resolveCoordinates(
  endpoint: string,
  input: { latitude?: number; longitude?: number; placeName?: string },
) {
  if (typeof input.latitude === "number" && typeof input.longitude === "number") {
    return {
      latitude: input.latitude,
      longitude: input.longitude,
      label: input.placeName ?? `${input.latitude},${input.longitude}`,
    };
  }

  const name = input.placeName?.trim();
  if (!name) throw new Error("缺少目的地名称或坐标");

  const result = await callMcpTool(endpoint, 10, "openmeteo_search_locations", {
    name,
    country: "CN",
    count: 5,
    language: "zh",
  });
  const first = ((result.structuredContent ?? {}) as GeoPayload).results?.[0];
  if (!first || typeof first.latitude !== "number" || typeof first.longitude !== "number") {
    throw new Error(`无法定位目的地「${name}」`);
  }

  return {
    latitude: first.latitude,
    longitude: first.longitude,
    label: first.name ?? name,
  };
}

function readNumber(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readString(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function normalizeDaily(payload: ForecastPayload): WeatherDay[] {
  return (payload.daily ?? []).map((row) => ({
    date: readString(row.time) ?? "",
    code: readNumber(row.weather_code),
    tempMax: readNumber(row.temperature_2m_max),
    tempMin: readNumber(row.temperature_2m_min),
    precipProb: readNumber(row.precipitation_probability_max),
    windMax: readNumber(row.wind_speed_10m_max),
    sunrise: readString(row.sunrise),
    sunset: readString(row.sunset),
  }));
}

export const getOpenMeteoForecast = createServerFn({ method: "GET" })
  .validator(
    z
      .object({
        latitude: z.number().min(-90).max(90).optional(),
        longitude: z.number().min(-180).max(180).optional(),
        placeName: z.string().min(1).max(80).optional(),
        days: z.number().int().min(1).max(16),
        timezone: z.string().default("Asia/Shanghai"),
      })
      .refine(
        (value) =>
          (typeof value.latitude === "number" && typeof value.longitude === "number") ||
          Boolean(value.placeName?.trim()),
        { message: "需要坐标或目的地名称" },
      ),
  )
  .handler(async ({ data }) => {
    const endpoint = process.env.OPEN_METEO_MCP_URL?.trim() || DEFAULT_MCP_ENDPOINT;
    const location = await resolveCoordinates(endpoint, data);
    const result = await callMcpTool(endpoint, 11, "openmeteo_get_forecast", {
      latitude: location.latitude,
      longitude: location.longitude,
      timezone: data.timezone,
      forecast_days: data.days,
      temperature_unit: "celsius",
      wind_speed_unit: "kmh",
      daily_variables: [
        "weather_code",
        "temperature_2m_max",
        "temperature_2m_min",
        "precipitation_probability_max",
        "wind_speed_10m_max",
        "sunrise",
        "sunset",
      ],
    });

    return {
      source: "Open-Meteo MCP",
      endpoint,
      location,
      days: normalizeDaily((result.structuredContent ?? {}) as ForecastPayload),
    };
  });

export type WeatherResult = Awaited<ReturnType<typeof getOpenMeteoForecast>>;
