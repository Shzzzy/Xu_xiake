import { z } from "zod";

export type PlannerDayCopy = {
  day: number;
  purpose: string;
  highlights: string[];
  cautions: string[];
  history: { title: string; background: string; source: string }[];
};

const plannerDayCopySchema = z.object({
  day: z.number().int().positive(),
  purpose: z.string().trim().min(1),
  highlights: z.array(z.string()),
  cautions: z.array(z.string()),
  history: z.array(
    z.object({
      title: z.string().trim().min(1),
      background: z.string().trim().min(1),
      source: z.string().nullable().optional(),
    }),
  ),
});

function stripJsonFence(content: string): string {
  return content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

function cleanStrings(values: string[]): string[] {
  return values.flatMap((value) => {
    const cleaned = value.trim();
    return cleaned ? [cleaned] : [];
  });
}

export function parsePlannerDayCopy(content: string): PlannerDayCopy {
  const parsed = plannerDayCopySchema.parse(JSON.parse(stripJsonFence(content)));
  const highlights = cleanStrings(parsed.highlights);
  const cautions = cleanStrings(parsed.cautions);

  if (highlights.length < 3) {
    throw new Error("每日文案至少需要 3 条核心重点");
  }
  if (cautions.length < 2) {
    throw new Error("每日文案至少需要 2 条注意事项");
  }

  const history = parsed.history.flatMap((entry) => {
    const source = entry.source?.trim();
    if (!source) return [];
    return [{ title: entry.title, background: entry.background, source }];
  });

  return {
    day: parsed.day,
    purpose: parsed.purpose,
    highlights: highlights.slice(0, 5),
    cautions: cautions.slice(0, 5),
    history,
  };
}

export function buildDayCopyInstruction(input: {
  day: number;
  theme: string;
  nodes: { name: string; type: string }[];
}): string {
  const nodeLines =
    input.nodes.length > 0
      ? input.nodes.map((node) => `- ${node.name}（${node.type}）`).join("\n")
      : "- 无";

  return [
    `请为已冻结的第 ${input.day} 天排程撰写每日文案。`,
    `当日主题：${input.theme}`,
    "仅依据给定节点写作，不得新增、删改或猜测行程事实：",
    nodeLines,
    "",
    "只输出严格 JSON，不要 Markdown，也不要输出 JSON 之外的解释。结构如下：",
    JSON.stringify(
      {
        day: input.day,
        purpose: "今日目的",
        highlights: ["核心重点 1：说明", "核心重点 2：说明", "核心重点 3：说明"],
        cautions: ["注意事项 1", "注意事项 2"],
        history: [{ title: "标题", background: "历史背景", source: "可核验来源" }],
      },
      null,
      2,
    ),
    "",
    "写作要求：",
    "1. 今日目的：用一段完整文字说明当天想达成的体验。",
    "2. 核心重点：写 3 到 5 条，每条使用「标题：说明」格式。",
    "3. 注意事项：写 2 到 5 条，按重要性排序，优先说明安全、天气、拥堵和体力问题。",
    "4. 历史背景：只写可核验内容，并必须在每条 history 的 source 中写明来源；给不出来源就不要写该条，不要编造。",
    `5. day 必须为 ${input.day}。`,
  ].join("\n");
}
