import { createHash } from "node:crypto";
import { prepareGuidebookDayNarrative } from "./guidebook-narrative.server.ts";
import { enrichGuidebookPlanWithMaps } from "./guidebook-map.server.ts";
import { guidebookPageSpecs, renderGuidebookHead } from "./guidebook-html.server.ts";
import { prepareGuidebookImage, type GuidebookImageFetchOptions } from "./guidebook-pdf.server.ts";
import type { TripDay, TripPlan } from "./travel-plan.ts";

/**
 * 逐页流式事件：先给出总页数与文档头，再一页一页推送页面 HTML。
 *
 * 每页的 HTML 都可以单独插入预览 iframe；图片已被内联成 data URL，
 * 所以浏览器永远不会看到高德 key。
 */
export type GuidebookPageEvent = {
  type: "page";
  runId: string;
  index: number;
  id: string;
  label: string;
  checksum: string;
  html: string;
};

export type GuidebookStreamEvent =
  | { type: "meta"; runId: string; total: number; title: string; head: string }
  | GuidebookPageEvent
  | { type: "error"; runId: string; message: string };

export type GuidebookStreamOptions = GuidebookImageFetchOptions & {
  runId?: string;
  onEvent?: (event: GuidebookStreamEvent) => void;
  loadDayNarrative?: (day: TripDay, dayIndex: number) => Promise<TripDay>;
  /** 测试和故障注入使用：指定自然日强制走经过校验的 fallback。 */
  failNarrativeDay?: number;
};

export type GuidebookPreviewState = {
  runId: string;
  seen: Set<string>;
};

export function createPreviewState(runId: string): GuidebookPreviewState {
  return { runId, seen: new Set() };
}

export function acceptPage(state: GuidebookPreviewState, event: GuidebookPageEvent): boolean {
  if (event.runId !== state.runId) return false;
  if (!event.checksum || state.seen.has(event.checksum)) return false;
  state.seen.add(event.checksum);
  return true;
}

function pageChecksum(html: string): string {
  return createHash("sha256").update(html).digest("hex");
}

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
  options: GuidebookStreamOptions = {},
): AsyncGenerator<GuidebookStreamEvent> {
  const runId = options.runId?.trim() || "legacy";
  const emit = (event: GuidebookStreamEvent): GuidebookStreamEvent => {
    options.onEvent?.(event);
    return event;
  };
  const specs = guidebookPageSpecs(plan);
  yield emit({
    type: "meta",
    runId,
    total: specs.length,
    title: plan.meta.title,
    head: renderGuidebookHead(plan, { forPreview: true }),
  });

  // 地图与路线在服务端补齐后再进入模板；缺失或失败时 enrichment 会返回原计划，
  // 现有 schematic / placeholder 仍然可用。图片内联逻辑只消费公开的无 Key URL。
  const mapPlan = await enrichGuidebookPlanWithMaps(plan, options);
  const routeMap = prepareGuidebookImage(mapPlan.route.staticMapUrl, "map", options);
  const dayImages = mapPlan.days.map((day) => ({
    map: prepareGuidebookImage(day.mapUrl, "map", options),
    qrCode: prepareGuidebookImage(day.qrCodeUrl, "qr", options),
  }));

  let prepared = mapPlan;
  const validatedDays = new Set<number>();

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
    if (dayMatch) {
      const dayIndex = Number(dayMatch[1]) - 1;

      // 与 PDF 共用同一个单日固化步骤；当天通过后才进入该日页面。
      if (!validatedDays.has(dayIndex)) {
        const narrativeDay = await prepareGuidebookDayNarrative(prepared, dayIndex, {
          loadDayNarrative: options.loadDayNarrative,
          failNarrativeDay: options.failNarrativeDay,
        });
        prepared = {
          ...prepared,
          days: prepared.days.map((day, itemIndex) =>
            itemIndex === dayIndex ? narrativeDay : day,
          ),
        };
        validatedDays.add(dayIndex);
      }

      if (dayMatch[2] === "map") {
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
    }
    const html = spec.render(prepared);
    yield emit({
      type: "page",
      runId,
      index,
      id: spec.id,
      label: spec.label,
      checksum: pageChecksum(html),
      html,
    });
  }
}