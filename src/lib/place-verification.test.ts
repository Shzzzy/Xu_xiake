import test from "node:test";
import assert from "node:assert/strict";
import {
  parsePlaceVerificationBatch,
  parsePlaceVerificationJson,
  type PlaceVerificationGroup,
} from "./place-verification.ts";

const groups: PlaceVerificationGroup[] = [
  {
    inputName: "龙岩",
    normalizedName: "龙岩",
    routeContext: ["厦门", "黄山"],
    results: [{ title: "龙岩", url: "https://example.com/longyan", content: "福建省龙岩市" }],
  },
  {
    inputName: "龙泉",
    normalizedName: "龙泉",
    routeContext: ["杭州"],
    results: [
      { title: "浙江龙泉", url: "https://example.com/longquan-zj", content: "浙江省龙泉市" },
      { title: "云南龙泉", url: "https://example.com/longquan-yn", content: "云南省龙泉县" },
    ],
  },
];

function place(overrides: Record<string, unknown> = {}) {
  return {
    inputName: "龙岩",
    canonicalName: "龙岩",
    region: "福建",
    country: "中国",
    placeType: "城市",
    summary: "福建西部城市",
    tags: ["客家文化"],
    aliases: ["龙岩市"],
    confidence: 0.96,
    ambiguous: false,
    reasons: ["来源明确"],
    sourceUrls: ["https://example.com/longyan"],
    ...overrides,
  };
}

test("parses a raw array and a places object", () => {
  const fromArray = parsePlaceVerificationJson(JSON.stringify([place()]), groups);
  const fromObject = parsePlaceVerificationJson(JSON.stringify({ places: [place()] }), groups);

  assert.equal(fromArray[0]?.region, "福建");
  assert.deepEqual(fromObject, fromArray);
});

test("sanitizes text fields and JSON code fences", () => {
  const body = JSON.stringify({
    places: [
      place({
        canonicalName: "  龙岩\u0000市 ",
        summary: " 福建西部城市\u0007 ",
        tags: [" 客家文化\u0000 "],
        aliases: [" 龙岩市 "],
        reasons: [" 来源明确\u0001 "],
      }),
    ],
  });
  const parsed = parsePlaceVerificationJson(`\`\`\`json\n${body}\n\`\`\``, groups);

  assert.equal(parsed[0]?.inputName, "龙岩");
  assert.equal(parsed[0]?.canonicalName, "龙岩市");
  assert.equal(parsed[0]?.summary, "福建西部城市");
  assert.deepEqual(parsed[0]?.tags, ["客家文化"]);
  assert.deepEqual(parsed[0]?.aliases, ["龙岩市"]);
  assert.deepEqual(parsed[0]?.reasons, ["来源明确"]);
});

test("rejects sources outside the matching group whitelist", () => {
  assert.throws(
    () =>
      parsePlaceVerificationJson(
        JSON.stringify([
          place({
            region: "新疆",
            summary: "错误",
            sourceUrls: ["https://example.com/other"],
          }),
        ]),
        groups,
      ),
    /来源不在允许列表/,
  );
});

test("does not accept another group's allowlisted source", () => {
  assert.throws(
    () =>
      parsePlaceVerificationJson(
        JSON.stringify([
          place({
            inputName: "龙泉",
            region: "浙江",
            sourceUrls: ["https://example.com/longyan"],
          }),
        ]),
        groups,
      ),
    /来源不在允许列表/,
  );
});

test("rejects an input name without a matching group", () => {
  assert.throws(
    () => parsePlaceVerificationJson(JSON.stringify([place({ inputName: "未知地点" })]), groups),
    /未找到匹配的输入地点/,
  );
});

test("rejects confidence outside zero to one", () => {
  assert.throws(
    () => parsePlaceVerificationJson(JSON.stringify([place({ confidence: 1.01 })]), groups),
    /Too big|too_big/i,
  );
});

test("keeps valid entries when another batch entry is outside its source allowlist", () => {
  const batch = parsePlaceVerificationBatch(
    JSON.stringify({
      places: [
        place(),
        place({
          inputName: "龙泉",
          canonicalName: "龙泉",
          region: "浙江",
          sourceUrls: ["https://example.com/outside-allowlist"],
        }),
      ],
    }),
    groups,
  );

  assert.deepEqual(
    batch.results.map((result) => result.inputName),
    ["龙岩"],
  );
  assert.deepEqual(
    batch.failures.map((failure) => failure.inputName),
    ["龙泉"],
  );
  assert.match(batch.failures[0]?.message ?? "", /来源不在允许列表/);
  assert.throws(
    () =>
      parsePlaceVerificationJson(
        JSON.stringify({
          places: [
            place(),
            place({
              inputName: "龙泉",
              canonicalName: "龙泉",
              region: "浙江",
              sourceUrls: ["https://example.com/outside-allowlist"],
            }),
          ],
        }),
        groups,
      ),
    /来源不在允许列表/,
  );
});
