import type { AmapClient, AmapCoordinate, AmapGeocode } from "./amap.server.ts";

function hashName(value: string): number {
  let hash = 0;
  for (const character of value) {
    hash = (hash * 31 + character.codePointAt(0)!) % 1_000_003;
  }
  return hash;
}

function fixtureCoordinate(name: string): AmapCoordinate {
  if (name.includes("上海")) return [121.4737, 31.2304];
  const hash = hashName(name);
  return [100 + (hash % 3_000) / 100, 20 + (hash % 1_500) / 100];
}

function fixtureGeocode(name: string): AmapGeocode {
  const hash = hashName(name);
  return {
    formattedAddress: name,
    province: name.includes("上海") ? "上海市" : `测试省${hash % 32}`,
    city: name,
    district: "",
    adcode: "",
    location: fixtureCoordinate(name),
  };
}

/** 浏览器 E2E 专用的高德替身，仅由 AMAP_E2E_FIXTURE=1 显式开启。 */
export function createAmapE2eFixtureClient(): AmapClient {
  return {
    async searchPoi() {
      return [];
    },
    async fetchStaticMap() {
      return new Uint8Array();
    },
    async route(input) {
      return {
        mode: input.mode,
        origin: input.origin,
        destination: input.destination,
        distanceMeters: 680_000,
        durationSeconds: 30_600,
        path: [input.origin, input.destination],
        steps: [],
      };
    },
    async geocode(input) {
      return [fixtureGeocode(input.address.trim())];
    },
    async weather() {
      return [];
    },
  };
}
