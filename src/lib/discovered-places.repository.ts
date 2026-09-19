import {
  mapDiscoveredPlaceRow,
  type DiscoveredPlaceRecord,
  type PlacePersistenceRepository,
} from "./place-discovery.ts";

export type DiscoveredPlacesQuery = {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
};

export type DiscoveredPlacesRepository = PlacePersistenceRepository & {
  listVerifiedDiscoveredPlaces(): Promise<DiscoveredPlaceRecord[]>;
  findDiscoveredPlaceByName(normalizedName: string): Promise<DiscoveredPlaceRecord[]>;
  touchDiscoveredPlaceUsage(canonicalKey: string): Promise<DiscoveredPlaceRecord | null>;
  upsertDiscoveredPlace(record: DiscoveredPlaceRecord): Promise<DiscoveredPlaceRecord>;
};

export function createDiscoveredPlacesRepository(
  query: DiscoveredPlacesQuery,
): DiscoveredPlacesRepository {
  return {
    async listVerifiedDiscoveredPlaces() {
      const rows = await query.query(
        `select *
         from discovered_places
         where status = 'verified'
         order by updated_at desc, id asc`,
      );
      return rows.map(mapDiscoveredPlaceRow);
    },

    async findDiscoveredPlaceByName(normalizedName: string) {
      const rows = await query.query(
        `select *
         from discovered_places
         where normalized_name = $1
         order by updated_at desc, id asc`,
        [normalizedName],
      );
      return rows.map(mapDiscoveredPlaceRow);
    },

    async touchDiscoveredPlaceUsage(canonicalKey: string) {
      const rows = await query.query(
        `update discovered_places
         set usage_count = usage_count + 1,
             updated_at = now()
         where canonical_key = $1
         returning *`,
        [canonicalKey],
      );
      return rows[0] ? mapDiscoveredPlaceRow(rows[0]) : null;
    },

    async upsertDiscoveredPlace(record: DiscoveredPlaceRecord) {
      const rows = await query.query(
        `insert into discovered_places (
          id,
          canonical_key,
          canonical_name,
          normalized_name,
          region,
          country,
          place_type,
          summary,
          tags,
          source_snapshot,
          confidence,
          status,
          art,
          accent,
          visual_seed,
          route_context,
          usage_count,
          last_verified_at
        )
        values (
          $1, $2, $3, $4, $5, $6, $7, $8,
          $9::jsonb, $10::jsonb, $11, $12, $13, $14, $15,
          '[]'::jsonb, $16, $17
        )
        on conflict (canonical_key) do update set
          canonical_name = excluded.canonical_name,
          normalized_name = excluded.normalized_name,
          region = excluded.region,
          country = excluded.country,
          place_type = excluded.place_type,
          summary = excluded.summary,
          tags = excluded.tags,
          source_snapshot = excluded.source_snapshot,
          confidence = excluded.confidence,
          status = excluded.status,
          art = excluded.art,
          accent = excluded.accent,
          route_context = '[]'::jsonb,
          usage_count = discovered_places.usage_count + 1,
          updated_at = now(),
          last_verified_at = now()
        returning *`,
        [
          record.id,
          record.canonicalKey,
          record.canonicalName,
          record.normalizedName,
          record.region,
          record.country,
          record.placeType,
          record.summary,
          JSON.stringify(record.tags),
          JSON.stringify(record.sourceSnapshot),
          record.confidence,
          record.status,
          record.art,
          record.accent,
          record.visualSeed,
          record.usageCount,
          record.lastVerifiedAt,
        ],
      );

      const row = rows[0];
      if (!row) throw new Error("Failed to upsert discovered place");
      return mapDiscoveredPlaceRow(row);
    },
  };
}
