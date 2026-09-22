import { createHash } from "node:crypto";
import {
  acceptGuidebookPage,
  createGuidebookPageAcceptanceState,
  type GuidebookPageAcceptanceState,
} from "./guidebook-page-protocol.ts";
import { prepareGuidebookDayNarrative } from "./guidebook-narrative.server.ts";
import { enrichGuidebookPlanWithMaps, fitMapZoom } from "./guidebook-map.server.ts";
import { buildStaticMapUrl } from "./amap.server.ts";
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
  /** 测试注入使用：验证生成器自身的 index/checksum 顺序守卫。 */
  pageChecksumFactory?: (html: string, index: number, id: string) => string;
};

export type GuidebookPreviewState = GuidebookPageAcceptanceState;

export function createPreviewState(runId: string): GuidebookPreviewState {
  return createGuidebookPageAcceptanceState(runId);
}

export function acceptPage(state: GuidebookPreviewState, event: GuidebookPageEvent): boolean {
  return acceptGuidebookPage(state, event);
}

function pageChecksum(html: string): string {
  return createHash("sha256").update(html).digest("hex");
}

export function encodeGuidebookEvent(event: GuidebookStreamEvent): string {
  return `${JSON.stringify(event)}\n`;
}

const DAY_PAGE_ID = /^day-(\d+)-(map|summary)$/;

/** 用当天节点坐标构建高德静态地图；坐标缺失或非法时返回 undefined。 */
function buildDayStaticMapUrl(day: TripDay): string | undefined {
  // 只用当天景点坐标：通用节点（午餐、酒店入住）可能被解析到其他城市。
  const points = day.nodes
    .filter((node) => node.type === "attraction" || node.type === "night-activity")
    .flatMap((node) => (node.coordinates ? [node.coordinates] : []))
    .filter(
      ([longitude, latitude]) =>
        Number.isFinite(longitude) &&
        Number.isFinite(latitude) &&
        Math.abs(longitude) <= 180 &&
        Math.abs(latitude) <= 90,
    );
  if (points.length === 0) return undefined;
  try {
    return buildStaticMapUrl({
      outbound: points.map(([longitude, latitude]) => ({ longitude, latitude })),
      zoom: fitMapZoom(points),
    });
  } catch {
    return undefined;
  }
}

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
  const streamPageState = createPreviewState(runId);
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
    // enrichment 没给出当天地图时，用当天节点坐标现场补一张，避免当天页面没有地图。
    map: prepareGuidebookImage(day.mapUrl ?? buildDayStaticMapUrl(day), "map", options),
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
          signal: options.signal,
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
          // 当日地图取不到时（占位 SVG）退到全程路线图，避免用户看到"地图暂不可用"。
          const dayMap = await images.map;
          // 占位图意味着当天地图没取到：清空后由当天点位示意图兜底，
          // 不能用全程路线图冒充，否则地图和当天行程对不上。
          const usableMap = dayMap && !dayMap.startsWith("data:image/svg+xml") ? dayMap : undefined;
          const preparedDay = {
            ...day,
            mapUrl: usableMap,
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
    const pageEvent: GuidebookPageEvent = {
      type: "page",
      runId,
      index,
      id: spec.id,
      label: spec.label,
      checksum: options.pageChecksumFactory?.(html, index, spec.id) ?? pageChecksum(html),
      html,
    };
    if (!acceptPage(streamPageState, pageEvent)) {
      throw new Error(`路书页面协议校验失败：${spec.id}`);
    }
    yield emit(pageEvent);
  }
}