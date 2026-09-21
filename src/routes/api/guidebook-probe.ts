import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/guidebook-probe")({
  server: {
    handlers: {
      GET: async () => {
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          async start(controller) {
            for (const label of ["a", "b", "c"]) {
              controller.enqueue(encoder.encode(`${Date.now()} ${label}\n`));
              await new Promise((resolve) => setTimeout(resolve, 700));
            }
            controller.close();
          },
        });
        return new Response(stream, {
          headers: { "content-type": "text/plain; charset=utf-8", "x-accel-buffering": "no" },
        });
      },
    },
  },
});
