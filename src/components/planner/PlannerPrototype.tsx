import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import {
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  Check,
  Clock3,
  ChevronRight,
  CloudSun,
  Compass,
  Gauge,
  Landmark,
  MapPin,
  Mountain,
  Plus,
  Route,
  Save,
  Shuffle,
  Search,
  Timer,
  Waves,
  Minus,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { destinations, type Destination } from "@/data/planner-destinations";
import {
  createInspirationCycle,
  findInspiration,
  findInspirationsByRegion,
  nextInspirationBatch,
  type InspirationDestination,
} from "@/lib/inspiration";
import { designVariants, type DesignVariant, type DesignVariantMeta } from "@/lib/design-variants";
import {
  generateLiveItinerary,
  generateLongItinerary,
  type DiscoveryNotice,
} from "@/lib/live-planner.functions";
import type { GeneratedItinerary } from "@/lib/live-planner";
import { buildFallbackLongPlan, type LongPlan } from "@/lib/long-planner";
import {
  buildRoutePlan,
  removeWaypointAt,
  type RouteLegPreference,
  type RoutePlan,
  type ReturnMode,
  type TransportMode,
  type TravelStyle,
} from "@/lib/route-planner";
import { getOpenMeteoForecast } from "@/lib/planner.functions";
import {
  classifyWeather,
  splitPlacesAcrossDays,
  type Pace,
  type Place,
  type WeatherDay,
} from "@/lib/planner";
import { buildSceneGuide } from "@/lib/scene-guide";
import { cn } from "@/lib/utils";
import { ItineraryDay } from "./ItineraryDay";
import {
  InspirationCatalogProvider,
  useInspirationCatalog,
  useInspirationCatalogRefresh,
} from "./InspirationCatalogProvider";
import { TravelDatePicker } from "./TravelDatePicker";
import { WeatherStrip } from "./WeatherStrip";

type Screen = "landing" | "known" | "unknown" | "result";

type TripBrief = {
  origin: string;
  destinationId: string;
  destinationName: string;
  latitude?: number;
  longitude?: number;
  startDate: string;
  days: number;
  dailyHours: number;
  pace: Pace;
  interests: string[];
  waypoints: string[];
  roundTrip: boolean;
  returnMode: ReturnMode;
  defaultTravelStyle: TravelStyle;
  legPreferences: Record<string, RouteLegPreference>;
};

type UnknownAnswers = {
  mood: string;
  days: number;
  pace: Pace;
  interest: string;
};

const SAVED_KEY = "xuxiake-planner:prototype-saves";
const interestOptions = ["自然山水", "古村古镇", "人文建筑", "美食街区", "轻松步行", "摄影"];
const paceOptions: { id: Pace; title: string; description: string }[] = [
  { id: "relaxed", title: "轻松", description: "每天 2 个重点，留出午休" },
  { id: "balanced", title: "适中", description: "每天 2–3 个顺路片区" },
  { id: "deep", title: "充实", description: "每天 3–4 个景点，节奏紧凑" },
];
const dayPresets = [2, 3, 4, 5] as const;
const MIN_TRIP_DAYS = 1;
const MAX_TRIP_DAYS = 365;
const transportOptions: { id: TransportMode; label: string }[] = [
  { id: "economy", label: "经济推荐" },
  { id: "balanced", label: "均衡推荐" },
  { id: "speed", label: "效率推荐" },
  { id: "train", label: "高铁 / 火车" },
  { id: "flight", label: "飞机" },
  { id: "drive", label: "自驾" },
  { id: "bus", label: "长途汽车" },
  { id: "ship", label: "轮船" },
];

function dateInputValue(date: Date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function addDays(date: string, amount: number) {
  const next = new Date(`${date}T12:00:00`);
  next.setDate(next.getDate() + amount);
  return dateInputValue(next);
}

function dayOffset(from: string, to: string) {
  const start = new Date(`${from}T12:00:00`).getTime();
  const end = new Date(`${to}T12:00:00`).getTime();
  return Math.max(0, Math.round((end - start) / 86_400_000));
}

function formatDate(date: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(new Date(`${date}T12:00:00`));
}

type TimingItem = {
  label: string;
  detail: string;
};

function splitTimingLines(timing: string) {
  return timing
    .split(/[，。；]/)
    .flatMap((line) => line.split("或"))
    .map((line) => line.trim())
    .filter(Boolean);
}

function buildTimingDetail(label: string, destinationName: string) {
  const rules: { test: RegExp; detail: string }[] = [
    {
      test: /清晨|早晨|日出/,
      detail: `清晨客流较少，适合先完成 ${destinationName} 最核心的观景或游览，也为当天后续安排留出余量。`,
    },
    {
      test: /上午/,
      detail: `上午光线通常更舒适，优先安排 ${destinationName} 的核心游览，节奏更从容，也便于避开午后客流。`,
    },
    {
      test: /下午/,
      detail: "下午适合顺着游览动线连接相邻片区，减少来回折返，也能自然衔接到傍晚安排。",
    },
    {
      test: /傍晚|日落|夜景/,
      detail: `傍晚适合安排在 ${destinationName} 观景、散步或拍照，光线更有层次，也能自然连接到夜间活动。`,
    },
    {
      test: /古镇|古城|街巷|老街/,
      detail: "这一段时间适合慢走街巷，细看建筑、店铺和在地生活，不需要赶多个景点。",
    },
    {
      test: /游江|游船|水巷|环湖|水面/,
      detail:
        "水上项目受天气和能见度影响较大，建议优先确认开放情况，并把船上或沿岸观景连成一段完整体验。",
    },
    {
      test: /登山|徒步|栈道|登城/,
      detail: "登山和徒步段建议预留休息与排队时间，根据体力调整速度，不要与高强度项目连续安排。",
    },
    {
      test: /寺|祈福|晨钟暮鼓/,
      detail: "寺观参观建议放慢节奏，留意开放时间与着装要求，并预留一段安静参观和讲解时间。",
    },
    {
      test: /田园|村寨|村落|草原|森林/,
      detail:
        "自然片区适合用较完整的时段慢慢体验，沿途可结合步行、拍照和短暂休息，不建议频繁折返。",
    },
    {
      test: /预留|建议|避开|天气|开放/,
      detail: `这段安排主要用于控制 ${destinationName} 的游览节奏，实际执行时结合当天天气、开放信息和体力灵活调整。`,
    },
  ];

  return (
    rules.find((rule) => rule.test.test(label))?.detail ??
    `适合在这一时段安排“${label}”，并与前后行程保持顺路，避免为了单点来回穿行。`
  );
}

function buildTimingItems(timing: string, destinationName: string): TimingItem[] {
  return splitTimingLines(timing).map((label) => ({
    label,
    detail: buildTimingDetail(label, destinationName),
  }));
}

function createDefaultBrief(): TripBrief {
  return {
    origin: "北京",
    destinationId: "huangshan",
    destinationName: "黄山",
    latitude: 29.71139,
    longitude: 118.3125,
    startDate: dateInputValue(new Date()),
    days: 2,
    dailyHours: 6,
    pace: "balanced",
    interests: ["自然山水", "古村古镇"],
    waypoints: [],
    roundTrip: false,
    returnMode: "fast",
    defaultTravelStyle: "direct",
    legPreferences: {},
  };
}

function resolveTripDestination(
  brief: TripBrief,
  inspirationCatalog: InspirationDestination[],
): Destination {
  const preset = destinations.find((destination) => destination.id === brief.destinationId);
  if (preset) return preset;

  const inspiration =
    findInspiration(brief.destinationId, inspirationCatalog) ??
    findInspiration(brief.destinationName, inspirationCatalog);
  if (inspiration) {
    return {
      id: inspiration.id,
      name: inspiration.name,
      region: inspiration.region,
      eyebrow: inspiration.tags[0] ?? "灵感目的地",
      summary: inspiration.summary,
      bestFor: inspiration.tags.join(" · "),
      weatherLocation:
        typeof inspiration.latitude === "number" && typeof inspiration.longitude === "number"
          ? { latitude: inspiration.latitude, longitude: inspiration.longitude }
          : undefined,
      cover: inspiration.scene,
      places: [],
    };
  }

  const name = brief.destinationName.trim() || "自定义目的地";
  return {
    id: brief.destinationId || `custom:${name}`,
    name,
    region: "自由输入",
    eyebrow: "自定义目的地",
    summary: "系统会围绕这个目的地检索值得游玩、交通顺路的景区，再按你的时间安排每日行程。",
    bestFor: "等待实时搜索补充候选景区",
    weatherLocation:
      typeof brief.latitude === "number" && typeof brief.longitude === "number"
        ? { latitude: brief.latitude, longitude: brief.longitude }
        : undefined,
    cover: "/scenes/inspirations/huangshan.svg",
    places: [],
  };
}
function recommendDestination(answers: UnknownAnswers) {
  if (answers.mood === "water-town" || answers.interest === "古村古镇") return "jiangnan";
  if (answers.mood === "mountain" && answers.days >= 4) return "guilin";
  if (answers.mood === "mountain") return "huangshan";
  return answers.days >= 4 ? "guilin" : "huangshan";
}

function notifyDiscoveries(discoveries: DiscoveryNotice[]) {
  for (const discovery of discoveries) {
    if (discovery.status === "published") {
      toast.success(discovery.message);
    } else if (discovery.status === "candidate") {
      toast.info(discovery.message);
    } else {
      toast.warning(discovery.message);
    }
  }
}

function readSaved() {
  if (typeof window === "undefined") return [] as string[];
  try {
    const value = JSON.parse(localStorage.getItem(SAVED_KEY) ?? "[]") as unknown;
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function PlannerPrototypeContent() {
  const variant: DesignVariant = "scroll";
  const [screen, setScreen] = useState<Screen>("landing");
  const [brief, setBrief] = useState<TripBrief>(createDefaultBrief);
  const [savedIds, setSavedIds] = useState<string[]>([]);

  useEffect(() => {
    setSavedIds(readSaved());
  }, []);

  const currentVariant = designVariants[0];
  const saveId = `${brief.destinationId}-${brief.startDate}-${brief.days}`;
  const saved = savedIds.includes(saveId);

  const toggleSave = () => {
    const next = saved ? savedIds.filter((id) => id !== saveId) : [...savedIds, saveId];
    setSavedIds(next);
    localStorage.setItem(SAVED_KEY, JSON.stringify(next));
  };

  return (
    <div className={cn("planner-shell", `design-${variant}`)}>
      <PlannerHeader
        meta={currentVariant}
        saved={saved}
        showSaved={screen === "result"}
        onHome={() => setScreen("landing")}
        onSaved={toggleSave}
      />

      {screen === "landing" ? (
        <LandingScreen
          variant={variant}
          meta={currentVariant}
          onKnown={() => setScreen("known")}
          onUnknown={() => setScreen("unknown")}
        />
      ) : null}

      {screen === "known" ? (
        <KnownPlanScreen
          variant={variant}
          brief={brief}
          onBrief={setBrief}
          onBack={() => setScreen("landing")}
          onSubmit={() => setScreen("result")}
        />
      ) : null}

      {screen === "unknown" ? (
        <UnknownPlanScreen
          variant={variant}
          onBack={() => setScreen("landing")}
          onComplete={(nextBrief) => {
            setBrief(nextBrief);
            setScreen("result");
          }}
        />
      ) : null}

      {screen === "result" ? (
        <ItineraryScreen
          variant={variant}
          brief={brief}
          saved={saved}
          onBack={() => setScreen("known")}
          onEdit={() => setScreen(brief.destinationId ? "known" : "unknown")}
          onSave={toggleSave}
        />
      ) : null}
    </div>
  );
}

export function PlannerPrototype() {
  return (
    <InspirationCatalogProvider>
      <PlannerPrototypeContent />
    </InspirationCatalogProvider>
  );
}

function PlannerHeader({
  meta,
  saved,
  showSaved,
  onHome,
  onSaved,
}: {
  meta: DesignVariantMeta;
  saved: boolean;
  showSaved: boolean;
  onHome: () => void;
  onSaved: () => void;
}) {
  return (
    <header className="planner-header">
      <div className="planner-header-inner">
        <button type="button" onClick={onHome} className="group flex items-center gap-3 text-left">
          <span className="seal-mark">徐</span>
          <span>
            <span className="block font-serif text-base font-semibold tracking-wide text-[var(--v-ink)]">
              你好，徐霞客
            </span>
            <span className="hidden text-[10px] tracking-[0.22em] text-[var(--v-muted)] sm:block">
              {meta.subtitle}
            </span>
          </span>
        </button>

        {showSaved ? (
          <Button variant={saved ? "seal" : "outline"} size="sm" onClick={onSaved}>
            {saved ? <Check className="size-4" /> : <Save className="size-4" />}
            <span className="hidden sm:inline">{saved ? "已保存" : "保存"}</span>
          </Button>
        ) : null}
      </div>
    </header>
  );
}

function LandingScreen({
  variant,
  meta,
  onKnown,
  onUnknown,
}: {
  variant: DesignVariant;
  meta: DesignVariantMeta;
  onKnown: () => void;
  onUnknown: () => void;
}) {
  const inspirationCatalog = useInspirationCatalog();
  const featuredDestination =
    findInspiration("huangshan", inspirationCatalog) ?? inspirationCatalog[0];

  return (
    <main className="planner-landing">
      <section className="planner-landing-copy">
        <h1>
          先决定去哪，
          <br />
          再把时间排成路。
        </h1>
        <p className="planner-lead">
          告诉你已经选好的目的地，系统会围绕它筛选热门景区和顺路地点；如果没有目标，就用几个选择逐步收敛。
        </p>

        <div className="mt-8 grid gap-3 sm:grid-cols-2">
          <button type="button" className="choice-panel choice-panel-strong" onClick={onKnown}>
            <span className="flex size-11 items-center justify-center rounded-full border border-current/20 bg-white/10">
              <MapPin className="size-5" />
            </span>
            <span>
              <span className="choice-title">我知道去哪</span>
              <span className="choice-copy">输入目的地、日期与每天可用时间</span>
            </span>
            <ArrowRight className="ml-auto size-5 shrink-0" />
          </button>
          <button type="button" className="choice-panel" onClick={onUnknown}>
            <span className="flex size-11 items-center justify-center rounded-full border border-[var(--v-line)] bg-[var(--v-soft)]">
              <Compass className="size-5" />
            </span>
            <span>
              <span className="choice-title">帮我决定去哪</span>
              <span className="choice-copy">通过 4 个选择缩小范围</span>
            </span>
            <ArrowRight className="ml-auto size-5 shrink-0" />
          </button>
        </div>

        <div className="planner-proof">
          <span>
            <CloudSun className="size-4" /> 真实逐日天气
          </span>
          <span>
            <Route className="size-4" /> 按游玩时间编排
          </span>
          <span>
            <Search className="size-4" /> 景区来源可追溯
          </span>
        </div>
      </section>

      <section className="planner-landing-art">
        <img src="/scenes/huangshan.jpg" alt={`${featuredDestination?.name ?? "黄山"}云海与奇峰`} />
        <div className="planner-art-wash" />
        <div className="planner-art-note">
          <p>目的地只是起点</p>
          <span>真正重要的是：每天有多少时间、从哪里出发、天气允许你走多远。</span>
        </div>
        <div className="planner-coordinate">N 29°42′ · E 118°18′</div>
      </section>

      <section className="planner-variant-note">
        <div>
          <p className="font-medium text-[var(--v-ink)]">{meta.name}</p>
          <p className="mt-1 text-sm leading-6 text-[var(--v-muted)]">{meta.description}</p>
        </div>
      </section>
      {variant === "atlas" ? <div className="atlas-crosshair" aria-hidden="true" /> : null}
    </main>
  );
}

function KnownPlanScreen({
  variant,
  brief,
  onBrief,
  onBack,
  onSubmit,
}: {
  variant: DesignVariant;
  brief: TripBrief;
  onBrief: (brief: TripBrief) => void;
  onBack: () => void;
  onSubmit: () => void;
}) {
  const inspirationCatalog = useInspirationCatalog();
  const today = dateInputValue(new Date());
  const maxDate = addDays(today, Math.max(0, 16 - brief.days));
  const [customDaysOpen, setCustomDaysOpen] = useState(false);
  const [customDaysDraft, setCustomDaysDraft] = useState(String(brief.days));
  const [inspirationRegion, setInspirationRegion] = useState("");
  const inspirationMatches = useMemo(
    () => findInspirationsByRegion(inspirationRegion, inspirationCatalog),
    [inspirationCatalog, inspirationRegion],
  );
  const inspirationIds = useMemo(
    () => inspirationMatches.map((destination) => destination.id),
    [inspirationMatches],
  );
  const [inspirationCycle, setInspirationCycle] = useState(() => ({
    all: inspirationIds,
    remaining: inspirationIds.slice(3),
    batch: inspirationIds.slice(0, 3),
  }));

  useEffect(() => {
    setInspirationCycle(nextInspirationBatch(createInspirationCycle(inspirationIds), 3));
  }, [inspirationIds]);

  useEffect(() => {
    setCustomDaysDraft(String(brief.days));
  }, [brief.days]);

  const customDaysActive = customDaysOpen || !dayPresets.some((days) => days === brief.days);

  const applyDays = (nextDays: number) => {
    const nextMaxDate = addDays(today, Math.max(0, 16 - nextDays));
    const nextStartDate = brief.startDate > nextMaxDate ? nextMaxDate : brief.startDate;
    onBrief({ ...brief, days: nextDays, startDate: nextStartDate });
  };

  const commitCustomDays = () => {
    const parsed = Number.parseInt(customDaysDraft, 10);
    if (!Number.isFinite(parsed)) {
      setCustomDaysDraft(String(brief.days));
      return;
    }

    const nextDays = Math.min(MAX_TRIP_DAYS, Math.max(MIN_TRIP_DAYS, parsed));
    setCustomDaysDraft(String(nextDays));
    if (nextDays !== brief.days) applyDays(nextDays);
  };

  const routePlan = useMemo(() => {
    try {
      return buildRoutePlan({
        origin: brief.origin,
        destination: brief.destinationName,
        waypoints: brief.waypoints,
        roundTrip: brief.roundTrip,
        returnMode: brief.returnMode,
        defaultStyle: brief.defaultTravelStyle,
        legPreferences: brief.legPreferences,
      });
    } catch {
      return null;
    }
  }, [
    brief.defaultTravelStyle,
    brief.destinationName,
    brief.legPreferences,
    brief.origin,
    brief.returnMode,
    brief.roundTrip,
    brief.waypoints,
  ]);

  const inspirationBatch = inspirationCycle.batch
    .map((id) => inspirationCatalog.find((destination) => destination.id === id))
    .filter((destination): destination is InspirationDestination => Boolean(destination));

  const selectDestination = (destination: InspirationDestination) => {
    onBrief({
      ...brief,
      destinationId: destination.id,
      destinationName: destination.name,
      latitude: destination.latitude,
      longitude: destination.longitude,
    });
  };

  const updateDestinationName = (name: string) => {
    const matched = findInspiration(name, inspirationCatalog);
    onBrief({
      ...brief,
      destinationId: matched?.id ?? `custom:${name.trim()}`,
      destinationName: name,
      latitude: matched?.latitude,
      longitude: matched?.longitude,
    });
  };

  const toggleInterest = (interest: string) => {
    const selected = brief.interests.includes(interest);
    onBrief({
      ...brief,
      interests: selected
        ? brief.interests.filter((item) => item !== interest)
        : [...brief.interests, interest],
    });
  };

  return (
    <main className="planner-page planner-form-page">
      <button type="button" className="planner-back" onClick={onBack}>
        <ArrowLeft className="size-4" /> 返回入口
      </button>
      <div className="planner-section-heading">
        <Badge>已知目的地</Badge>
        <h1>告诉我这次要去哪里。</h1>
        <p>景点会围绕目的地展开，并根据你每天可用的时间决定推荐范围。</p>
      </div>

      <div className={cn("planner-form-grid", variant === "journal" && "journal-form-grid")}>
        <section className="planner-form-card">
          <label className="planner-field-label" htmlFor="destination-input">
            目的地
          </label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-[var(--v-subtle)]" />
            <input
              id="destination-input"
              value={brief.destinationName}
              onChange={(event) => {
                const value = event.target.value;
                updateDestinationName(value);
                if (!value.trim()) setInspirationRegion("");
              }}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Enter") {
                  event.preventDefault();
                  setInspirationRegion(event.currentTarget.value.trim());
                }
              }}
              enterKeyHint="search"
              placeholder="输入城市、景区、地区或省份"
              className="planner-input planner-input-with-icon"
            />
          </div>

          <div className="mt-5">
            <div className="flex items-end justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-[var(--v-ink)]">灵感景点</p>
                <p className="mt-1 text-xs leading-5 text-[var(--v-muted)]">
                  {inspirationRegion
                    ? `已筛选「${inspirationRegion}」· ${inspirationMatches.length} 个相关景点`
                    : "输入省份后回车筛选，点击卡片直接选中"}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setInspirationCycle((current) => nextInspirationBatch(current, 3))}
              >
                <Shuffle className="size-3.5" />
                换一批
              </Button>
            </div>

            {inspirationBatch.length > 0 ? (
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                {inspirationBatch.map((destination) => (
                  <button
                    key={destination.id}
                    type="button"
                    onClick={() => selectDestination(destination)}
                    className={cn(
                      "inspiration-tile",
                      brief.destinationId === destination.id && "inspiration-tile-active",
                    )}
                    aria-pressed={brief.destinationId === destination.id}
                  >
                    <img src={destination.scene} alt={`${destination.name}场景`} />
                    <span className="inspiration-tile-copy">
                      {destination.discovered ? (
                        <span className="inspiration-new-badge">新发现</span>
                      ) : null}
                      <small>{destination.region}</small>
                      <strong>{destination.name}</strong>
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="inspiration-empty">
                <Compass className="size-5" />
                <strong>没有找到「{inspirationRegion}」的灵感景点</strong>
                <span>试试输入完整省份名称，例如“福建省”或“广西壮族自治区”。</span>
              </div>
            )}
          </div>

          <div className="mt-6 grid gap-5 sm:grid-cols-2">
            <div>
              <span className="planner-field-label">出发日期</span>
              <TravelDatePicker
                value={brief.startDate}
                min={today}
                max={maxDate}
                onChange={(startDate) => onBrief({ ...brief, startDate })}
              />
            </div>
            <label>
              <span className="planner-field-label">旅行天数</span>
              <select
                value={customDaysActive ? "custom" : String(brief.days)}
                onChange={(event) => {
                  if (event.target.value === "custom") {
                    setCustomDaysOpen(true);
                    setCustomDaysDraft(String(brief.days));
                    return;
                  }
                  setCustomDaysOpen(false);
                  applyDays(Number(event.target.value));
                }}
                className="planner-input"
              >
                {dayPresets.map((days) => (
                  <option key={days} value={days}>
                    {days} 天
                  </option>
                ))}
                <option value="custom">自定义</option>
              </select>
              {customDaysActive ? (
                <div className="days-custom-field">
                  <div className="days-custom-input-wrap">
                    <input
                      aria-label="自定义旅行天数"
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      value={customDaysDraft}
                      onChange={(event) =>
                        setCustomDaysDraft(event.target.value.replace(/[^\d]/g, "").slice(0, 3))
                      }
                      onBlur={commitCustomDays}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          commitCustomDays();
                          event.currentTarget.blur();
                        }
                        if (event.key === "Escape") {
                          setCustomDaysDraft(String(brief.days));
                          event.currentTarget.blur();
                        }
                      }}
                      className="planner-input days-custom-input"
                    />
                    <span>天</span>
                  </div>
                </div>
              ) : null}
            </label>
          </div>

          <RouteBuilder brief={brief} route={routePlan} onBrief={onBrief} />

          <div className="mt-6">
            <span className="planner-field-label">节奏</span>
            <div className="grid gap-3 sm:grid-cols-3">
              {paceOptions.map((pace) => (
                <button
                  key={pace.id}
                  type="button"
                  onClick={() => onBrief({ ...brief, pace: pace.id })}
                  className={cn("pace-option", brief.pace === pace.id && "pace-option-active")}
                >
                  <span className="font-medium">{pace.title}</span>
                  <small>{pace.description}</small>
                </button>
              ))}
            </div>
          </div>

          <div className="mt-6">
            <span className="planner-field-label">特别想看</span>
            <div className="flex flex-wrap gap-2">
              {interestOptions.map((interest) => (
                <button
                  key={interest}
                  type="button"
                  onClick={() => toggleInterest(interest)}
                  className={cn(
                    "interest-chip",
                    brief.interests.includes(interest) && "interest-chip-active",
                  )}
                >
                  {brief.interests.includes(interest) ? <Check className="size-3.5" /> : null}
                  {interest}
                </button>
              ))}
            </div>
          </div>

          <Button
            size="lg"
            className="mt-8 w-full sm:w-auto"
            disabled={!routePlan}
            onClick={onSubmit}
          >
            生成旅行规划
            <ArrowRight className="size-4" />
          </Button>
          {!routePlan ? (
            <p className="mt-3 text-xs leading-5 text-[var(--v-seal)]">
              请先填写出发地和目的地，途经点最多 5 个。
            </p>
          ) : null}
        </section>

        <aside className="planner-preview-card">
          <DestinationPreview destination={resolveTripDestination(brief, inspirationCatalog)} />
        </aside>
      </div>
    </main>
  );
}

function DestinationPreview({ destination }: { destination: Destination }) {
  const inspirationCatalog = useInspirationCatalog();
  const [openTimingIndex, setOpenTimingIndex] = useState<number | null>(null);
  const scene =
    findInspiration(destination.id, inspirationCatalog) ??
    findInspiration(destination.name, inspirationCatalog);
  const guide = scene
    ? buildSceneGuide(scene)
    : {
        highlights: destination.bestFor.split(" · ").filter(Boolean).slice(0, 3),
        experiences: [
          { label: "目的地漫步", duration: "1.5–2.5 小时" },
          { label: "在地风味", duration: "1–2 小时" },
          { label: "实时行程规划", duration: "10–20 分钟" },
        ],
        recommendedTime: "半天–2 天",
        timing: "根据实时搜索结果和你的旅行时间再细化停留节奏。",
      };
  const timingItems = buildTimingItems(guide.timing, destination.name);

  useEffect(() => {
    setOpenTimingIndex(null);
  }, [destination.id]);

  return (
    <>
      <div className="planner-preview-image">
        <img src={destination.cover} alt={`${destination.name}旅行场景`} />
        <div>
          <span>{destination.eyebrow}</span>
          <strong>{destination.name}</strong>
        </div>
      </div>
      <div className="p-5">
        <p className="font-serif text-xl text-[var(--v-ink)]">{destination.bestFor}</p>
        <p className="mt-3 text-sm leading-7 text-[var(--v-muted)]">{destination.summary}</p>
        <div className="mt-5 grid grid-cols-2 gap-2 text-xs text-[var(--v-muted)]">
          <span className="inline-flex items-center gap-2">
            <Mountain className="size-4 text-[var(--v-accent)]" />{" "}
            {destination.places.length > 0
              ? `${destination.places.length} 个候选景区`
              : "实时搜索补充候选景区"}
          </span>
          <span className="inline-flex items-center gap-2">
            <Gauge className="size-4 text-[var(--v-accent)]" /> 按时间动态收缩范围
          </span>
        </div>

        <section className="scene-guide">
          <div className="scene-guide-heading">
            <div>
              <p>TRAVEL NOTE</p>
              <h4>行前笺</h4>
            </div>
            <div className="scene-time-seal">
              <span>建议停留</span>
              <strong>{guide.recommendedTime}</strong>
            </div>
          </div>

          <div className="scene-guide-row">
            <span className="scene-guide-label">看点</span>
            <div className="scene-guide-chips">
              {guide.highlights.map((highlight) => (
                <span key={highlight}>{highlight}</span>
              ))}
            </div>
          </div>

          <div className="scene-guide-row scene-guide-experience-row">
            <span className="scene-guide-label">体验项目</span>
            <div className="scene-guide-experiences">
              {guide.experiences.map((experience) => (
                <div className="scene-guide-experience" key={experience.label}>
                  <span className="scene-guide-experience-label">{experience.label}</span>
                  <span className="scene-guide-experience-duration">
                    <Timer className="size-3" />约 {experience.duration}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="scene-guide-tip">
            <div className="scene-guide-tip-head">
              <span className="scene-guide-tip-icon">
                <Clock3 className="size-3.5" />
              </span>
              <span className="scene-guide-tip-headcopy">
                <strong>时间安排</strong>
                <small>点击每一段查看游览建议</small>
              </span>
            </div>
            <div className="scene-guide-tip-lines">
              {timingItems.map((item, index) => {
                const open = openTimingIndex === index;
                const detailId = `timing-detail-${destination.id}-${index}`;
                return (
                  <div className="scene-guide-tip-item" key={`${item.label}-${index}`}>
                    <button
                      type="button"
                      className="scene-guide-tip-trigger"
                      aria-expanded={open}
                      aria-controls={detailId}
                      onClick={() => setOpenTimingIndex(open ? null : index)}
                    >
                      <span className="scene-guide-tip-dot" aria-hidden="true" />
                      <span>{item.label}</span>
                      <ChevronRight
                        className={cn("scene-guide-tip-chevron", open && "is-open")}
                        aria-hidden="true"
                      />
                    </button>
                    {open ? (
                      <p id={detailId} className="scene-guide-tip-detail">
                        {item.detail}
                      </p>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      </div>
    </>
  );
}

function RouteBuilder({
  brief,
  route,
  onBrief,
}: {
  brief: TripBrief;
  route: RoutePlan | null;
  onBrief: (brief: TripBrief) => void;
}) {
  const [waypointEditorOpen, setWaypointEditorOpen] = useState(brief.waypoints.length > 0);

  const update = (patch: Partial<TripBrief>) => onBrief({ ...brief, ...patch });

  const addWaypointRow = () => {
    setWaypointEditorOpen(true);
    if (brief.waypoints.length >= 5) return;
    update({ waypoints: [...brief.waypoints, ""], legPreferences: {} });
  };

  const removeWaypoint = (index: number) => {
    update({
      waypoints: removeWaypointAt(brief.waypoints, index),
      legPreferences: {},
    });
  };

  const updateLeg = (id: string, preference: RouteLegPreference) => {
    update({
      legPreferences: {
        ...brief.legPreferences,
        [id]: { ...brief.legPreferences[id], ...preference },
      },
    });
  };

  const setAllStyles = (style: TravelStyle) => {
    const legPreferences = { ...brief.legPreferences };
    route?.legs
      .filter((leg) => leg.kind === "outbound")
      .forEach((leg) => {
        legPreferences[leg.id] = { ...legPreferences[leg.id], style };
      });
    delete legPreferences.return;
    update({ defaultTravelStyle: style, legPreferences });
  };

  return (
    <section className="route-builder">
      <div className="route-builder-head">
        <div>
          <p>ROUTE / 路线设置</p>
          <h3>沿路安排，不来回折腾</h3>
          <span>途经点和目的地都表示到达附近后继续游玩</span>
        </div>
        <div className="route-style-all" aria-label="全程旅行方式">
          <button
            type="button"
            className={cn(brief.defaultTravelStyle === "direct" && "is-active")}
            onClick={() => setAllStyles("direct")}
          >
            全程直达
          </button>
          <button
            type="button"
            className={cn(brief.defaultTravelStyle === "wander" && "is-active")}
            onClick={() => setAllStyles("wander")}
          >
            全程边走边玩
          </button>
        </div>
      </div>

      <div className="route-origin-row">
        <label className="route-node-field">
          <span>出发地</span>
          <input
            value={brief.origin}
            onChange={(event) => update({ origin: event.target.value })}
            placeholder="例如：北京"
            className="planner-input"
          />
        </label>
        <button
          type="button"
          className="route-waypoint-toggle"
          aria-expanded={waypointEditorOpen}
          aria-label="添加途经点"
          disabled={brief.waypoints.length >= 5}
          onClick={addWaypointRow}
        >
          <Plus className="size-4" />
          <span>途经点</span>
        </button>
      </div>

      {waypointEditorOpen ? (
        <div className="route-waypoint-editor">
          <div className="route-waypoint-head">
            <span>途经点</span>
            <small>{brief.waypoints.length} / 5</small>
          </div>

          <div className="route-waypoint-list">
            {brief.waypoints.map((waypoint, index) => (
              <div className="route-waypoint" key={`waypoint-row-${index}`}>
                <div className="route-waypoint-field">
                  <span className="route-waypoint-index">{index + 1}</span>
                  <input
                    value={waypoint}
                    aria-label={`途经点 ${index + 1}`}
                    placeholder="输入途经点"
                    onChange={(event) => {
                      const waypoints = [...brief.waypoints];
                      waypoints[index] = event.target.value;
                      update({ waypoints, legPreferences: {} });
                    }}
                    onKeyDown={(event) => {
                      if (event.nativeEvent.isComposing) return;
                      if (event.key === "Enter") {
                        event.preventDefault();
                        addWaypointRow();
                      }
                    }}
                  />
                </div>
                <button
                  type="button"
                  className="route-waypoint-remove"
                  aria-label={`删除途经点 ${waypoint}`}
                  onClick={() => removeWaypoint(index)}
                >
                  <Minus className="size-4" />
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {route ? (
        <div className="route-legs">
          {route.legs.map((leg) => {
            const preference = brief.legPreferences[leg.id] ?? {};
            return (
              <div
                className={cn("route-leg", leg.kind === "return" && "route-leg-return")}
                key={leg.id}
              >
                <div className="route-leg-route">
                  <span>{leg.from}</span>
                  <ArrowRight className="size-3.5" />
                  <span>{leg.to}</span>
                  {leg.kind === "return" ? <Badge>返程</Badge> : null}
                </div>
                <div className="route-leg-controls">
                  <select
                    aria-label={`${leg.from}到${leg.to}的交通方式`}
                    value={preference.transport ?? leg.transport}
                    onChange={(event) =>
                      updateLeg(leg.id, { transport: event.target.value as TransportMode })
                    }
                  >
                    {transportOptions.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <div
                    className="route-style-segmented"
                    aria-label={`${leg.from}到${leg.to}的旅行方式`}
                  >
                    <button
                      type="button"
                      className={cn((preference.style ?? leg.style) === "direct" && "is-active")}
                      onClick={() => updateLeg(leg.id, { style: "direct" })}
                    >
                      直达
                    </button>
                    <button
                      type="button"
                      className={cn((preference.style ?? leg.style) === "wander" && "is-active")}
                      onClick={() => updateLeg(leg.id, { style: "wander" })}
                    >
                      边走边玩
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      <div className="route-return">
        <label className="route-return-toggle">
          <input
            type="checkbox"
            checked={brief.roundTrip}
            onChange={(event) => update({ roundTrip: event.target.checked })}
          />
          <span>往返</span>
        </label>
        {brief.roundTrip ? (
          <div className="route-return-options">
            <button
              type="button"
              className={cn(brief.returnMode === "scenic" && "is-active")}
              onClick={() => {
                const { return: _returnPreference, ...legPreferences } = brief.legPreferences;
                update({ returnMode: "scenic", legPreferences });
              }}
            >
              <strong>不走回头</strong>
              <small>沿途换景点或路线返回</small>
            </button>
            <button
              type="button"
              className={cn(brief.returnMode === "fast" && "is-active")}
              onClick={() => {
                const { return: _returnPreference, ...legPreferences } = brief.legPreferences;
                update({ returnMode: "fast", legPreferences });
              }}
            >
              <strong>快速回家</strong>
              <small>优先最快交通组合</small>
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function UnknownPlanScreen({
  variant,
  onBack,
  onComplete,
}: {
  variant: DesignVariant;
  onBack: () => void;
  onComplete: (brief: TripBrief) => void;
}) {
  const inspirationCatalog = useInspirationCatalog();
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<UnknownAnswers>({
    mood: "",
    days: 2,
    pace: "balanced",
    interest: "",
  });

  const steps = [
    {
      key: "mood",
      title: "你最想看到什么样的风景？",
      subtitle: "先决定这一趟旅行的气质。",
      options: [
        { value: "mountain", label: "奇峰与山水", hint: "黄山、漓江、登高与云海" },
        { value: "water-town", label: "水乡与古镇", hint: "湖泊、园林、老街与慢游" },
        { value: "anything", label: "都可以", hint: "让我根据时间和季节推荐" },
      ],
    },
    {
      key: "days",
      title: "大概能留出几天？",
      subtitle: "天数会直接影响推荐范围。",
      options: [2, 3, 4, 5].map((days) => ({
        value: days,
        label: `${days} 天`,
        hint: days <= 2 ? "适合一个核心片区" : "可以组合城市与周边景区",
      })),
    },
    {
      key: "pace",
      title: "希望每天走多满？",
      subtitle: "我们会据此控制每天景点数量。",
      options: paceOptions.map((pace) => ({
        value: pace.id,
        label: pace.title,
        hint: pace.description,
      })),
    },
    {
      key: "interest",
      title: "有没有特别想体验的？",
      subtitle: "最后一个问题。",
      options: [
        { value: "自然山水", label: "自然山水", hint: "优先观景、徒步和游船" },
        { value: "古村古镇", label: "古村古镇", hint: "优先街巷、建筑与在地生活" },
        { value: "人文建筑", label: "人文建筑", hint: "博物馆、寺院和传统建筑" },
        { value: "美食街区", label: "美食街区", hint: "把吃饭和街区漫游排进路线" },
      ],
    },
  ];

  const current = steps[step];

  const pick = (value: string | number) => {
    const nextAnswers = { ...answers, [current.key]: value } as UnknownAnswers;
    setAnswers(nextAnswers);
    if (step < steps.length - 1) {
      window.setTimeout(() => setStep((currentStep) => currentStep + 1), 120);
      return;
    }
    const destinationId = recommendDestination(nextAnswers);
    const destination = findInspiration(destinationId, inspirationCatalog);
    onComplete({
      origin: "北京",
      destinationId,
      destinationName: destination?.name ?? "黄山",
      latitude: destination?.latitude,
      longitude: destination?.longitude,
      startDate: dateInputValue(new Date()),
      days: nextAnswers.days,
      dailyHours: 6,
      pace: nextAnswers.pace,
      interests: [nextAnswers.interest],
      waypoints: [],
      roundTrip: false,
      returnMode: "fast",
      defaultTravelStyle: "direct",
      legPreferences: {},
    });
  };

  return (
    <main className="planner-page planner-wizard-page">
      <button type="button" className="planner-back" onClick={onBack}>
        <ArrowLeft className="size-4" /> 返回入口
      </button>
      <div className="wizard-layout">
        <aside className="wizard-rail">
          <Badge>逐步收敛</Badge>
          <h1>不用现在决定目的地。</h1>
          <p>只回答你在意的部分，最后得到一个适合当前时间和节奏的方向。</p>
          <div className="mt-8 space-y-3">
            {steps.map((item, index) => (
              <div
                key={item.key}
                className={cn("wizard-step", index === step && "wizard-step-active")}
              >
                <span>{index + 1}</span>
                <p>{item.title}</p>
              </div>
            ))}
          </div>
        </aside>

        <section className="wizard-panel">
          <div className="mb-8">
            <div className="mb-3 flex items-center justify-between text-xs text-[var(--v-muted)]">
              <span>
                问题 {step + 1} / {steps.length}
              </span>
              <span>{Math.round(((step + 1) / steps.length) * 100)}%</span>
            </div>
            <Progress value={((step + 1) / steps.length) * 100} />
          </div>
          <p className="text-xs tracking-[0.22em] text-[var(--v-accent)]">STEP {step + 1}</p>
          <h2 className="mt-3 font-serif text-3xl text-[var(--v-ink)] md:text-4xl">
            {current.title}
          </h2>
          <p className="mt-3 text-sm text-[var(--v-muted)]">{current.subtitle}</p>
          <div className="mt-8 grid gap-3">
            {current.options.map((option) => {
              const active = answers[current.key as keyof UnknownAnswers] === option.value;
              return (
                <button
                  key={String(option.value)}
                  type="button"
                  onClick={() => pick(option.value)}
                  className={cn("wizard-option", active && "wizard-option-active")}
                >
                  <span>
                    <strong>{option.label}</strong>
                    <small>{option.hint}</small>
                  </span>
                  <ChevronRight className="size-5 shrink-0" />
                </button>
              );
            })}
          </div>
          {step > 0 ? (
            <button
              type="button"
              className="mt-6 text-sm text-[var(--v-muted)] hover:text-[var(--v-ink)]"
              onClick={() => setStep(step - 1)}
            >
              返回上一题
            </button>
          ) : null}
        </section>
      </div>
      {variant === "journal" ? <div className="journal-page-number">PLAN / 01</div> : null}
    </main>
  );
}

function ItineraryScreen({
  variant,
  brief,
  saved,
  onBack,
  onEdit,
  onSave,
}: {
  variant: DesignVariant;
  brief: TripBrief;
  saved: boolean;
  onBack: () => void;
  onEdit: () => void;
  onSave: () => void;
}) {
  const inspirationCatalog = useInspirationCatalog();
  const refreshInspirationCatalog = useInspirationCatalogRefresh();
  const destination = resolveTripDestination(brief, inspirationCatalog);
  const forecastFn = useServerFn(getOpenMeteoForecast);
  const livePlannerFn = useServerFn(generateLiveItinerary);
  const longPlannerFn = useServerFn(generateLongItinerary);
  const [weather, setWeather] = useState<WeatherDay[]>([]);
  const [weatherState, setWeatherState] = useState<"loading" | "ready" | "error">("loading");
  const [weatherError, setWeatherError] = useState<string | null>(null);
  const [livePlan, setLivePlan] = useState<GeneratedItinerary | null>(null);
  const [longPlan, setLongPlan] = useState<LongPlan | null>(null);
  const [plannerState, setPlannerState] = useState<"idle" | "loading" | "ready" | "fallback">(
    "idle",
  );
  const [plannerMessage, setPlannerMessage] = useState("");
  const [liveSourceCount, setLiveSourceCount] = useState<number | null>(null);
  const [selectedPlace, setSelectedPlace] = useState<Place | null>(null);

  const detailedTrip = brief.days <= 16;
  const today = dateInputValue(new Date());
  const offset = dayOffset(today, brief.startDate);
  const forecastWindow = Math.min(16, Math.max(brief.days, offset + brief.days));
  const weatherLatitude = destination.weatherLocation?.latitude;
  const weatherLongitude = destination.weatherLocation?.longitude;
  const routePlan = useMemo(() => {
    try {
      return buildRoutePlan({
        origin: brief.origin,
        destination: brief.destinationName,
        waypoints: brief.waypoints,
        roundTrip: brief.roundTrip,
        returnMode: brief.returnMode,
        defaultStyle: brief.defaultTravelStyle,
        legPreferences: brief.legPreferences,
      });
    } catch {
      return null;
    }
  }, [
    brief.defaultTravelStyle,
    brief.destinationName,
    brief.legPreferences,
    brief.origin,
    brief.returnMode,
    brief.roundTrip,
    brief.waypoints,
  ]);

  useEffect(() => {
    let cancelled = false;
    setWeatherState("loading");
    setWeather([]);
    setWeatherError(null);
    forecastFn({
      data: {
        ...(typeof weatherLatitude === "number" && typeof weatherLongitude === "number"
          ? { latitude: weatherLatitude, longitude: weatherLongitude }
          : { placeName: destination.name }),
        days: forecastWindow,
        timezone: "Asia/Shanghai",
      },
    })
      .then((result) => {
        if (cancelled) return;
        const tripWeather = result.days
          .filter((day) => day.date >= brief.startDate)
          .slice(0, brief.days);
        setWeather(tripWeather);
        setWeatherState("ready");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setWeatherState("error");
        setWeatherError(error instanceof Error ? error.message : "无法获取天气");
      });
    return () => {
      cancelled = true;
    };
  }, [
    brief.days,
    brief.startDate,
    destination.id,
    destination.name,
    forecastFn,
    forecastWindow,
    weatherLatitude,
    weatherLongitude,
  ]);

  useEffect(() => {
    let cancelled = false;
    setPlannerState("loading");
    setPlannerMessage("");
    setLivePlan(null);
    setLongPlan(null);
    setLiveSourceCount(null);

    if (!routePlan) {
      setPlannerState("fallback");
      setPlannerMessage("路线设置不完整，请返回调整。");
      return;
    }

    if (detailedTrip) {
      if (weatherState !== "ready" || weather.length === 0) return;

      livePlannerFn({
        data: {
          destination: {
            id: destination.id,
            name: destination.name,
            region: destination.region,
          },
          startDate: brief.startDate,
          days: brief.days,
          dailyHours: brief.dailyHours,
          pace: brief.pace,
          interests: brief.interests,
          weather,
          seedPlaces: destination.places,
          route: routePlan,
        },
      })
        .then((result) => {
          if (cancelled) return;
          if (result.status === "ok") {
            setLivePlan(result.plan);
            setLiveSourceCount(result.sources.length);
            setPlannerState("ready");
            notifyDiscoveries(result.discoveries);
            if (result.discoveries.some((discovery) => discovery.status === "published")) {
              void refreshInspirationCatalog();
            }
            return;
          }
          setPlannerState("fallback");
          setPlannerMessage(`缺少配置：${result.missing.join("、")}`);
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          setPlannerState("fallback");
          setPlannerMessage(error instanceof Error ? error.message : "实时规划服务暂不可用");
        });
    } else {
      const fallbackPlan = buildFallbackLongPlan({
        destinationName: destination.name,
        region: destination.region,
        days: brief.days,
        seedPlaces: destination.places.map((place) => place.name),
      });

      longPlannerFn({
        data: {
          destination: {
            id: destination.id,
            name: destination.name,
            region: destination.region,
          },
          startDate: brief.startDate,
          days: brief.days,
          pace: brief.pace,
          interests: brief.interests,
          seedPlaces: destination.places.map((place) => place.name),
          route: routePlan,
        },
      })
        .then((result) => {
          if (cancelled) return;
          if (result.status === "ok") {
            setLongPlan(result.plan);
            setPlannerState("ready");
            notifyDiscoveries(result.discoveries);
            if (result.discoveries.some((discovery) => discovery.status === "published")) {
              void refreshInspirationCatalog();
            }
            return;
          }
          setLongPlan(fallbackPlan);
          setPlannerState("fallback");
          setPlannerMessage(`缺少配置：${result.missing.join("、")}`);
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          setLongPlan(fallbackPlan);
          setPlannerState("fallback");
          setPlannerMessage(error instanceof Error ? error.message : "长线规划服务暂不可用");
        });
    }

    return () => {
      cancelled = true;
    };
  }, [
    brief.dailyHours,
    brief.days,
    brief.interests,
    brief.pace,
    brief.startDate,
    detailedTrip,
    destination.id,
    destination.name,
    destination.places,
    destination.region,
    livePlannerFn,
    longPlannerFn,
    refreshInspirationCatalog,
    routePlan,
    weather,
    weatherState,
  ]);
  const plannedDays = useMemo(
    () =>
      livePlan
        ? livePlan.days.map((day) => ({
            ...day,
            weather: weather[day.day - 1],
          }))
        : splitPlacesAcrossDays(destination.places, weather, brief.pace),
    [brief.pace, destination.places, livePlan, weather],
  );

  const rainDays = weather.filter((day) => {
    const tone = classifyWeather(day.code).tone;
    return tone === "rain" || tone === "storm";
  }).length;

  return (
    <main className="planner-result-page">
      <button type="button" className="planner-back" onClick={onBack}>
        <ArrowLeft className="size-4" /> 返回调整
      </button>

      <section className="result-hero">
        <img src={destination.cover} alt={`${destination.name}旅行场景`} />
        <div className="result-hero-wash" />
        <div className="result-hero-copy">
          <Badge className="border-white/20 bg-white/10 text-white">
            {detailedTrip ? "目的地周边 · 时间驱动" : "长线规划 · 阶段汇总"}
          </Badge>
          <h1>{longPlan?.title ?? livePlan?.title ?? `${destination.name}怎么玩`}</h1>
          <p>{longPlan?.summary ?? livePlan?.summary ?? destination.summary}</p>
          <div className="result-meta">
            <span>
              <CalendarDays className="size-4" /> {formatDate(brief.startDate)} 起 · {brief.days} 天
            </span>
            <span>
              <Timer className="size-4" /> 每天约 {brief.dailyHours} 小时
            </span>
            <span>
              <Route className="size-4" />
              {detailedTrip
                ? `${liveSourceCount ?? destination.places.length} 个候选景区`
                : `${longPlan?.phases.length ?? "多个"} 个路线阶段`}
            </span>
          </div>
          {routePlan ? (
            <p className="result-route-path">
              {routePlan.legs.map((leg) => leg.from).join(" → ")} → {routePlan.legs.at(-1)?.to}
              {routePlan.roundTrip
                ? routePlan.returnMode === "scenic"
                  ? " · 不走回头"
                  : " · 快速回家"
                : ""}
            </p>
          ) : null}
        </div>
        <div className="result-hero-actions">
          <Button variant="outline" size="sm" onClick={onEdit}>
            调整条件
          </Button>
          <Button variant={saved ? "seal" : "default"} size="sm" onClick={onSave}>
            {saved ? <Check className="size-4" /> : <Save className="size-4" />}
            {saved ? "已保存" : "保存行程"}
          </Button>
        </div>
      </section>

      <section className="result-weather">
        <div className="section-kicker">
          <span>{detailedTrip ? "WEATHER / 逐日天气" : "WEATHER / 前 16 天趋势"}</span>
          <Badge>
            {weatherState === "ready"
              ? "Open-Meteo 实时"
              : weatherState === "loading"
                ? "正在获取"
                : "暂不可用"}
          </Badge>
        </div>
        <WeatherStrip
          days={weather}
          variant={variant}
          loading={weatherState === "loading"}
          error={weatherError}
        />
        {!detailedTrip ? (
          <p className="mt-4 text-sm leading-7 text-[var(--v-muted)]">
            前 3 天可信度较高，4–16 天仅作趋势参考；第 17 天起暂无逐日天气预报，以实际天气为准。
          </p>
        ) : null}
        {rainDays > 0 ? (
          <p className="mt-4 text-sm text-[var(--v-muted)]">
            {detailedTrip ? "这段时间有 " : "前 16 天中有 "}
            <strong className="text-[var(--v-ink)]">{rainDays} 天</strong>
            可能降雨，行程会优先照顾室内或短时景点。
          </p>
        ) : null}
      </section>

      <div className={cn("result-layout", variant === "atlas" && "atlas-result-layout")}>
        <aside className="result-brief">
          <p className="text-xs tracking-[0.22em] text-[var(--v-accent)]">TRIP BRIEF</p>
          <h2>这趟行程怎么收敛</h2>
          <dl>
            <div>
              <dt>目的地</dt>
              <dd>{destination.name}</dd>
            </div>
            <div>
              <dt>天数</dt>
              <dd>{brief.days} 天</dd>
            </div>
            <div>
              <dt>节奏</dt>
              <dd>{paceOptions.find((item) => item.id === brief.pace)?.title}</dd>
            </div>
            <div>
              <dt>每天时间</dt>
              <dd>{brief.dailyHours} 小时</dd>
            </div>
          </dl>
          <div className="mt-5 flex flex-wrap gap-2">
            {brief.interests.map((interest) => (
              <Badge key={interest}>{interest}</Badge>
            ))}
          </div>
          <p className="mt-6 text-xs leading-6 text-[var(--v-muted)]">
            {detailedTrip
              ? plannerState === "ready"
                ? "当前景点由 Tavily 实时搜索、DeepSeek 规划排序，并保留来源链接。"
                : "当前景点采用开发期精选数据并保留来源链接；配置实时服务后会自动替换。"
              : plannerState === "ready"
                ? "当前路线由 DeepSeek 按阶段汇总，适合长线行程先定大方向。"
                : "当前展示阶段路线框架；配置实时服务后会替换为模型规划结果。"}
          </p>
        </aside>
        <section className="result-days">
          <div className="section-kicker">
            <span>{detailedTrip ? "ITINERARY / 每日行程" : "ROUTE / 路线阶段"}</span>
            <span className="flex flex-wrap items-center justify-end gap-2 text-xs text-[var(--v-muted)]">
              <Badge>
                {detailedTrip
                  ? plannerState === "ready"
                    ? "DeepSeek 实时编排"
                    : plannerState === "loading"
                      ? "DeepSeek 正在编排"
                      : "开发期精选数据"
                  : plannerState === "ready"
                    ? "DeepSeek 阶段汇总"
                    : plannerState === "loading"
                      ? "正在收敛路线"
                      : "阶段路线框架"}
              </Badge>
              {detailedTrip ? "点击景点查看详情与来源" : "长线行程只汇总路线阶段，不逐日展开"}
            </span>
          </div>
          {plannerState === "fallback" ? (
            <div className="mb-5 rounded-[var(--v-card-radius)] border border-[var(--v-line)] bg-[var(--v-soft)] px-4 py-3 text-xs leading-6 text-[var(--v-muted)]">
              {detailedTrip
                ? "实时搜索与 DeepSeek 尚未配置，当前展示开发期精选行程。配置完成后会自动切换为联网景区与实时排序。"
                : "DeepSeek 长线规划暂不可用，当前展示按路线拆分的阶段框架。"}
              {plannerMessage ? (
                <span className="mt-1 block opacity-75">{plannerMessage}</span>
              ) : null}
            </div>
          ) : null}
          {detailedTrip ? (
            <div
              className={cn(
                variant === "scroll" && "mt-8",
                variant === "atlas" && "mt-2",
                variant === "journal" && "mt-5",
              )}
            >
              {plannedDays.map((day) => (
                <ItineraryDay
                  key={day.day}
                  day={day}
                  variant={variant}
                  onPlace={setSelectedPlace}
                />
              ))}
            </div>
          ) : (
            <LongPlanPhases plan={longPlan} loading={plannerState === "loading"} />
          )}
        </section>{" "}
      </div>

      <Sheet open={Boolean(selectedPlace)} onOpenChange={(open) => !open && setSelectedPlace(null)}>
        <SheetContent>
          {selectedPlace ? (
            <div className="pt-8">
              <Badge>{selectedPlace.area}</Badge>
              <h2 className="mt-4 font-serif text-3xl text-[var(--v-ink)]">{selectedPlace.name}</h2>
              <p className="mt-4 text-sm leading-7 text-[var(--v-muted)]">
                {selectedPlace.summary}
              </p>
              <div className="mt-6 grid grid-cols-2 gap-3">
                <div className="rounded-[var(--v-card-radius)] bg-[var(--v-soft)] p-4">
                  <Timer className="size-4 text-[var(--v-accent)]" />
                  <p className="mt-2 text-xs text-[var(--v-muted)]">建议停留</p>
                  <p className="mt-1 font-medium text-[var(--v-ink)]">
                    {Math.round((selectedPlace.duration / 60) * 10) / 10} 小时
                  </p>
                </div>
                <div className="rounded-[var(--v-card-radius)] bg-[var(--v-soft)] p-4">
                  {selectedPlace.indoor ? (
                    <Landmark className="size-4 text-[var(--v-accent)]" />
                  ) : (
                    <Waves className="size-4 text-[var(--v-accent)]" />
                  )}
                  <p className="mt-2 text-xs text-[var(--v-muted)]">天气适配</p>
                  <p className="mt-1 font-medium text-[var(--v-ink)]">
                    {selectedPlace.indoor ? "雨天优先" : "适合较好天气"}
                  </p>
                </div>
              </div>
              <a
                href={selectedPlace.source}
                target="_blank"
                rel="noreferrer"
                className="mt-7 inline-flex items-center gap-2 text-sm font-medium text-[var(--v-accent)]"
              >
                查看资料来源 <ArrowRight className="size-4" />
              </a>
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </main>
  );
}

function LongPlanPhases({ plan, loading }: { plan: LongPlan | null; loading: boolean }) {
  if (loading && !plan) {
    return (
      <div className="long-plan-phases mt-8" aria-label="正在生成阶段路线">
        {[0, 1, 2].map((item) => (
          <div className="long-plan-phase" key={item}>
            <Skeleton className="h-4 w-24 rounded-full" />
            <Skeleton className="mt-4 h-7 w-52 rounded-lg" />
            <Skeleton className="mt-3 h-4 w-36 rounded-full" />
            <Skeleton className="mt-5 h-20 w-full rounded-xl" />
          </div>
        ))}
      </div>
    );
  }

  if (!plan) return null;

  return (
    <div className="long-plan-phases mt-8">
      {plan.phases.map((phase, index) => (
        <article className="long-plan-phase" key={`${phase.dayStart}-${phase.dayEnd}`}>
          <div className="long-plan-phase-top">
            <span className="long-plan-phase-index">阶段 {index + 1}</span>
            <span className="long-plan-phase-days">
              <CalendarDays className="size-3.5" />第 {phase.dayStart}–{phase.dayEnd} 天
            </span>
          </div>
          <h3>{phase.title}</h3>
          <p className="long-plan-phase-region">
            <MapPin className="size-4" />
            {phase.region}
          </p>
          <div className="long-plan-phase-tags">
            {phase.highlights.map((highlight) => (
              <span key={highlight}>{highlight}</span>
            ))}
          </div>
          <div className="long-plan-phase-detail">
            <p>
              <Route className="size-4" />
              <span>
                <strong>交通衔接</strong>
                {phase.transport}
              </span>
            </p>
            <p>
              <Clock3 className="size-4" />
              <span>
                <strong>注意事项</strong>
                {phase.notes}
              </span>
            </p>
          </div>
        </article>
      ))}
    </div>
  );
}
