import type { Place } from "@/lib/planner";

export type Destination = {
  id: string;
  name: string;
  region: string;
  eyebrow: string;
  summary: string;
  bestFor: string;
  weatherLocation?: { latitude: number; longitude: number };
  cover: string;
  places: Place[];
};

export const destinations: Destination[] = [
  {
    id: "huangshan",
    name: "黄山",
    region: "安徽 · 徽州",
    eyebrow: "奇峰与古村",
    summary: "把黄山主景区、宏村和屯溪周边按体力与天气拆开，避免把登山和古村硬塞在同一天。",
    bestFor: "想看云海、奇峰和徽州古村的人",
    weatherLocation: { latitude: 29.71139, longitude: 118.3125 },
    cover: "/scenes/inspirations/huangshan.svg",
    places: [
      { id: "huangshan-peak", name: "黄山风景区", area: "汤口", indoor: false, duration: 480, summary: "迎客松、光明顶与西海大峡谷，适合单独保留一整天。", source: "https://zh.wikipedia.org/wiki/黄山" },
      { id: "hongcun", name: "宏村", area: "黟县", indoor: false, duration: 210, summary: "月沼、南湖与徽派古建，清晨和傍晚更适合慢逛。", source: "https://zh.wikipedia.org/wiki/宏村" },
      { id: "xidi", name: "西递", area: "黟县", indoor: false, duration: 180, summary: "与宏村相邻的古村，巷弄和牌坊更适合安静游览。", source: "https://zh.wikipedia.org/wiki/西递村" },
      { id: "tunxi", name: "屯溪老街", area: "屯溪", indoor: false, duration: 120, summary: "适合抵达或返程日，边吃徽菜边看老街夜景。", source: "https://zh.wikipedia.org/wiki/屯溪老街" },
      { id: "anhui-museum", name: "安徽中国徽州文化博物馆", area: "屯溪", indoor: true, duration: 120, summary: "雨天首选，用一馆时间补足徽州村落、宗族和营商背景。", source: "https://www.ahm.cn/" },
      { id: "xixinan", name: "西溪南古村落", area: "徽州区", indoor: false, duration: 150, summary: "枫杨林和溪岸步道适合半日轻游，节奏比宏村更舒缓。", source: "https://zh.wikipedia.org/wiki/西溪南村" },
    ],
  },
  {
    id: "jiangnan",
    name: "江南水乡",
    region: "杭州 · 绍兴 · 乌镇",
    eyebrow: "湖山与古镇",
    summary: "以杭州为起点，把湖景、园林和水乡按交通时间分段，避免每天在城市之间来回折返。",
    bestFor: "喜欢慢游、园林、水系古镇与在地饮食的人",
    weatherLocation: { latitude: 30.2741, longitude: 120.1551 },
    cover: "/scenes/inspirations/jiangnan.svg",
    places: [
      { id: "west-lake", name: "西湖", area: "杭州", indoor: false, duration: 300, summary: "先走北山街和孤山，傍晚再接苏堤，避开正午客流高峰。", source: "https://zh.wikipedia.org/wiki/西湖" },
      { id: "lingyin", name: "灵隐寺与飞来峰", area: "杭州", indoor: false, duration: 210, summary: "山林与寺院片区，雨天也有可行走空间，建议早到。", source: "https://zh.wikipedia.org/wiki/灵隐寺" },
      { id: "suzhou-museum", name: "苏州博物馆", area: "苏州", indoor: true, duration: 150, summary: "适合天气不稳定时安排，建筑与馆藏本身就是景观。", source: "https://www.szmuseum.com/" },
      { id: "humble-garden", name: "拙政园", area: "苏州", indoor: false, duration: 150, summary: "园林经典片区，建议与苏州博物馆同一天顺路游览。", source: "https://zh.wikipedia.org/wiki/拙政园" },
      { id: "wuzhen", name: "乌镇西栅", area: "嘉兴", indoor: false, duration: 420, summary: "留到下午进入，夜景和清晨是水乡最好的两个时段。", source: "https://zh.wikipedia.org/wiki/乌镇" },
      { id: "shaoxing-old-town", name: "绍兴古城", area: "绍兴", indoor: false, duration: 210, summary: "沈园、鲁迅故里与仓桥直街可以组合成一个半日片区。", source: "https://zh.wikipedia.org/wiki/绍兴市" },
    ],
  },
  {
    id: "guilin",
    name: "桂林与阳朔",
    region: "广西 · 漓江",
    eyebrow: "山水与竹筏",
    summary: "先安排桂林市区短停，再把完整时间留给漓江与阳朔精华，减少反复转场。",
    bestFor: "想看喀斯特山水、竹筏和田园风光的人",
    weatherLocation: { latitude: 25.2736, longitude: 110.29 },
    cover: "/scenes/inspirations/guilin.svg",
    places: [
      { id: "elephant-trunk", name: "象鼻山", area: "桂林市区", indoor: false, duration: 90, summary: "适合抵达日短游，沿江看城市地标，不需要占用整天。", source: "https://zh.wikipedia.org/wiki/象鼻山" },
      { id: "two-rivers", name: "两江四湖", area: "桂林市区", indoor: false, duration: 180, summary: "夜游更能看到灯光和水系层次，适合抵达后的第一晚。", source: "https://zh.wikipedia.org/wiki/两江四湖" },
      { id: "li-river", name: "漓江竹筏", area: "杨堤 · 兴坪", indoor: false, duration: 240, summary: "核心山水段，天气能见度好时优先级最高。", source: "https://zh.wikipedia.org/wiki/漓江" },
      { id: "xingping", name: "兴坪古镇", area: "阳朔", indoor: false, duration: 150, summary: "与漓江游船衔接，适合傍晚沿江散步和拍二十元背景。", source: "https://zh.wikipedia.org/wiki/兴坪镇" },
      { id: "silver-cave", name: "银子岩", area: "荔浦", indoor: true, duration: 120, summary: "雨天或高温日的室内备选，溶洞景观稳定。", source: "https://zh.wikipedia.org/wiki/银子岩" },
      { id: "shili-gallery", name: "十里画廊", area: "阳朔", indoor: false, duration: 210, summary: "骑行或包车都合适，适合安排在天气稳定的半天。", source: "https://zh.wikipedia.org/wiki/十里画廊" },
    ],
  },
];

export function getDestination(id: string) {
  return destinations.find((destination) => destination.id === id) ?? destinations[0];
}


