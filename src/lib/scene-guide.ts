import type { SceneArt, SceneDestination } from "../data/scene-catalog.ts";

export type SceneExperience = {
  label: string;
  duration: string;
};

export type SceneGuide = {
  highlights: string[];
  experiences: SceneExperience[];
  recommendedTime: string;
  timing: string;
};

const experiencesByArt: Record<SceneArt, string[]> = {
  palace: ["宫殿建筑巡游", "历史讲解", "光影拍照"],
  wall: ["城墙漫步", "登高观景", "晨昏摄影"],
  garden: ["园林漫步", "亭台观景", "曲水拍照"],
  architecture: ["建筑巡礼", "街区漫步", "人文摄影"],
  city: ["城市漫步", "夜景摄影", "在地美食"],
  coast: ["海岸漫步", "观日出日落", "亲水活动"],
  "ancient-city": ["古城街巷", "夜游灯光", "地方小吃"],
  grotto: ["石窟参观", "壁画讲解", "文化摄影"],
  grassland: ["草原漫游", "骑马体验", "日落露营"],
  desert: ["沙丘观景", "驼队体验", "星空摄影"],
  volcano: ["火山地貌", "温泉体验", "森林徒步"],
  lake: ["环湖观景", "游船泛舟", "日出摄影"],
  snow: ["雪山观景", "轻徒步", "雪景摄影"],
  watertown: ["水巷漫步", "摇橹船", "夜景摄影"],
  mountain: ["登山观景", "云海日出", "栈道徒步"],
  temple: ["寺观参观", "祈福体验", "晨钟暮鼓"],
  island: ["环岛漫游", "海边休闲", "日落摄影"],
  tulou: ["土楼参观", "客家文化", "田园漫步"],
  canyon: ["峡谷栈道", "观瀑徒步", "地质摄影"],
  forest: ["森林徒步", "溪谷漫游", "自然摄影"],
  peakforest: ["峰林观景", "索道或栈道", "日出摄影"],
  danxia: ["彩色地貌", "日落观景", "地质摄影"],
  karst: ["漓江游船", "喀斯特摄影", "田园骑行"],
  terrace: ["梯田观景", "日出云海", "村寨漫步"],
  bay: ["海湾漫步", "水上活动", "日落摄影"],
  waterfall: ["瀑布观景", "亲水徒步", "丰水期摄影"],
  history: ["历史文化", "讲解导览", "展陈参观"],
  saltlake: ["盐湖倒影", "小火车", "日出日落"],
  harbour: ["海滨漫步", "城市夜景", "游船体验"],
};

const timeByArt: Record<SceneArt, string> = {
  palace: "4–6 小时", wall: "4–6 小时", garden: "半天–1 天", architecture: "3–5 小时",
  city: "半天–1 天", coast: "半天–1 天", "ancient-city": "半天–1 天", grotto: "3–5 小时",
  grassland: "1–2 天", desert: "半天–1 天", volcano: "1 天", lake: "1 天", snow: "1–2 天",
  watertown: "半天–1 天", mountain: "1–2 天", temple: "3–5 小时", island: "1 天", tulou: "半天–1 天",
  canyon: "1 天", forest: "1 天", peakforest: "1–2 天", danxia: "1 天", karst: "1 天", terrace: "1 天",
  bay: "半天–1 天", waterfall: "半天–1 天", history: "3–5 小时", saltlake: "半天–1 天", harbour: "3–5 小时",
};

const timingByArt: Record<SceneArt, string> = {
  palace: "建议上午入场，预留讲解和主线建筑巡游时间。",
  wall: "尽量避开正午，早晨或傍晚登城体验更舒适。",
  garden: "慢看亭台与借景，傍晚光线最适合拍照。",
  architecture: "沿街区步行串联，边走边看建筑细节。",
  city: "下午抵达，连同夜景和晚餐安排半天。",
  coast: "清晨或傍晚最舒适，留意潮汐与天气。",
  "ancient-city": "下午入场，接一段夜景会更完整。",
  grotto: "建议提前了解背景，并预留讲解时间。",
  grassland: "建议留宿一晚，日落和清晨景色最好。",
  desert: "避开正午高温，傍晚到夜间体验最佳。",
  volcano: "预留完整一天，注意海拔和天气变化。",
  lake: "上午看水面，傍晚留给光影和游船。",
  snow: "关注天气与开放信息，上午出发更稳妥。",
  watertown: "傍晚进入，连看暮色与水乡夜景。",
  mountain: "建议早出发，给登山和休息留足余量。",
  temple: "上午参观更安静，着装保持简洁得体。",
  island: "天气好时预留一整天，傍晚看日落。",
  tulou: "与周边村落串联，预留半天到一天。",
  canyon: "穿舒适鞋，给栈道和观光车留时间。",
  forest: "上午走入森林，午后安排溪谷休息。",
  peakforest: "早到避开排队，天气晴朗时视野最好。",
  danxia: "日落前进入，斜光下色彩层次更明显。",
  karst: "上午游江，下午接田园或古镇慢游。",
  terrace: "清晨看云雾，日落看梯田层次。",
  bay: "下午到傍晚最舒适，注意防晒。",
  waterfall: "丰水期观感最好，步道湿滑要慢行。",
  history: "先看主线展览，再用讲解补齐背景。",
  saltlake: "无风时段倒影最好，傍晚光线更柔和。",
  harbour: "下午抵达，连看海景与城市夜景。",
};

const experienceDurationRules: { test: RegExp; duration: string }[] = [
  { test: /云海日出|日出|日落|夜景|星空/, duration: "1–2 小时" },
  { test: /登山观景/, duration: "4–6 小时" },
  { test: /环岛|环湖|草原漫游|骑马|露营/, duration: "2–4 小时" },
  { test: /徒步|栈道|登高|登城/, duration: "2–4 小时" },
  { test: /游船|游江|竹筏|泛舟/, duration: "1.5–3 小时" },
  { test: /温泉/, duration: "1.5–2.5 小时" },
  { test: /骑行/, duration: "2–4 小时" },
  { test: /巡游|巡礼|讲解|参观|展陈/, duration: "1–2 小时" },
  { test: /漫步|街巷|街区|古城|园林|亭台|村寨/, duration: "1.5–2.5 小时" },
  { test: /美食|小吃|在地/, duration: "1–2 小时" },
  { test: /祈福|晨钟暮鼓/, duration: "0.5–1 小时" },
  { test: /摄影|拍照/, duration: "45–90 分钟" },
];

export function estimateExperienceDuration(label: string) {
  return (
    experienceDurationRules.find((rule) => rule.test.test(label))?.duration ??
    "1–2 小时"
  );
}

export function buildSceneGuide(destination: SceneDestination): SceneGuide {
  return {
    highlights: destination.tags.slice(0, 3),
    experiences: experiencesByArt[destination.art].map((label) => ({
      label,
      duration: estimateExperienceDuration(label),
    })),
    recommendedTime: timeByArt[destination.art],
    timing: timingByArt[destination.art],
  };
}
