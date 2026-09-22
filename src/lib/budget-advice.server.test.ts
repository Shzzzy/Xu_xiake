import test from "node:test";
import assert from "node:assert/strict";
import {
  buildBudgetAdvice,
  buildBudgetAdviceMessages,
  parseBudgetAdvice,
  parseBudgetAdviceNote,
  requestBudgetAdvice,
  type BudgetAdviceInput,
} from "./budget-advice.server.ts";

const input: BudgetAdviceInput = {
  origin: "上海",
  destination: "北京",
  region: "北京",
  days: 2,
  travelers: { adults: 3, children: 0 },
  transportPreference: "高铁 / 飞机",
  roundTrip: true,
  returnMode: "fast",
  routeLegs: [
    {
      from: "上海",
      to: "北京",
      transport: "flight",
      kind: "outbound",
      style: "direct",
      unitCost: 1_000,
      costBasis: "per-person",
    },
    {
      from: "北京",
      to: "上海",
      transport: "flight",
      kind: "return",
      style: "direct",
      unitCost: 1_000,
      costBasis: "per-person",
    },
  ],
  pace: "balanced",
  interests: ["人文建筑"],
  costs: {
    lodgingPerRoomPerNight: 600,
    foodPerPersonPerDay: 150,
    adultTicketPrice: 200,
    childTicketPrice: 100,
    uncertainty: "medium",
  },
};

test("本地确定性基线按房间数、人数和全部去返程成本计算", () => {
  const advice = buildBudgetAdvice({
    ...input,
    days: 5,
    travelers: { adults: 3, children: 1 },
    routeLegs: [
      {
        from: "上海",
        to: "北京",
        transport: "flight",
        kind: "outbound",
        style: "direct",
        unitCost: 1_200,
        costBasis: "per-person",
      },
      {
        from: "北京",
        to: "上海",
        transport: "drive",
        kind: "return",
        style: "direct",
        unitCost: 1_500,
        costBasis: "vehicle",
      },
    ],
    costs: {
      lodgingPerRoomPerNight: 500,
      foodPerPersonPerDay: 100,
      adultTicketPrice: 200,
      childTicketPrice: 100,
      uncertainty: "low",
    },
  });

  assert.deepEqual(advice.categories, {
    transport: 6_940,
    lodging: 8_812,
    food: 2_203,
    tickets: 771,
    other: 1_874,
  });
  assert.equal(advice.baseTotal, 18_700);
  assert.equal(advice.bufferRate, 0.1);
  assert.equal(advice.recommendedTotal, 20_600);
  assert.equal(advice.total, advice.recommendedTotal);
  assert.equal(
    Object.values(advice.categories).reduce((sum, amount) => sum + amount, 0),
    advice.total,
  );
});

test("高不确定性预算按 20% 缓冲并取整到百元", () => {
  const advice = buildBudgetAdvice({
    ...input,
    days: 2,
    roundTrip: false,
    routeLegs: [
      {
        ...input.routeLegs[0]!,
        totalCost: 2_000,
      },
    ],
    costs: {
      lodgingPerRoomPerNight: 500,
      foodPerPersonPerDay: 100,
      adultTicketPrice: 0,
      childTicketPrice: 0,
      uncertainty: "high",
    },
  });

  assert.equal(advice.bufferRate, 0.2);
  assert.equal(advice.recommendedTotal % 100, 0);
  assert.equal(advice.recommendedTotal, 5_500);
});

test("缺少显式价格时按里程估算单人交通成本", () => {
  const advice = buildBudgetAdvice({
    ...input,
    days: 2,
    roundTrip: false,
    routeLegs: [
      {
        ...input.routeLegs[0]!,
        distanceKm: 1_000,
        unitCost: undefined,
        totalCost: undefined,
      },
    ],
    costs: {
      lodgingPerRoomPerNight: 600,
      foodPerPersonPerDay: 150,
      adultTicketPrice: 200,
      childTicketPrice: 100,
      uncertainty: "low",
    },
  });

  // 1,000 km 飞机的单人参考价为 550 元，3 位成人共 1,650 元。
  assert.equal(advice.baseTotal, 5_445);
  assert.equal(advice.recommendedTotal, 6_000);
});

test("DeepSeek 只能整理 note，不能修改本地金额", async () => {
  const baseline = buildBudgetAdvice(input);
  const fetchImpl = (async () =>
    Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              note: "含全部往返交通、3 间房和景点门票",
              total: 1,
              recommendedTotal: 1,
              categories: {
                transport: 1,
                lodging: 1,
                food: 1,
                tickets: 1,
                other: 1,
              },
            }),
          },
        },
      ],
    })) as typeof fetch;

  const advice = await requestBudgetAdvice(input, {
    apiKey: "test-key",
    amapKey: " ",
    fetchImpl,
  });

  assert.equal(advice.total, baseline.total);
  assert.deepEqual(advice.categories, baseline.categories);
  assert.equal(advice.baseTotal, baseline.baseTotal);
  assert.equal(advice.recommendedTotal, baseline.recommendedTotal);
  assert.equal(advice.note, "含全部往返交通、3 间房和景点门票");
});

test("缺少 DeepSeek 时仍返回本地确定性预算", async () => {
  const advice = await requestBudgetAdvice(input, { apiKey: " ", amapKey: " " });
  assert.deepEqual(advice, buildBudgetAdvice(input));
});

const inputWithoutTransportPrices: BudgetAdviceInput = {
  ...input,
  routeLegs: [
    {
      ...input.routeLegs[0]!,
      distanceKm: undefined,
      unitCost: undefined,
      totalCost: undefined,
    },
    {
      ...input.routeLegs[1]!,
      transport: "drive",
      distanceKm: undefined,
      unitCost: undefined,
      totalCost: undefined,
    },
  ],
};

test("有高德 Key 时补齐真实里程、自动标记计费基准并驱动本地交通价", async () => {
  const amapCalls: URL[] = [];
  const amapFetchImpl = (async (requestInput: RequestInfo | URL) => {
    const url = new URL(String(requestInput));
    amapCalls.push(url);
    const address = url.searchParams.get("address");
    const location = address === "上海" ? "121.4737,31.2304" : "116.4074,39.9042";
    return Response.json({
      status: "1",
      geocodes: [{ location }],
    });
  }) as typeof fetch;

  let deepSeekBody: { messages: { role: string; content: string }[] } | undefined;
  const deepSeekFetchImpl = (async (requestInput: RequestInfo | URL, init?: RequestInit) => {
    deepSeekBody = JSON.parse(String(init?.body)) as typeof deepSeekBody;
    return Response.json({
      choices: [{ message: { content: JSON.stringify({ note: "已按高德里程估算" }) } }],
    });
  }) as typeof fetch;

  const advice = await requestBudgetAdvice(inputWithoutTransportPrices, {
    apiKey: "deepseek-test",
    amapKey: "amap-test",
    amapFetchImpl,
    fetchImpl: deepSeekFetchImpl,
  });

  assert.equal(amapCalls.length, 2);
  const userMessage = JSON.parse(deepSeekBody!.messages[1]!.content) as {
    input: {
      routeLegs: { distanceKm?: number; costBasis?: string }[];
    };
  };
  const outbound = userMessage.input.routeLegs[0]!;
  const returnLeg = userMessage.input.routeLegs[1]!;
  assert.ok((outbound.distanceKm ?? 0) > 1_060 && (outbound.distanceKm ?? 0) < 1_075);
  assert.ok((returnLeg.distanceKm ?? 0) > 1_060 && (returnLeg.distanceKm ?? 0) < 1_075);
  assert.equal(outbound.costBasis, "per-person");
  assert.equal(returnLeg.costBasis, "vehicle");
  assert.equal(advice.baseTotal, 6_980);
  assert.equal(advice.recommendedTotal, 8_100);
});

test("没有高德 Key 时不发网络请求，本地公式仍可用", async () => {
  let amapCalled = false;
  const amapFetchImpl = (async () => {
    amapCalled = true;
    throw new Error("不应调用高德网络");
  }) as typeof fetch;

  const advice = await requestBudgetAdvice(inputWithoutTransportPrices, {
    apiKey: " ",
    amapKey: " ",
    amapFetchImpl,
  });

  assert.equal(amapCalled, false);
  assert.deepEqual(advice, buildBudgetAdvice(inputWithoutTransportPrices));
});

test("高德定位失败时保守降级，不阻塞本地预算", async () => {
  const amapFetchImpl = (async () => {
    throw new Error("高德网络失败");
  }) as typeof fetch;

  const advice = await requestBudgetAdvice(inputWithoutTransportPrices, {
    apiKey: " ",
    amapKey: "amap-test",
    amapFetchImpl,
  });

  assert.deepEqual(advice, buildBudgetAdvice(inputWithoutTransportPrices));
});

test("预算解释必须是合法 JSON note", () => {
  assert.equal(parseBudgetAdviceNote('```json\n{"note":"交通按往返计算"}\n```'), "交通按往返计算");
  assert.throws(() => parseBudgetAdviceNote(JSON.stringify({ note: "" })));
});

test("预算建议解析合法 JSON 并保留分类", () => {
  const advice = parseBudgetAdvice(
    JSON.stringify({
      total: 8600,
      categories: { transport: 2600, lodging: 2800, food: 1400, tickets: 1200, other: 600 },
      note: "含黄山门票与山上住宿",
    }),
  );
  assert.equal(advice.total, 8600);
  assert.equal(advice.categories.other, 600);
});

test("预算建议拒绝缺少分类或负数", () => {
  assert.throws(() => parseBudgetAdvice(JSON.stringify({ total: 100, categories: {} })));
  assert.throws(() =>
    parseBudgetAdvice(
      JSON.stringify({
        total: -1,
        categories: { transport: 1, lodging: 1, food: 1, tickets: 1, other: 1 },
      }),
    ),
  );
});

test("预算建议提示词只要求整理本地基线说明", () => {
  const messages = buildBudgetAdviceMessages(input) as {
    role: string;
    content: string;
  }[];
  const serialized = JSON.stringify(messages);
  const userMessage = JSON.parse(messages[1]!.content) as {
    input: {
      roundTrip: boolean;
      routeLegs: { kind: string }[];
      hotelRooms: number;
      tripNights: number;
    };
  };

  assert.match(serialized, /本地确定性公式/);
  assert.match(serialized, /只能整理/);
  assert.match(serialized, /不得修改/);
  assert.match(serialized, /每位同行者一间房/);
  assert.match(serialized, /上海/);
  assert.match(serialized, /北京/);
  assert.equal(userMessage.input.roundTrip, true);
  assert.equal(userMessage.input.routeLegs.at(-1)?.kind, "return");
  assert.equal(userMessage.input.hotelRooms, 3);
  assert.equal(userMessage.input.tripNights, 1);
  assert.match(serialized, /flight/);
});

test("预算建议请求使用 DeepSeek 说明合同且金额来自本地基线", async () => {
  const requests: { input: RequestInfo | URL; init?: RequestInit }[] = [];
  const fetchImpl = (async (requestInput: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ input: requestInput, init });
    return Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              total: 8600,
              categories: {
                transport: 2600,
                lodging: 2800,
                food: 1400,
                tickets: 1200,
                other: 600,
              },
              note: "含黄山门票与山上住宿",
            }),
          },
        },
      ],
    });
  }) as typeof fetch;

  const advice = await requestBudgetAdvice(input, {
    apiKey: "test-key",
    amapKey: " ",
    fetchImpl,
  });
  const body = JSON.parse(String(requests[0]?.init?.body)) as {
    messages: unknown[];
    response_format: { type: string };
    max_tokens: number;
    temperature: number;
  };

  assert.equal(advice.categories.lodging, buildBudgetAdvice(input).categories.lodging);
  assert.equal(advice.note, "含黄山门票与山上住宿");
  assert.equal(body.response_format.type, "json_object");
  assert.equal(body.max_tokens, 800);
  assert.equal(body.temperature, 0.2);
  assert.deepEqual(body.messages, buildBudgetAdviceMessages(input));
});

test("预算建议把总额校正为分类合计", () => {
  const advice = parseBudgetAdvice(
    JSON.stringify({
      total: 4200,
      categories: {
        transport: 6600,
        lodging: 900,
        food: 900,
        tickets: 300,
        other: 650,
      },
      note: "往返高铁、2 晚住宿与门票餐饮",
    }),
  );

  assert.equal(advice.total, 9350);
});

test("预算建议忽略模型 JSON 外层包装字段", () => {
  const advice = parseBudgetAdvice(
    JSON.stringify({
      type: "json_object",
      total: 10800,
      categories: {
        transport: 7200,
        lodging: 800,
        food: 1500,
        tickets: 800,
        other: 500,
      },
      note: "含往返交通与 1 晚住宿",
    }),
  );

  assert.equal(advice.total, 10800);
  assert.equal(advice.categories.transport, 7200);
});
