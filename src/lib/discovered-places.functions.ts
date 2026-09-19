import { createServerFn } from "@tanstack/react-start";
import type { SceneArt } from "@/data/scene-catalog";
import type { InspirationDestination } from "@/lib/inspiration";
import { sceneDataUrl } from "@/lib/scene-art";
import { listVerifiedDiscoveredPlaces } from "./discovered-places.server";

export const getSharedInspirations = createServerFn({ method: "GET" }).handler(
  async (): Promise<InspirationDestination[]> => {
    const places = await listVerifiedDiscoveredPlaces();

    return places
      .filter((place) => place.status === "verified")
      .map((place) => ({
        id: place.id,
        name: place.canonicalName,
        region: place.region,
        summary: place.summary,
        scene: sceneDataUrl({
          id: place.id,
          name: place.canonicalName,
          art: place.art as SceneArt,
          accent: place.accent,
          visualSeed: place.visualSeed,
        }),
        accent: place.accent,
        tags: place.tags,
        art: place.art as SceneArt,
        discovered: true,
        sourceCount: place.sourceSnapshot.length,
      }));
  },
);