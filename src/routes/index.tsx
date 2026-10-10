import { createFileRoute } from "@tanstack/react-router";
import { PlannerPrototype } from "@/components/planner/PlannerPrototype";
import { absoluteUrl } from "@/lib/site-meta";

export const Route = createFileRoute("/")({
  // 首页是规划器的抓地入口，Title/Description 只描述已确认的产品能力。
  head: () => ({
    meta: [
      { title: "徐霞客旅行规划 · AI 行程规划与路书生成" },
      {
        name: "description",
        content:
          "输入出发地、目的地与最多 5 个途经点，生成 1–16 天详细逐日路书；17–365 天提供长线阶段规划。支持逐页路书预览，并可在浏览器打印或另存为 PDF。",
      },
    ],
    links: [{ rel: "canonical", href: absoluteUrl("/") }],
  }),
  component: Home,
});

function Home() {
  return <PlannerPrototype />;
}
