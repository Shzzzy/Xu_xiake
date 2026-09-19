import { z } from "zod";
import { sanitizePlaceText } from "./place-discovery.ts";
import type { SearchResult } from "./live-planner.ts";

export type PlaceVerificationGroup = {
  inputName: string;
  normalizedName: string;
  routeContext: string[];
  results: SearchResult[];
};

export type VerifiedPlaceResult = {
  inputName: string;
  canonicalName: string;
  region: string;
  country: string;
  placeType: string;
  summary: string;
  tags: string[];
  aliases: string[];
  confidence: number;
  ambiguous: boolean;
  reasons: string[];
  sourceUrls: string[];
};

const requiredText = (maxLength = 80) =>
  z
    .string()
    .transform((value) => sanitizePlaceText(value, maxLength))
    .pipe(z.string().min(1));

const textList = z
  .array(z.string())
  .transform((values) => values.map((value) => sanitizePlaceText(value)).filter(Boolean));

const placeVerificationSchema = z.object({
  inputName: requiredText(),
  canonicalName: requiredText(),
  region: requiredText(),
  country: requiredText(),
  placeType: requiredText(),
  summary: requiredText(240),
  tags: textList,
  aliases: textList,
  confidence: z.number().min(0).max(1),
  ambiguous: z.boolean(),
  reasons: textList,
  sourceUrls: z.array(z.string().trim().url()),
});

const responseEnvelopeSchema = z.union([
  z.array(z.unknown()),
  z.object({ places: z.array(z.unknown()) }),
]);

function cleanJson(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

export type PlaceVerificationFailure = {
  inputName: string;
  message: string;
};

export type PlaceVerificationBatch = {
  results: VerifiedPlaceResult[];
  failures: PlaceVerificationFailure[];
};

function parsePlaceVerificationEntries(text: string): unknown[] {
  const payload = responseEnvelopeSchema.parse(JSON.parse(cleanJson(text)));
  return Array.isArray(payload) ? payload : payload.places;
}

function parsePlaceVerificationBatchInternal(
  text: string,
  groups: PlaceVerificationGroup[],
  requireEveryGroup: boolean,
): PlaceVerificationBatch {
  const entries = parsePlaceVerificationEntries(text);
  const groupsByName = new Map(
    groups.map((group) => [sanitizePlaceText(group.inputName), group] as const),
  );
  const resultsByInputName = new Map<string, VerifiedPlaceResult>();
  const failuresByInputName = new Map<string, PlaceVerificationFailure>();

  const addFailure = (inputName: string, message: string) => {
    const name = sanitizePlaceText(inputName) || "未知地点";
    if (failuresByInputName.has(name)) return;
    failuresByInputName.set(name, { inputName: name, message });
  };

  for (const entry of entries) {
    const rawInputName =
      entry &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      typeof (entry as Record<string, unknown>).inputName === "string"
        ? sanitizePlaceText(String((entry as Record<string, unknown>).inputName))
        : "";
    const parsed = placeVerificationSchema.safeParse(entry);
    if (!parsed.success) {
      addFailure(
        rawInputName,
        `地点「${rawInputName || "未知地点"}」校核结果无效：${parsed.error.issues[0]?.message ?? "格式错误"}`,
      );
      continue;
    }

    const place = parsed.data;
    const group = groupsByName.get(place.inputName);
    if (!group) {
      addFailure(place.inputName, `地点「${place.inputName}」未找到匹配的输入地点`);
      continue;
    }

    const allowedUrls = new Set(group.results.map((result) => result.url.trim()));
    const disallowedUrl = place.sourceUrls.find((sourceUrl) => !allowedUrls.has(sourceUrl));
    if (disallowedUrl) {
      addFailure(place.inputName, `地点「${place.inputName}」的来源不在允许列表中`);
      continue;
    }

    if (resultsByInputName.has(place.inputName)) {
      addFailure(place.inputName, `地点「${place.inputName}」返回了重复校核结果`);
      continue;
    }

    resultsByInputName.set(place.inputName, place);
  }

  if (requireEveryGroup) {
    for (const group of groups) {
      const inputName = sanitizePlaceText(group.inputName);
      if (!resultsByInputName.has(inputName) && !failuresByInputName.has(inputName)) {
        addFailure(inputName, `地点「${inputName}」校核未返回结果`);
      }
    }
  }

  const results = groups.flatMap((group) => {
    const result = resultsByInputName.get(sanitizePlaceText(group.inputName));
    return result ? [result] : [];
  });
  const failures = [...failuresByInputName.values()];

  return { results, failures };
}

/**
 * Strict compatibility path: any invalid, unmatched, or out-of-allowlist entry
 * rejects the whole batch.
 */
export function parsePlaceVerificationJson(
  text: string,
  groups: PlaceVerificationGroup[],
): VerifiedPlaceResult[] {
  const batch = parsePlaceVerificationBatchInternal(text, groups, false);
  if (batch.failures.length > 0) {
    throw new Error(batch.failures[0]?.message ?? "地点校核结果无效");
  }
  return batch.results;
}

/**
 * Tolerant batch path: valid entries are returned even when another entry is
 * malformed, ambiguous, missing, or references a URL outside its own group.
 */
export function parsePlaceVerificationBatch(
  text: string,
  groups: PlaceVerificationGroup[],
): PlaceVerificationBatch {
  return parsePlaceVerificationBatchInternal(text, groups, true);
}
