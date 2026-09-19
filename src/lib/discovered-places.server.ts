import { getSql } from "./db.ts";
import type { DiscoveredPlaceRecord } from "./place-discovery.ts";
import { createDiscoveredPlacesRepository } from "./discovered-places.repository.ts";

async function repository() {
  const sql = await getSql();
  return createDiscoveredPlacesRepository({
    query: (text, params) => sql.query(text, params),
  });
}

export async function listVerifiedDiscoveredPlaces(): Promise<DiscoveredPlaceRecord[]> {
  return (await repository()).listVerifiedDiscoveredPlaces();
}

export async function findDiscoveredPlaceByName(
  normalizedName: string,
): Promise<DiscoveredPlaceRecord[]> {
  return (await repository()).findDiscoveredPlaceByName(normalizedName);
}

export async function upsertDiscoveredPlace(
  record: DiscoveredPlaceRecord,
): Promise<DiscoveredPlaceRecord> {
  return (await repository()).upsertDiscoveredPlace(record);
}

export async function touchDiscoveredPlaceUsage(
  canonicalKey: string,
): Promise<DiscoveredPlaceRecord | null> {
  return (await repository()).touchDiscoveredPlaceUsage(canonicalKey);
}
