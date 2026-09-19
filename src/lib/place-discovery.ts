import { hashString } from "./scene-art.ts";

export type PlacePublishStatus = "verified" | "candidate" | "rejected";

export function sanitizePlaceText(value: string, maxLength = 80): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, maxLength);
}

export function normalizePlaceName(value: string): string {
  return sanitizePlaceText(value)
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/(特别行政区|维吾尔自治区|壮族自治区|回族自治区|自治区|省|市|县|区)$/g, "");
}

export function canonicalPlaceKey(name: string, region: string): string {
  return `${normalizePlaceName(name)}|${normalizePlaceName(region)}`;
}

export function classifyPlaceConfidence(
  confidence: number,
  ambiguous: boolean,
): PlacePublishStatus {
  if (ambiguous || !Number.isFinite(confidence) || confidence < 0.55) {
    return "rejected";
  }
  return confidence >= 0.85 ? "verified" : "candidate";
}

export type DiscoveredPlaceSource = {
  title: string;
  url: string;
  content: string;
};

export type PlacePersistenceRepository = {
  findDiscoveredPlaceByName(normalizedName: string): Promise<DiscoveredPlaceRecord[]>;
  upsertDiscoveredPlace(record: DiscoveredPlaceRecord): Promise<DiscoveredPlaceRecord>;
  touchDiscoveredPlaceUsage?(canonicalKey: string): Promise<DiscoveredPlaceRecord | null>;
};

export type DiscoveredPlaceRecord = {
  id: string;
  canonicalKey: string;
  canonicalName: string;
  normalizedName: string;
  region: string;
  country: string;
  placeType: string;
  summary: string;
  tags: string[];
  sourceSnapshot: DiscoveredPlaceSource[];
  confidence: number;
  status: "verified" | "candidate";
  art: string;
  accent: string;
  visualSeed: number;
  routeContext: string[];
  usageCount: number;
  updatedAt: string;
  lastVerifiedAt: string;
};

export type BuildDiscoveredPlaceRecordInput = {
  canonicalName: string;
  region: string;
  country: string;
  placeType: string;
  summary: string;
  tags: string[];
  sourceSnapshot: DiscoveredPlaceSource[];
  confidence: number;
  status: "verified" | "candidate";
  art: string;
  accent: string;
  visualSeed: number;
  routeContext?: string[];
  usageCount?: number;
  updatedAt?: string;
  lastVerifiedAt?: string;
};

export function buildDiscoveredPlaceRecord(
  input: BuildDiscoveredPlaceRecordInput,
): DiscoveredPlaceRecord {
  const canonicalKey = canonicalPlaceKey(input.canonicalName, input.region);
  const now = new Date().toISOString();
  return {
    id: `dyn-${hashString(canonicalKey)}`,
    canonicalKey,
    canonicalName: input.canonicalName,
    normalizedName: normalizePlaceName(input.canonicalName),
    region: input.region,
    country: input.country,
    placeType: input.placeType,
    summary: input.summary,
    tags: input.tags,
    sourceSnapshot: input.sourceSnapshot,
    confidence: input.confidence,
    status: input.status,
    art: input.art,
    accent: input.accent,
    visualSeed: input.visualSeed,
    // Origin, waypoints, and destination are free-form user input. They may be
    // used in-memory for verification, but shared rows must contain only the
    // verified public place itself.
    routeContext: [],
    usageCount: input.usageCount ?? 0,
    updatedAt: input.updatedAt ?? now,
    lastVerifiedAt: input.lastVerifiedAt ?? input.updatedAt ?? now,
  };
}

function readRequiredString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new TypeError(`Expected discovered place column "${key}" to be a string`);
  }
  return value;
}

function readRequiredNumber(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(parsed)) {
    throw new TypeError(`Expected discovered place column "${key}" to be numeric`);
  }
  return parsed;
}

function readRequiredDate(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === "string" && value.trim() && !Number.isNaN(Date.parse(value))) {
    return value;
  }
  throw new TypeError(`Expected discovered place column "${key}" to be a date`);
}

function readJsonArray(row: Record<string, unknown>, key: string): unknown[] {
  const value = row[key];
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(parsed)) {
    throw new TypeError(`Expected discovered place column "${key}" to be a JSON array`);
  }
  return parsed;
}

function readStringArray(row: Record<string, unknown>, key: string): string[] {
  return readJsonArray(row, key).map((value) => {
    if (typeof value !== "string") {
      throw new TypeError(`Expected discovered place column "${key}" to contain strings`);
    }
    return value;
  });
}

function readSourceSnapshot(row: Record<string, unknown>): DiscoveredPlaceSource[] {
  return readJsonArray(row, "source_snapshot").map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError('Expected discovered place column "source_snapshot" to contain objects');
    }
    const source = value as Record<string, unknown>;
    return {
      title: readRequiredString(source, "title"),
      url: readRequiredString(source, "url"),
      content: readRequiredString(source, "content"),
    };
  });
}

export function mapDiscoveredPlaceRow(row: Record<string, unknown>): DiscoveredPlaceRecord {
  const status = readRequiredString(row, "status");
  if (status !== "verified" && status !== "candidate") {
    throw new TypeError('Expected discovered place column "status" to be verified or candidate');
  }

  return {
    id: readRequiredString(row, "id"),
    canonicalKey: readRequiredString(row, "canonical_key"),
    canonicalName: readRequiredString(row, "canonical_name"),
    normalizedName: readRequiredString(row, "normalized_name"),
    region: readRequiredString(row, "region"),
    country: readRequiredString(row, "country"),
    placeType: readRequiredString(row, "place_type"),
    summary: readRequiredString(row, "summary"),
    tags: readStringArray(row, "tags"),
    sourceSnapshot: readSourceSnapshot(row),
    confidence: readRequiredNumber(row, "confidence"),
    status,
    art: readRequiredString(row, "art"),
    accent: readRequiredString(row, "accent"),
    visualSeed: readRequiredNumber(row, "visual_seed"),
    routeContext: [],
    usageCount: readRequiredNumber(row, "usage_count"),
    updatedAt: readRequiredDate(row, "updated_at"),
    lastVerifiedAt: readRequiredDate(row, "last_verified_at"),
  };
}
