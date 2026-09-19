import { sceneDestinations, type SceneDestination } from "../data/scene-catalog.ts";

export type InspirationDestination = SceneDestination & {
  discovered?: boolean;
  sourceCount?: number;
};

export type InspirationCycle<T extends string = string> = {
  all: T[];
  remaining: T[];
  batch: T[];
};

export const inspirationDestinations: InspirationDestination[] = sceneDestinations;

export function mergeInspirationCatalog(
  staticItems: InspirationDestination[],
  dynamicItems: InspirationDestination[],
): InspirationDestination[] {
  const merged = [...staticItems];
  const ids = new Set(merged.map((destination) => destination.id));

  for (const destination of dynamicItems) {
    if (ids.has(destination.id)) continue;
    ids.add(destination.id);
    merged.push(destination);
  }

  return merged;
}

export function shuffle<T>(items: T[], rng: () => number = Math.random): T[] {
  const next = [...items];
  for (let index = next.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(rng() * (index + 1));
    [next[index], next[swapIndex]] = [next[swapIndex], next[index]];
  }
  return next;
}

export function createInspirationCycle<T extends string>(
  ids: T[],
  rng: () => number = Math.random,
): InspirationCycle<T> {
  return { all: [...ids], remaining: shuffle(ids, rng), batch: [] };
}

export function nextInspirationBatch<T extends string>(
  state: InspirationCycle<T>,
  size = 3,
  rng: () => number = Math.random,
): InspirationCycle<T> {
  const nextRemaining = [...state.remaining];

  if (nextRemaining.length < size) {
    const excluded = new Set([...nextRemaining, ...state.batch]);
    const refill = shuffle(
      state.all.filter((id) => !excluded.has(id)),
      rng,
    );
    nextRemaining.push(...refill);
  }

  if (nextRemaining.length < size) {
    const excluded = new Set([...nextRemaining, ...state.batch]);
    nextRemaining.push(...shuffle(state.all.filter((id) => !excluded.has(id)), rng));
  }

  const batch = nextRemaining.splice(0, Math.min(size, state.all.length));
  return { ...state, remaining: nextRemaining, batch };
}

export function normalizeRegionLabel(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/(壮族自治区|回族自治区|维吾尔自治区|特别行政区|自治区|省|市)/g, "")
    .replace(/[·—–_/]/g, "");
}

export function findInspirationsByRegion(
  query: string,
  items: InspirationDestination[] = inspirationDestinations,
) {
  const normalized = normalizeRegionLabel(query);
  if (!normalized) return [...items];
  if (normalized.length < 2) return [];

  return items.filter((destination) => {
    const region = normalizeRegionLabel(destination.region);
    return region === normalized || region.includes(normalized) || normalized.includes(region);
  });
}

export function findInspiration(
  idOrName: string,
  items: InspirationDestination[] = inspirationDestinations,
) {
  const value = idOrName.trim().toLowerCase();
  return items.find(
    (destination) =>
      destination.id === value || destination.name.toLowerCase() === value,
  );
}