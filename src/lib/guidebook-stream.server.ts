import { enrichTripPlanNarrative } from "./guidebook-narrative.server.ts";
import {
  guidebookPageSpecs,
  renderGuidebookHead,
} from "./guidebook-html.server.ts";
import {
  prepareGuidebookImage,
  type GuidebookImageFetchOptions,
} from "./guidebook-pdf.server.ts";
import type { TripPlan } from "./travel-plan.ts";

/**
 * 逐页流式事件：先给出总页数与文档头，再一页一页推送页面 HTML。
 *
 * 每页的 HTML 都可以单独插入预览 iframe；图片已被内联成 data URL，
 * 所以浏览器永远不会看到高德 key。
 */
export type GuidebookStreamEvent =
  | { type: "meta"; total: number; title: string; head: string }
  | { type: "page"; index: number; id: string; label: string; html: string }
  | { type: "error"; message: string };

export function encodeGuidebookEvent(event: GuidebookStreamEvent): string {
  return `${JSON.stringify(event)}\n`;
}

const DAY_PAGE_ID = /^day-(\d+)-(map|summary)$/;

/**
 * 按页产出路书：所有远程图片（高德静态地图、二维码）一开始就并行预取，
 * 纯文字页立刻送出，需要图片的页各自等自己那一张，因此既逐页推进又不比
 * 一次性渲染慢。
 */
export async function* streamGuidebookPages(
  plan: TripPlan,
  options: GuidebookImageFetchOptions = {},
): AsyncGenerator<GuidebookStreamEvent> {
  const specs = guidebookPageSpecs(plan);
  yield {
    type: "meta",
    total: specs.length,
    title: plan.meta.title,
    head: renderGuidebookHead(plan, { forPreview: true }),
  };

  // 每日旅行信息与分析由 DeepSeek 写，但只依赖最终排程；封面、概览、路线、预算
  // 不等它，先渲染出去，文案到了再补进当天页面。
  const narrativePromise = enrichTripPlanNarrative(plan);
  let narrativeApplied = false;

  const routeMap = prepareGuidebookImage(plan.route.staticMapUrl, "map", options);
  const dayImages = plan.days.map((day) => ({
    map: prepareGuidebookImage(day.mapUrl, "map", options),
    qrCode: prepareGuidebookImage(day.qrCodeUrl, "qr", options),
  }));

  let prepared = plan;
  for (let index = 0; index < specs.length; index += 1) {
    const spec = specs[index];
    if (!spec) continue;

    // 路线页与回望页都要画全程地图。
    if (spec.id === "route" || spec.id === "closing") {
      prepared = {
        ...prepared,
        route: { ...prepared.route, staticMapUrl: await routeMap },
      };
    }

    const dayMatch = DAY_PAGE_ID.exec(spec.id);
    if (dayMatch && !narrativeApplied) {
      narrativeApplied = true;
      const enriched = await narrativePromise;
      prepared = {
        ...prepared,
        days: prepared.days.map((day, index) => {
          const enrichedDay = enriched.days[index];
          return enrichedDay
            ? {
                ...day,
                purpose: enrichedDay.purpose,
                highlights: enrichedDay.highlights,
                cautions: enrichedDay.cautions,
              }
            : day;
        }),
      };
    }
    if (dayMatch?.[2] === "map") {
      const dayIndex = Number(dayMatch[1]) - 1;
      const day = prepared.days[dayIndex];
      const images = dayImages[dayIndex];
      if (day && images) {
        const preparedDay = {
          ...day,
          mapUrl: await images.map,
          qrCodeUrl: await images.qrCode,
        };
        prepared = {
          ...prepared,
          days: prepared.days.map((item, itemIndex) =>
            itemIndex === dayIndex ? preparedDay : item,
          ),
        };
      }
    }

    yield { type: "page", index, id: spec.id, label: spec.label, html: spec.render(prepared) };
  }
}
