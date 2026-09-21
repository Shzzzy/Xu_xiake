import { createFileRoute } from "@tanstack/react-router";
import { encodeGuidebookEvent, streamGuidebookPages } from "@/lib/guidebook-stream.server";
import { tripPlanSchema } from "@/lib/trip-plan-schema";

// 预览请求体的轻量上限：先于 JSON 解析拦截超大体，和 16 天上限共同约束付费调用面。
const GUIDEBOOK_PREVIEW_MAX_BODY_BYTES = 2_000_000;

const NDJSON_HEADERS = {
  "content-type": "application/x-ndjson; charset=utf-8",
  "cache-control": "no-store",
  // 反向代理下也必须逐块下发，否则逐页进度会变成一次性到达。
  "x-accel-buffering": "no",
};

/**
 * 路书逐页流式预览接口。
 *
 * 只渲染 HTML（不起无头浏览器），PDF 仍然由 `exportGuidebook` 在用户点击时才生成。
 */
export const Route = createFileRoute("/api/guidebook-preview")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const contentLength = Number(request.headers.get("content-length"));
        if (Number.isFinite(contentLength) && contentLength > GUIDEBOOK_PREVIEW_MAX_BODY_BYTES) {
          return new Response(
            encodeGuidebookEvent({ type: "error", message: "行程数据过大，无法预览路书。" }),
            { status: 413, headers: NDJSON_HEADERS },
          );
        }

        let plan;
        try {
          plan = tripPlanSchema.parse(await request.json());
        } catch {
          return new Response(
            encodeGuidebookEvent({ type: "error", message: "行程数据不合法，无法预览路书。" }),
            { status: 400, headers: NDJSON_HEADERS },
          );
        }

        const runId = request.headers.get("x-guidebook-run-id")?.trim() || "legacy";
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            try {
              for await (const event of streamGuidebookPages(plan, { signal: request.signal, runId })) {
                controller.enqueue(encoder.encode(encodeGuidebookEvent(event)));
              }
            } catch (error) {
              controller.enqueue(
                encoder.encode(
                  encodeGuidebookEvent({
                    type: "error",
                    message: error instanceof Error ? error.message : "路书预览生成失败。",
                  }),
                ),
              );
            } finally {
              controller.close();
            }
          },
        });

        return new Response(stream, { headers: NDJSON_HEADERS });
      },
    },
  },
});
