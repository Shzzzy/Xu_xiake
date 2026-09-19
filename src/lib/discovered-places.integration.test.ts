import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { buildDiscoveredPlaceRecord, canonicalPlaceKey } from "./place-discovery.ts";
import { createDiscoveredPlacesRepository } from "./discovered-places.repository.ts";

test(
  "PGlite migration supports insert, upsert, verified listing, exact lookup, and usage touch",
  { timeout: 30_000 },
  async () => {
    const migration = await readFile(
      fileURLToPath(new URL("../../migrations/0002_discovered_places.sql", import.meta.url)),
      "utf8",
    );
    const pg = new PGlite();
    await pg.waitReady;
    await pg.exec(migration);

    const repository = createDiscoveredPlacesRepository({
      query: async <T>(text: string, params: unknown[] = []) =>
        (await pg.query<T>(text, params)).rows,
    });

    try {
      const verified = buildDiscoveredPlaceRecord({
        canonicalName: "龙岩",
        region: "福建",
        country: "中国",
        placeType: "城市",
        summary: "福建西部城市",
        tags: ["客家文化"],
        sourceSnapshot: [
          {
            title: "龙岩",
            url: "https://example.com/longyan",
            content: "福建省龙岩市",
          },
        ],
        confidence: 0.96,
        status: "verified",
        art: "mountain",
        accent: "#45695d",
        visualSeed: 5_001,
        routeContext: ["私密出发地", "私密途经点"],
        updatedAt: "2024-01-01T00:00:00.000Z",
        lastVerifiedAt: "2024-01-01T00:00:00.000Z",
      });
      const candidate = buildDiscoveredPlaceRecord({
        canonicalName: "龙岩",
        region: "浙江",
        country: "中国",
        placeType: "山岳",
        summary: "同名候选地点",
        tags: [],
        sourceSnapshot: [],
        confidence: 0.7,
        status: "candidate",
        art: "mountain",
        accent: "#45695d",
        visualSeed: 5_002,
        routeContext: ["另一段私密路线"],
        updatedAt: "2024-02-01T00:00:00.000Z",
        lastVerifiedAt: "2024-02-01T00:00:00.000Z",
      });

      await repository.upsertDiscoveredPlace(verified);
      await repository.upsertDiscoveredPlace(candidate);

      const verifiedOnly = await repository.listVerifiedDiscoveredPlaces();
      assert.deepEqual(
        verifiedOnly.map((place) => place.region),
        ["福建"],
      );

      const sameName = await repository.findDiscoveredPlaceByName("龙岩");
      assert.deepEqual(
        new Set(sameName.map((place) => place.canonicalKey)),
        new Set([canonicalPlaceKey("龙岩", "福建"), canonicalPlaceKey("龙岩", "浙江")]),
      );
      assert.equal(sameName.find((place) => place.region === "浙江")?.status, "candidate");

      const rawRows = await pg.query<{ canonical_key: string; route_context: unknown }>(
        "select canonical_key, route_context from discovered_places order by canonical_key",
      );
      assert.ok(rawRows.rows.every((row) => JSON.stringify(row.route_context) === "[]"));

      const updatedVerified = await repository.upsertDiscoveredPlace({
        ...verified,
        summary: "补全后的摘要",
        visualSeed: 9_999,
      });
      assert.equal(updatedVerified.visualSeed, 5_001);
      assert.equal(updatedVerified.summary, "补全后的摘要");
      assert.equal(updatedVerified.usageCount, 1);
      assert.notEqual(updatedVerified.lastVerifiedAt, "2024-01-01T00:00:00.000Z");

      const beforeTouch = sameName.find((place) => place.region === "浙江");
      assert.ok(beforeTouch);
      const touchedCandidate = await repository.touchDiscoveredPlaceUsage(beforeTouch.canonicalKey);
      assert.ok(touchedCandidate);
      assert.equal(touchedCandidate.usageCount, beforeTouch.usageCount + 1);
      assert.equal(touchedCandidate.lastVerifiedAt, beforeTouch.lastVerifiedAt);
    } finally {
      await pg.close();
    }
  },
);
