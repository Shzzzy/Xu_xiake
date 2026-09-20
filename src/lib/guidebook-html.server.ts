import { buildTripMapLayers } from "./amap.server.ts";
import {
  normalizeRadarScores,
  type BudgetCategory,
  type Coordinate,
  type DailyRadar,
  type RouteSegment,
  type TripDay,
  type TripPlan,
  type TripTimelineNode,
} from "./travel-plan.ts";

const DISCLAIMER = "内容由 AI 生成，旅游记得以实际为准哦";
const RADAR_AXES: { key: keyof DailyRadar; label: string }[] = [
  { key: "physical", label: "体力" },
  { key: "childFit", label: "亲子" },
  { key: "weatherSensitivity", label: "天气" },
  { key: "timeCost", label: "时间" },
  { key: "crowding", label: "拥挤" },
];
const SENSITIVE_QUERY_KEYS = new Set([
  "key",
  "api_key",
  "apikey",
  "access_key",
  "accesskey",
  "secret",
  "token",
]);

const NODE_LABELS: Record<TripTimelineNode["type"], string> = {
  transport: "交通",
  transfer: "换乘",
  attraction: "景点",
  meal: "用餐",
  rest: "休息",
  hotel: "酒店",
  "night-activity": "夜游",
};

const TRANSPORT_LABELS: Record<RouteSegment["mode"], string> = {
  economy: "经济交通",
  balanced: "均衡交通",
  speed: "快捷交通",
  train: "高铁 / 火车",
  flight: "飞机",
  drive: "自驾",
  bus: "大巴",
  ship: "轮渡",
};

const TRANSPORT_ICONS: Record<RouteSegment["mode"], string> = {
  economy: "ti-coins",
  balanced: "ti-route",
  speed: "ti-rocket",
  train: "ti-train",
  flight: "ti-plane",
  drive: "ti-car",
  bus: "ti-bus",
  ship: "ti-ship",
};

function escapeHtml(value: unknown): string {
  const characters: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return String(value ?? "").replace(/[&<>"']/g, (character) => characters[character] ?? character);
}

function isSensitiveQueryKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return (
    SENSITIVE_QUERY_KEYS.has(normalized) ||
    normalized.endsWith("_api_key") ||
    normalized.endsWith("_access_key") ||
    normalized.endsWith("_token")
  );
}

function sanitizeUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (/^data:image\//i.test(trimmed)) return trimmed;

  try {
    if (trimmed.startsWith("/")) {
      const relative = new URL(trimmed, "https://guidebook.invalid");
      for (const key of [...relative.searchParams.keys()]) {
        if (isSensitiveQueryKey(key)) relative.searchParams.delete(key);
      }
      relative.hash = "";
      return `${relative.pathname}${relative.search}`;
    }

    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) {
      if (isSensitiveQueryKey(key)) url.searchParams.delete(key);
    }
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function finiteNumber(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function formatNumber(value: number): string {
  return Math.round(finiteNumber(value)).toLocaleString("zh-CN");
}

function currency(value: number): string {
  return `¥${formatNumber(value)}`;
}

function formatDuration(minutes: number): string {
  const rounded = Math.max(0, Math.round(finiteNumber(minutes)));
  const hours = Math.floor(rounded / 60);
  const rest = rounded % 60;
  if (hours <= 0) return `${rest} 分钟`;
  if (rest === 0) return `${hours} 小时`;
  return `${hours} 小时 ${rest} 分钟`;
}

function formatDate(value: string): string {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!matched) return value;
  return `${matched[1]} 年 ${Number(matched[2])} 月 ${Number(matched[3])} 日`;
}

function travelerText(plan: TripPlan): string {
  const { adults, children } = plan.meta.travelers;
  const parts = [`${adults} 位成人`];
  if (children > 0) parts.push(`${children} 位儿童`);
  return parts.join(" · ");
}

function paceLabel(plan: TripPlan): string {
  if (plan.meta.pace === "relaxed") return "轻松节奏";
  if (plan.meta.pace === "deep") return "充实节奏";
  return "适中节奏";
}

function transportPreferenceLabel(plan: TripPlan): string {
  if (plan.meta.transportPreference === "economy") return "经济优先";
  if (plan.meta.transportPreference === "speed") return "效率优先";
  return "均衡交通";
}

function returnModeLabel(plan: TripPlan): string {
  if (plan.route.returnMode === "fast") return "快速返程";
  if (plan.route.returnMode === "scenic") return "回程再玩";
  return "单程";
}

function routeNodesText(plan: TripPlan): string {
  return [plan.meta.origin, ...plan.meta.waypoints, plan.meta.destination]
    .filter(Boolean)
    .join(" → ");
}

function uniqueValues(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function allAttractionNodes(plan: TripPlan): TripTimelineNode[] {
  return plan.days.flatMap((day) =>
    day.nodes.filter((node) => node.type === "attraction" || node.type === "night-activity"),
  );
}

function pageFooter(pageLabel: string): string {
  return `<footer class="page-footer"><span>${escapeHtml(pageLabel)}</span><span>${DISCLAIMER}</span></footer>`;
}

function renderPage(className: string, pageName: string, pageLabel: string, body: string): string {
  return `<section class="page ${className}" data-page="${pageName}" aria-label="${escapeHtml(pageLabel)}"><div class="page-content">${body}</div>${pageFooter(pageLabel)}</section>`;
}

function renderCompass(): string {
  return `<div class="compass-rose" aria-hidden="true"><svg width="88" height="88" viewBox="0 0 80 80" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="40" cy="40" r="38" stroke="currentColor" stroke-width="0.75"></circle><circle cx="40" cy="40" r="32" stroke="currentColor" stroke-width="0.5" stroke-dasharray="2 4"></circle><polygon points="40,8 43,36 40,32 37,36" fill="var(--terracotta)"></polygon><polygon points="40,72 37,44 40,48 43,44" fill="currentColor" opacity="0.3"></polygon><polygon points="8,40 36,37 32,40 36,43" fill="currentColor" opacity="0.3"></polygon><polygon points="72,40 44,43 48,40 44,37" fill="currentColor" opacity="0.3"></polygon><text x="40" y="7" text-anchor="middle" font-size="6" font-family="serif" font-weight="700" fill="var(--terracotta)">N</text><text x="40" y="79" text-anchor="middle" font-size="6" font-family="serif" fill="currentColor" opacity="0.5">S</text><text x="3" y="42" text-anchor="middle" font-size="6" font-family="serif" fill="currentColor" opacity="0.5">W</text><text x="77" y="42" text-anchor="middle" font-size="6" font-family="serif" fill="currentColor" opacity="0.5">E</text><circle cx="40" cy="40" r="2.5" fill="var(--terracotta)"></circle></svg></div>`;
}

function renderDivider(): string {
  return `<div class="divider" aria-hidden="true"><svg width="240" height="20" viewBox="0 0 240 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M120 10 C100 10, 90 2, 60 2 S20 10, 0 10" stroke="currentColor" stroke-width="1" fill="none"></path><path d="M120 10 C140 10, 150 2, 180 2 S220 10, 240 10" stroke="currentColor" stroke-width="1" fill="none"></path><circle cx="120" cy="10" r="3" fill="currentColor"></circle></svg></div>`;
}

function renderSectionHeading(kicker: string, title: string): string {
  return `<header class="section-heading"><p>${escapeHtml(kicker)}</p><h2>${escapeHtml(title)}</h2></header>`;
}

function renderSchematicMap(
  route: Pick<TripPlan["route"], "outbound" | "returnPath" | "returnMode">,
  label = "路线示意图",
): string {
  const layers = buildTripMapLayers(route);
  const points = layers.flatMap((layer) => layer.points);
  if (points.length < 2) {
    return `<div class="map-placeholder"><i class="ti ti-map-off"></i><span>地图暂不可用，请按导航链接与时间轴执行。</span></div>`;
  }

  const longitudes = points.map((point) => point.longitude);
  const latitudes = points.map((point) => point.latitude);
  const minLongitude = Math.min(...longitudes);
  const maxLongitude = Math.max(...longitudes);
  const minLatitude = Math.min(...latitudes);
  const maxLatitude = Math.max(...latitudes);
  const longitudeSpan = Math.max(0.0001, maxLongitude - minLongitude);
  const latitudeSpan = Math.max(0.0001, maxLatitude - minLatitude);
  const project = ({ longitude, latitude }: (typeof points)[number]) => {
    const x = 52 + ((longitude - minLongitude) / longitudeSpan) * 536;
    const y = 250 - ((latitude - minLatitude) / latitudeSpan) * 200;
    return { x, y };
  };
  const formatPoint = ({ x, y }: { x: number; y: number }) => `${x.toFixed(1)},${y.toFixed(1)}`;
  const polylines = layers
    .map((layer) => {
      const color = layer.color.replace(/^0x/i, "#");
      const dash = layer.lineStyle === "dashed" ? ` stroke-dasharray="9 8"` : "";
      return `<polyline data-layer="${layer.kind}" points="${layer.points.map(project).map(formatPoint).join(" ")}" fill="none" stroke="${color}" stroke-width="${layer.kind === "outbound" ? 6 : 4}" stroke-linecap="round" stroke-linejoin="round"${dash}></polyline>`;
    })
    .join("");
  const markers = layers
    .flatMap((layer) =>
      layer.points.map((point) => {
        const projected = project(point);
        const color = layer.color.replace(/^0x/i, "#");
        return `<circle cx="${projected.x.toFixed(1)}" cy="${projected.y.toFixed(1)}" r="${layer.kind === "outbound" ? 7 : 6}" fill="${color}" stroke="#f8f4e9" stroke-width="3"></circle>`;
      }),
    )
    .join("");

  return `<div class="schematic-map" role="img" aria-label="${escapeHtml(label)}"><svg viewBox="0 0 640 300" xmlns="http://www.w3.org/2000/svg"><rect x="1" y="1" width="638" height="298" rx="18" fill="#f8f4e9" stroke="#d8d1c2"></rect>${[0, 1, 2, 3, 4].map((index) => `<path d="M ${80 + index * 100} 24 V 276" stroke="#e7e0d2" stroke-width="1"></path>`).join("")}${[0, 1, 2, 3].map((index) => `<path d="M 24 ${60 + index * 55} H 616" stroke="#e7e0d2" stroke-width="1"></path>`).join("")}${polylines}${markers}<text x="28" y="32" fill="#776f63" font-size="14" font-family="sans-serif">${escapeHtml(label)}</text></svg></div>`;
}

function renderMapImage(url: string | null, alt: string): string {
  if (!url) return "";
  return `<figure class="map-figure"><img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}" referrerpolicy="no-referrer" /></figure>`;
}

function renderRouteMap(plan: TripPlan, alt: string, label: string): string {
  const staticMap = plan.route.returnMode === null ? sanitizeUrl(plan.route.staticMapUrl) : null;
  return staticMap ? renderMapImage(staticMap, alt) : renderSchematicMap(plan.route, label);
}

function renderExternalLink(url: string | null | undefined, label: string): string {
  const href = sanitizeUrl(url);
  if (!href)
    return `<span class="link-disabled"><i class="ti ti-link-off"></i> 导航链接待生成</span>`;
  return `<a class="action-link" href="${escapeHtml(href)}" target="_blank" rel="noreferrer"><i class="ti ti-navigation"></i> ${escapeHtml(label)}</a>`;
}

function renderCover(plan: TripPlan): string {
  const waypointText =
    plan.meta.waypoints.length > 0 ? `途经 ${plan.meta.waypoints.join("、")}` : "直达目的地";
  const body = `<div class="cover-frame"><p class="section-label">封面</p>${renderCompass()}<h1 class="cover-title">${escapeHtml(plan.meta.title)}</h1><p class="cover-subtitle">${plan.meta.days} 天 · ${escapeHtml(travelerText(plan))} · ${escapeHtml(paceLabel(plan))}</p><p class="cover-route">${escapeHtml(routeNodesText(plan))}</p><p class="cover-tagline">从 ${escapeHtml(plan.meta.origin)} 出发，沿路收集山河、街巷与人的温度。</p><div class="cover-meta"><span><i class="ti ti-calendar"></i> ${escapeHtml(formatDate(plan.meta.startDate))}</span><span><i class="ti ti-route"></i> ${escapeHtml(waypointText)}</span><span><i class="ti ti-users"></i> ${escapeHtml(travelerText(plan))}</span></div>${renderDivider()}<p class="cover-footnote">TRAVEL GUIDEBOOK · 为真实出发而编排的行程</p></div>`;
  return renderPage("cover", "cover", "封面", body);
}

function renderOverview(plan: TripPlan): string {
  const attractionNames = uniqueValues(allAttractionNodes(plan).map((node) => node.name)).slice(
    0,
    6,
  );
  const highlightItems =
    attractionNames.length > 0
      ? attractionNames
          .map(
            (name) => `<li><i class="ti ti-star-filled"></i><span>${escapeHtml(name)}</span></li>`,
          )
          .join("")
      : `<li><i class="ti ti-route"></i><span>以每日执行节点为准，保留机动时间。</span></li>`;
  const interestItems = plan.meta.interests.length
    ? plan.meta.interests
        .map((interest) => `<span class="chip">${escapeHtml(interest)}</span>`)
        .join("")
    : `<span class="chip">自由探索</span>`;
  const body = `${renderSectionHeading("JOURNEY OVERVIEW / 出发前", "旅程概览")}<div class="overview-grid"><div class="overview-item"><i class="ti ti-calendar"></i><span>总天数</span><strong>${plan.meta.days} 天</strong></div><div class="overview-item"><i class="ti ti-route"></i><span>总里程</span><strong>${plan.route.distanceKm > 0 ? `${formatNumber(plan.route.distanceKm)} km` : "待估算"}</strong></div><div class="overview-item"><i class="ti ti-clock"></i><span>交通用时</span><strong>${plan.route.durationMinutes > 0 ? formatDuration(plan.route.durationMinutes) : "待估算"}</strong></div><div class="overview-item"><i class="ti ti-coin"></i><span>预算范围</span><strong>${currency(plan.budget.totalMin)} - ${currency(plan.budget.totalMax)}</strong></div></div><section class="overview-block"><h3>路线节奏</h3><p>${escapeHtml(plan.meta.origin)} 出发，前往 ${escapeHtml(plan.meta.destination)}。${escapeHtml(paceLabel(plan))}，${escapeHtml(transportPreferenceLabel(plan))}，同行人数为 ${escapeHtml(travelerText(plan))}。</p></section><section class="overview-block"><h3>核心亮点</h3><ul class="highlight-list">${highlightItems}</ul></section><section class="overview-block"><h3>兴趣与主题</h3><div class="chip-row">${interestItems}</div></section>${renderDivider()}`;
  return renderPage("overview", "overview", "旅程概览", body);
}

function renderSegmentCard(segment: RouteSegment, index: number): string {
  const distance = segment.distanceKm > 0 ? `${formatNumber(segment.distanceKm)} km` : "距离待估算";
  const duration =
    segment.durationMinutes > 0 ? formatDuration(segment.durationMinutes) : "用时待估算";
  return `<article class="segment-card"><div class="segment-index">${String(index + 1).padStart(2, "0")}</div><div class="segment-main"><p class="segment-route">${escapeHtml(segment.from)} <i class="ti ti-arrow-right"></i> ${escapeHtml(segment.to)}</p><div class="segment-meta"><span><i class="ti ${TRANSPORT_ICONS[segment.mode]}"></i> ${escapeHtml(TRANSPORT_LABELS[segment.mode])}</span><span><i class="ti ti-road"></i> ${escapeHtml(distance)}</span><span><i class="ti ti-clock"></i> ${escapeHtml(duration)}</span></div>${renderExternalLink(segment.navigation, "打开高德导航")}</div></article>`;
}

function renderRoute(plan: TripPlan): string {
  const map = renderRouteMap(plan, "高德全程路线地图", "全程路线示意图");
  const outbound = plan.route.outboundSegments.length
    ? plan.route.outboundSegments.map(renderSegmentCard).join("")
    : `<p class="empty-copy">去程分段暂未生成，请按路线节点和时间轴执行。</p>`;
  const returning = plan.route.returnSegments.length
    ? plan.route.returnSegments.map(renderSegmentCard).join("")
    : `<p class="empty-copy">${plan.route.returnMode === null ? "本次行程未安排返程。" : "返程分段暂未生成，请在出发前核对返程方案。"}</p>`;
  const body = `${renderSectionHeading("ROUTE & TRANSPORT / 路线与交通", "路线与交通")}<div class="route-summary"><span><i class="ti ti-map-pin"></i> ${escapeHtml(routeNodesText(plan))}</span><span><i class="ti ti-route"></i> ${plan.route.distanceKm > 0 ? `${formatNumber(plan.route.distanceKm)} km` : "总里程待估算"}</span><span><i class="ti ti-clock"></i> ${plan.route.durationMinutes > 0 ? formatDuration(plan.route.durationMinutes) : "总用时待估算"}</span></div>${map}<section class="route-block"><div class="route-block-heading"><h3>去程</h3><span class="route-line-legend outbound">实线 · 出发段</span></div><div class="segment-list">${outbound}</div></section><section class="route-block"><div class="route-block-heading"><h3>返程</h3><span class="route-line-legend return">${escapeHtml(returnModeLabel(plan))}</span></div><div class="segment-list">${returning}</div></section>`;
  return renderPage("route-page", "route", "路线与交通", body);
}

function categoryRange(category: BudgetCategory): string {
  if (category.min === category.max) return currency(category.amount);
  return `${currency(category.min)} - ${currency(category.max)}`;
}

function renderBudget(plan: TripPlan): string {
  const entries: { key: keyof TripPlan["budget"]; label: string; color: string }[] = [
    { key: "transport", label: "交通", color: "#4a7c8a" },
    { key: "lodging", label: "住宿", color: "#c96442" },
    { key: "food", label: "餐饮", color: "#d9a441" },
    { key: "tickets", label: "门票", color: "#6b8e6a" },
    { key: "other", label: "其他", color: "#8b7a9e" },
  ];
  const categories = entries.map((entry) => ({
    ...entry,
    category: plan.budget[entry.key] as BudgetCategory,
  }));
  const ratioTotal = categories.reduce(
    (sum, entry) => sum + Math.max(0, finiteNumber(entry.category.ratio)),
    0,
  );
  let cursor = 0;
  const gradientStops = categories.map((entry, index) => {
    const ratio =
      ratioTotal > 0
        ? Math.max(0, finiteNumber(entry.category.ratio)) / ratioTotal
        : 1 / categories.length;
    const start = cursor * 100;
    cursor += ratio;
    const end = index === categories.length - 1 ? 100 : cursor * 100;
    return `${entry.color} ${start}% ${end}%`;
  });
  const difference =
    plan.budget.overBudget > 0
      ? `超出 ${currency(plan.budget.overBudget)}`
      : `差额 ${currency(plan.budget.remaining)}`;
  const body = `${renderSectionHeading("BUDGET ALLOCATION / 预算分配", "预算分配")}<div class="budget-hero"><div class="budget-total"><span>全团总预算</span><strong>${currency(plan.budget.totalBudget)}</strong><small>预估费用 ${currency(plan.budget.estimatedTotal)}</small></div><div class="budget-status ${plan.budget.overBudget > 0 ? "over" : ""}">${escapeHtml(difference)}</div></div><div class="budget-layout"><div class="budget-donut" style="background:conic-gradient(${gradientStops.join(",")})" role="img" aria-label="预算构成饼图"><div><span>预计</span><strong>${currency(plan.budget.estimatedTotal)}</strong></div></div><div class="budget-entries">${categories.map((entry) => `<div class="budget-entry"><span class="budget-dot" style="background:${entry.color}"></span><span class="budget-entry-label">${entry.label}</span><strong>${categoryRange(entry.category)}</strong><small>${Math.round(Math.max(0, finiteNumber(entry.category.ratio)) * 100)}%</small></div>`).join("")}</div></div><div class="budget-notes"><p><strong>人均预算</strong> ${currency(plan.budget.perPersonBudget)}</p><p><strong>人均预计</strong> ${currency(plan.budget.perPersonEstimated)}</p><p><strong>住宿房间</strong> ${plan.budget.rooms} 间</p></div><div class="tips-box"><h3><i class="ti ti-info-circle"></i> 预算说明</h3><p>费用来自行程节点的结构化估算，可能随交通班次、酒店房态、门票政策和节假日价格变化。出发前请再次核对实际支付金额。</p></div>`;
  return renderPage("budget-page", "budget", "预算分配", body);
}

function hotelForDay(day: TripDay): TripTimelineNode | undefined {
  return day.nodes.find((node) => node.type === "hotel");
}

function mapForDay(plan: TripPlan, day: TripDay): string {
  const mapUrl = sanitizeUrl(day.mapUrl) ?? sanitizeUrl(plan.route.staticMapUrl);
  if (mapUrl) return renderMapImage(mapUrl, `${day.theme}每日地图`);
  const coordinates: Coordinate[] = day.nodes.flatMap((node) =>
    node.coordinates ? [node.coordinates] : [],
  );
  return renderSchematicMap(
    { outbound: coordinates, returnPath: [], returnMode: null },
    `${day.theme}路线示意图`,
  );
}

function renderQrBlock(day: TripDay): string {
  const qrCodeUrl = sanitizeUrl(day.qrCodeUrl);
  if (qrCodeUrl) {
    return `<figure class="qr-figure"><img src="${escapeHtml(qrCodeUrl)}" alt="${escapeHtml(`${day.theme}导航二维码`)}" referrerpolicy="no-referrer" /><figcaption>扫码打开高德导航</figcaption></figure>`;
  }
  return `<div class="qr-placeholder"><i class="ti ti-qrcode"></i><span>二维码待生成</span><small>可先使用导航链接</small></div>`;
}

function renderRadar(radar: DailyRadar): string {
  const rawScores = RADAR_AXES.map((axis) => {
    const value = finiteNumber(radar[axis.key]);
    return Math.max(0, Math.min(100, value));
  });
  const normalizedScores = normalizeRadarScores(rawScores);
  const centerX = 160;
  const centerY = 142;
  const radius = 92;
  const angleAt = (index: number) => -Math.PI / 2 + (Math.PI * 2 * index) / RADAR_AXES.length;
  const polarPoint = (index: number, value: number) => {
    const angle = angleAt(index);
    const scaledRadius = (Math.max(1, Math.min(100, value)) / 100) * radius;
    return `${(centerX + Math.cos(angle) * scaledRadius).toFixed(1)},${(centerY + Math.sin(angle) * scaledRadius).toFixed(1)}`;
  };
  const levelPolygons = [20, 40, 60, 80, 100]
    .map(
      (level) =>
        `<polygon points="${RADAR_AXES.map((_, index) => polarPoint(index, level)).join(" ")}" fill="none" stroke="#ded6c8" stroke-width="1"></polygon>`,
    )
    .join("");
  const axes = RADAR_AXES.map(
    (_, index) =>
      `<line x1="${centerX}" y1="${centerY}" x2="${polarPoint(index, 100).split(",")[0]}" y2="${polarPoint(index, 100).split(",")[1]}" stroke="#ded6c8" stroke-width="1"></line>`,
  ).join("");
  const dataPolygon = `<polygon points="${RADAR_AXES.map((_, index) => polarPoint(index, normalizedScores[index] ?? 0)).join(" ")}" fill="rgba(201,100,66,0.22)" stroke="#c96442" stroke-width="3" stroke-linejoin="round"></polygon>`;
  const labels = RADAR_AXES.map((axis, index) => {
    const angle = angleAt(index);
    const labelRadius = radius + 42;
    const x = centerX + Math.cos(angle) * labelRadius;
    const y = centerY + Math.sin(angle) * labelRadius;
    const anchor = x < centerX - 8 ? "end" : x > centerX + 8 ? "start" : "middle";
    return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="${anchor}" dominant-baseline="middle" class="radar-label"><tspan>${axis.label}</tspan><tspan x="${x.toFixed(1)}" dy="14">${rawScores[index]}</tspan></text>`;
  }).join("");
  const aria = RADAR_AXES.map((axis, index) => `${axis.label} ${rawScores[index]}`).join("，");
  return `<div class="radar-wrap"><span class="radar-scale">20 / 40 / 60 / 80 / 100</span><svg class="radar-chart" viewBox="0 0 320 292" role="img" aria-label="当日综合雷达：${escapeHtml(aria)}" xmlns="http://www.w3.org/2000/svg">${levelPolygons}${axes}${dataPolygon}${labels}</svg><p class="radar-note">分数越高，表示该项越需要关注；相对拉伸用于增强同日差异。</p></div>`;
}

function renderDayMapPage(plan: TripPlan, day: TripDay, index: number): string {
  const hotel = hotelForDay(day);
  const navigationUrl = sanitizeUrl(day.navigationUrl);
  const lodging = hotel?.location ?? hotel?.name ?? "住宿地点待确认";
  const dailyNodeCost = day.nodes.reduce((sum, node) => sum + finiteNumber(node.estimatedCost), 0);
  const body = `${renderSectionHeading(`DAY ${String(index + 1).padStart(2, "0")} / 左页`, "每日导航与准备")}<div class="day-heading"><div><p class="section-label">DAY ${String(index + 1).padStart(2, "0")}</p><h1>${escapeHtml(day.theme)}</h1></div><div class="day-heading-meta"><span><i class="ti ti-calendar"></i> ${escapeHtml(formatDate(day.date))}</span>${day.weather ? `<span><i class="ti ti-sun"></i> ${escapeHtml(day.weather)}</span>` : ""}</div></div><div class="day-left-top"><section class="day-map-block"><h3>高德每日地图</h3>${mapForDay(plan, day)}</section><div class="day-side-cards"><section class="info-card navigation-card"><h3><i class="ti ti-navigation"></i> 导航与二维码</h3>${renderExternalLink(navigationUrl, "打开当日导航")}${renderQrBlock(day)}</section><section class="info-card lodging-card"><h3><i class="ti ti-bed"></i> 今晚住宿</h3><strong>${escapeHtml(lodging)}</strong><p>${hotel ? escapeHtml(hotel.startTime ? `${hotel.startTime} 起可安排入住` : "按住宿节点办理入住") : "请在出发前确认房型和入住时间。"}</p></section><section class="info-card day-budget-card"><h3><i class="ti ti-coin"></i> 当日预算</h3><strong>${currency(day.estimatedCost)}</strong><p>时间轴节点费用合计 ${currency(dailyNodeCost)}</p></section></div></div><section class="radar-section"><div class="radar-heading"><div><p class="section-label">DAILY BALANCE / 当日负荷</p><h3>当日综合雷达</h3></div><span><i class="ti ti-chart-radar"></i> 五项关注度</span></div>${renderRadar(day.radar)}</section>`;
  return renderPage(
    "day-map-page",
    "day-left",
    `DAY ${String(index + 1).padStart(2, "0")} 导航页`,
    body,
  );
}

function renderTimelineNode(node: TripTimelineNode): string {
  const details: string[] = [];
  if (node.location)
    details.push(`<span><i class="ti ti-map-pin"></i> ${escapeHtml(node.location)}</span>`);
  if (node.transportMode) {
    details.push(
      `<span><i class="ti ${TRANSPORT_ICONS[node.transportMode]}"></i> ${escapeHtml(TRANSPORT_LABELS[node.transportMode])}</span>`,
    );
  }
  if (node.transportMinutes)
    details.push(
      `<span><i class="ti ti-clock"></i> 交通 ${formatDuration(node.transportMinutes)}</span>`,
    );
  if (node.stayMinutes)
    details.push(
      `<span><i class="ti ti-hourglass"></i> 停留 ${formatDuration(node.stayMinutes)}</span>`,
    );
  if (node.estimatedCost > 0)
    details.push(`<span><i class="ti ti-coin"></i> ${currency(node.estimatedCost)}</span>`);
  return `<li class="timeline-item node-${node.type}"><div class="timeline-time">${escapeHtml(node.timeLabel)}</div><div class="timeline-marker" aria-hidden="true"></div><article class="timeline-card"><div class="timeline-card-title"><span class="node-type">${escapeHtml(NODE_LABELS[node.type])}</span><strong>${escapeHtml(node.name)}</strong></div>${details.length ? `<div class="timeline-meta">${details.join("")}</div>` : ""}${node.tips ? `<p class="timeline-tip"><i class="ti ti-bulb"></i> ${escapeHtml(node.tips)}</p>` : ""}${renderExternalLink(node.navigation, "打开高德导航")}</article></li>`;
}

function renderTimeline(day: TripDay): string {
  if (day.nodes.length === 0)
    return `<p class="empty-copy">当日暂无执行节点，请保留机动时间并关注天气与交通变化。</p>`;
  return `<ol class="timeline">${day.nodes.map(renderTimelineNode).join("")}</ol>`;
}

function summaryFocusItems(day: TripDay): string[] {
  const attractionNames = day.nodes
    .filter((node) => node.type === "attraction" || node.type === "night-activity")
    .map((node) => node.name);
  const candidates = uniqueValues([...day.highlights, ...attractionNames, day.purpose]);
  while (candidates.length < 3) {
    candidates.push(
      candidates.length === 0 ? "按今日主题完成核心行程" : "保留机动时间，按体力和天气调整节奏",
    );
  }
  return candidates.slice(0, 3);
}

function historyBackgroundForFocus(day: TripDay, focusTitle: string): string {
  // 历史背景只能来自带来源的每日历史字段，节点提示仅用于执行信息。
  const normalizedTitle = focusTitle.trim();
  const note = day.history?.find((item) => {
    const noteTitle = item.title.trim();
    return (
      noteTitle.length > 0 &&
      (noteTitle === normalizedTitle ||
        normalizedTitle.includes(noteTitle) ||
        noteTitle.includes(normalizedTitle))
    );
  });
  const background = note?.background.trim();
  const source = note?.source.trim();

  if (!background || !source) {
    return "计划中未记录可核验的历史沿革，出发前请以景区说明、地方志或可靠史料为准。";
  }

  return `${background}（来源：${source}）`;
}

function renderDaySummary(day: TripDay, index: number): string {
  const focusItems = summaryFocusItems(day);
  const focusMarkup = focusItems
    .map((item, index) => {
      const [title, detail] = item.includes("：")
        ? item.split("：", 2)
        : [item, "结合现场导览与个人兴趣安排停留重点。"];
      const history = historyBackgroundForFocus(day, title);
      return `<li class="summary-focus-item"><span class="summary-number">${index + 1}</span><div><strong>${escapeHtml(title)}</strong><p><em>游览重点：</em>${escapeHtml(detail)}</p><p><em>历史背景：</em>${escapeHtml(history)}</p></div></li>`;
    })
    .join("");
  const cautions = uniqueValues(
    day.cautions.length > 0 ? day.cautions : ["开放时间、天气和交通班次请在出发前再次核对。"],
  );
  if (cautions.length < 2) cautions.push("预留机动时间，遇到拥堵或天气变化及时调整安排。");
  const body = `${renderSectionHeading(`DAY ${String(index + 1).padStart(2, "0")} / 执行与总结`, "执行时间轴")}<div class="day-heading compact"><div><h1>${escapeHtml(day.theme)}</h1></div><div class="day-heading-meta"><span><i class="ti ti-calendar"></i> ${escapeHtml(formatDate(day.date))}</span></div></div><section class="timeline-section">${renderTimeline(day)}</section><section class="day-summary"><h3>今日总结</h3><div class="summary-purpose"><span>今日目的</span><p>${escapeHtml(day.purpose)}</p></div><div class="summary-focus"><h4>核心重点</h4><ol>${focusMarkup}</ol></div><div class="summary-cautions"><h4>注意事项</h4><ul>${cautions
    .slice(0, 5)
    .map((caution) => `<li><i class="ti ti-alert-circle"></i> ${escapeHtml(caution)}</li>`)
    .join("")}</ul></div></section>`;
  return renderPage(
    "day-timeline-page",
    "day-right",
    `DAY ${String(index + 1).padStart(2, "0")} 执行页`,
    body,
  );
}

function renderSources(plan: TripPlan): string {
  const source = plan.closing.source?.trim();
  const quote = plan.closing.quote?.trim();
  const citation = source
    ? `<blockquote class="source-quote">${quote ? `<p>${escapeHtml(quote)}</p>` : ""}<cite>${escapeHtml(source)}</cite></blockquote>`
    : `<p class="empty-copy">本次路书未采用可核验的历史原文引用，结束语使用现代语言释义，不伪造原文或出处。</p>`;
  const body = `${renderSectionHeading("SOURCES & ESTIMATES / 可核验边界", "数据来源与估算说明")}<div class="source-grid"><section class="source-card"><h3><i class="ti ti-route"></i> 行程结构</h3><p>路线节点、时间轴、天气、预算与地图链接来自本次规划生成的 TripPlan 数据；未在页面中写入任何服务端密钥。</p></section><section class="source-card"><h3><i class="ti ti-map"></i> 地图与导航</h3><p>地图图片和导航链接仅使用 TripPlan 中已经生成的公开 URL。若地图不可用，时间轴与导航链接仍保留。</p></section><section class="source-card"><h3><i class="ti ti-calculator"></i> 时间与费用</h3><p>时间、距离和费用可能包含估算值，实际情况会受到交通班次、天气、路况、门票政策和酒店房态影响。</p></section><section class="source-card"><h3><i class="ti ti-book"></i> 历史引用</h3>${citation}</section></div><div class="tips-box"><h3><i class="ti ti-shield-check"></i> 出行前确认</h3><ul><li>再次核对景区开放时间、预约政策与交通班次。</li><li>以官方门票、酒店和道路信息作为最终支付与执行依据。</li><li>遇到天气或路况变化时，优先保证安全并调整当日节奏。</li></ul></div>`;
  return renderPage("source-page", "sources", "数据来源与估算说明", body);
}

function sameOutboundAndReturn(plan: TripPlan): boolean {
  if (plan.route.outbound.length === 0 || plan.route.returnPath.length === 0) return false;
  return JSON.stringify(plan.route.outbound) === JSON.stringify(plan.route.returnPath);
}

function routeSummaryText(plan: TripPlan): string {
  const mode = returnModeLabel(plan);
  if (plan.route.returnMode === "fast" && sameOutboundAndReturn(plan)) {
    return `${mode} · 快速原路返回`;
  }
  return mode;
}

function renderClosing(plan: TripPlan): string {
  const map = renderRouteMap(plan, "旅行回望全程地图", "旅行回望路线示意图");
  const closingQuote =
    plan.closing.source?.trim() && plan.closing.quote?.trim()
      ? `<blockquote class="closing-quote"><p>${escapeHtml(plan.closing.quote)}</p><cite>${escapeHtml(plan.closing.source)}</cite></blockquote>`
      : "";
  const summary = `<section class="reflection-card trip-summary"><h3>旅程总结</h3><p>${escapeHtml(plan.closing.message)}</p><div class="reflection-stats"><span>${plan.meta.days} 天</span><span>${plan.route.distanceKm > 0 ? `${formatNumber(plan.route.distanceKm)} km` : "里程待核验"}</span><span>${escapeHtml(routeSummaryText(plan))}</span></div></section>`;
  const body = `${renderSectionHeading("JOURNEY IN RETROSPECT / 返程与回望", "旅行回望")}${summary}<div class="closing-map">${map}</div><div class="route-legend"><span class="outbound">去程实线</span><span class="return ${plan.route.returnMode === "fast" ? "dashed" : ""}">${escapeHtml(routeSummaryText(plan))}</span>${plan.route.returnMode === null ? `<span class="single">未安排返程</span>` : ""}</div>${closingQuote}`;
  return renderPage("closing-page", "closing", "旅行回望", body);
}

function renderXuxiakePage(plan: TripPlan): string {
  const theme = "每一个丈量祖国大好河山的人，都是当代徐霞客。";
  const closingMessage = plan.closing.message.trim();
  const body = `<div class="xuxiake-frame"><p class="section-label">BACK COVER / 结束页</p>${renderCompass()}<h1 id="xuxiake-title">致当代徐霞客</h1><p class="xuxiake-theme">${theme}</p><div class="xuxiake-rule"></div><p class="xuxiake-message">${escapeHtml(closingMessage || "愿你在山河之间找到自己的方向，也把看见的地方认真记住。")}</p><div class="xuxiake-route"><span>${escapeHtml(plan.meta.origin)}</span><i class="ti ti-arrow-right"></i><span>${escapeHtml(plan.meta.destination)}</span></div><p class="xuxiake-date">${escapeHtml(formatDate(plan.meta.startDate))} · ${plan.meta.days} 天路书</p></div>`;
  return renderPage("xuxiake-page", "xuxiake", "致当代徐霞客", body);
}

const GUIDEBOOK_CSS = `@page{size:A4;margin:0}*{box-sizing:border-box}:root{--parchment:#f5f4ed;--ivory:#faf9f5;--near-black:#141413;--terracotta:#c96442;--coral:#d97757;--route-blue:#4a7c8a;--food-amber:#b8860b;--stay-olive:#6b7c5e;--alert-rust:#a0522d;--nature-sage:#8fbc8f;--text-primary:#2d2b28;--text-secondary:#524f4a;--text-tertiary:#87867f;--border-cream:#e8e6dc;--border-warm:#d1cfc5;--font-serif:'Noto Serif SC','Source Han Serif SC',serif;--font-sans:'Noto Sans SC','Source Han Sans SC',sans-serif;--font-mono:'JetBrains Mono','SF Mono','Consolas',monospace}html{background:#ded9cf}body{margin:0;color:var(--text-primary);background:var(--parchment);font-family:var(--font-sans);font-size:15px;line-height:1.7}.page{position:relative;display:flex;flex-direction:column;width:210mm;min-height:297mm;margin:0 auto 18px;padding:18mm 17mm 20mm;background-color:var(--parchment);background-image:repeating-linear-gradient(120deg,transparent,transparent 2px,rgba(139,119,90,.015) 2px,rgba(139,119,90,.015) 3px),radial-gradient(ellipse at 20% 50%,rgba(201,100,66,.03) 0%,transparent 70%),radial-gradient(ellipse at 80% 20%,rgba(184,134,11,.02) 0%,transparent 60%);box-shadow:0 12px 35px rgba(45,43,40,.13);break-after:page}.page:last-child{break-after:auto}.page-content{flex:1}.page-footer{display:flex;justify-content:space-between;gap:16px;margin-top:24px;padding-top:10px;border-top:1px solid var(--border-warm);color:var(--text-tertiary);font-family:var(--font-mono);font-size:10px;letter-spacing:.03em}.section-label,.section-heading p,.eyebrow{color:var(--terracotta);font-family:var(--font-mono);font-size:10px;letter-spacing:.16em;text-transform:uppercase}.section-heading{margin-bottom:24px}.section-heading h2{margin:4px 0 0;font-family:var(--font-serif);font-size:30px;line-height:1.25;color:var(--near-black)}h1,h2,h3,h4{font-family:var(--font-serif);line-height:1.3}h1{font-size:34px}em{color:var(--alert-rust);font-style:normal;font-weight:700}p{margin:0 0 12px}.cover{background-color:#f3efe5}.cover .page-content{display:flex;align-items:center;justify-content:center}.cover-frame{position:relative;width:100%;padding:52px 42px;border:1px solid rgba(201,100,66,.42);text-align:center;isolation:isolate}.cover-frame::before{content:"";position:absolute;inset:12px;border:1px solid rgba(201,100,66,.24);pointer-events:none;z-index:-1}.compass-rose{margin:18px auto;color:var(--text-tertiary)}.cover-title{margin:18px 0 12px;font-size:48px;color:var(--near-black)}.cover-subtitle,.cover-route,.cover-footnote{color:var(--text-secondary)}.cover-subtitle{font-family:var(--font-mono);font-size:13px}.cover-route{margin-top:16px;color:var(--terracotta);font-family:var(--font-serif);font-size:20px}.cover-tagline{max-width:440px;margin:18px auto;color:var(--text-secondary)}.cover-meta{display:flex;flex-wrap:wrap;justify-content:center;gap:8px;margin-top:24px}.cover-meta span,.chip,.route-summary span,.day-heading-meta span,.segment-meta span,.timeline-meta span{display:inline-flex;align-items:center;gap:5px;padding:4px 8px;border:1px solid var(--border-cream);border-radius:999px;background:rgba(250,249,245,.72);color:var(--text-secondary);font-family:var(--font-mono);font-size:11px}.divider{display:flex;justify-content:center;margin:28px 0;color:var(--border-warm)}.overview-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.overview-item{padding:18px;border:1px solid var(--border-cream);border-radius:12px;background:var(--ivory);box-shadow:0 0 0 1px rgba(209,207,197,.35)}.overview-item i{color:var(--terracotta);font-size:20px}.overview-item span{display:block;margin-top:8px;color:var(--text-tertiary);font-size:12px}.overview-item strong{display:block;margin-top:3px;font-family:var(--font-serif);font-size:19px}.overview-block,.route-block,.timeline-section,.source-card,.reflection-card{margin-top:24px}.overview-block h3,.route-block h3,.timeline-section h3,.source-card h3,.reflection-card h3{margin:0 0 10px;color:var(--near-black);font-size:20px}.highlight-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:0;padding:0;list-style:none}.highlight-list li{display:flex;align-items:flex-start;gap:8px;padding:10px 12px;border-left:3px solid var(--food-amber);background:rgba(250,249,245,.78)}.highlight-list i{color:var(--food-amber);margin-top:3px}.chip-row{display:flex;flex-wrap:wrap;gap:8px}.route-page .map-figure{height:220px}.route-page .map-figure img{height:100%;object-fit:cover}.route-summary{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px}.map-figure,.schematic-map,.map-placeholder{margin:0 0 18px;border:1px solid var(--border-cream);border-radius:14px;background:var(--ivory);overflow:hidden}.map-figure img,.schematic-map svg{display:block;width:100%;height:auto}.map-placeholder{display:flex;align-items:center;justify-content:center;gap:10px;min-height:180px;padding:24px;color:var(--text-tertiary)}.route-block{border-top:1px solid var(--border-warm);padding-top:18px}.route-block-heading{display:flex;align-items:center;justify-content:space-between;gap:12px}.route-line-legend{font-family:var(--font-mono);font-size:11px}.route-line-legend.outbound{color:var(--route-blue)}.route-line-legend.return{color:var(--terracotta)}.segment-list{display:grid;gap:10px}.segment-card{display:grid;grid-template-columns:38px minmax(0,1fr);gap:12px;padding:14px;border:1px solid var(--border-cream);border-radius:10px;background:rgba(250,249,245,.8)}.segment-index{color:var(--terracotta);font-family:var(--font-mono);font-size:12px}.segment-route{margin:0 0 8px;font-family:var(--font-serif);font-size:17px;color:var(--near-black)}.segment-meta,.timeline-meta{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}.action-link{display:inline-flex;align-items:center;gap:5px;color:var(--route-blue);font-family:var(--font-mono);font-size:11px;text-decoration:none}.link-disabled{display:inline-flex;align-items:center;gap:5px;color:var(--text-tertiary);font-family:var(--font-mono);font-size:11px}.budget-hero{display:flex;align-items:stretch;gap:12px;margin-bottom:24px}.budget-total{flex:1;padding:18px 20px;border-radius:12px;background:var(--near-black);color:var(--ivory)}.budget-total span,.budget-total small{display:block;color:#d8d2c8}.budget-total strong{display:block;margin:4px 0;font-family:var(--font-serif);font-size:30px}.budget-status{display:flex;align-items:center;justify-content:center;min-width:130px;padding:12px;border:1px solid rgba(95,143,117,.35);border-radius:12px;background:#e8f1eb;color:#35634d;font-weight:700}.budget-status.over{border-color:rgba(169,74,50,.35);background:#f7e8e1;color:#a54a32}.budget-layout{display:grid;grid-template-columns:190px minmax(0,1fr);gap:22px;align-items:center}.budget-donut{display:grid;place-items:center;width:180px;height:180px;border-radius:50%;box-shadow:inset 0 0 0 25px var(--parchment),0 8px 20px rgba(45,43,40,.12)}.budget-donut div{display:grid;place-items:center;width:96px;height:96px;border-radius:50%;background:var(--ivory);text-align:center}.budget-donut span{color:var(--text-tertiary);font-size:11px}.budget-donut strong{font-family:var(--font-serif);font-size:18px}.budget-entries{display:grid;gap:8px}.budget-entry{display:grid;grid-template-columns:12px minmax(0,1fr) auto 40px;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--border-cream)}.budget-entry-label{color:var(--text-secondary)}.budget-entry small{color:var(--text-tertiary);text-align:right}.budget-dot{width:10px;height:10px;border-radius:50%}.budget-notes{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:20px}.budget-notes p{margin:0;padding:12px;border:1px solid var(--border-cream);border-radius:10px;background:rgba(250,249,245,.72)}.tips-box{margin-top:20px;padding:16px 18px;border-left:4px solid var(--alert-rust);background:rgba(160,82,45,.08)}.tips-box h3{margin-top:0}.tips-box ul{margin:0;padding-left:20px}.day-map-page{padding:15mm 16mm 14mm}.day-heading{display:flex;align-items:flex-end;justify-content:space-between;gap:18px;margin-bottom:18px}.day-heading h1{margin:2px 0 0;font-size:29px}.day-heading-meta{display:flex;flex-wrap:wrap;gap:6px}.day-heading.compact{align-items:center}.day-map-block h3,.info-card h3,.radar-heading h3{margin:0 0 10px;font-size:18px}.day-left-top{display:block}.day-side-cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:10px}.day-map-block .map-figure{height:170px;margin-bottom:0}.day-map-block .map-figure img{height:100%;object-fit:cover}.day-map-block .map-placeholder{min-height:170px}.info-card{padding:15px;border:1px solid var(--border-cream);border-radius:11px;background:rgba(250,249,245,.82);break-inside:avoid}.info-card>.action-link{margin-bottom:8px}.info-card strong{display:block;margin:4px 0;font-family:var(--font-serif);font-size:18px}.info-card p{color:var(--text-secondary);font-size:12px}.day-budget-card strong{font-size:25px;color:var(--terracotta)}.qr-figure{display:flex;align-items:center;gap:10px;margin:10px 0 0}.qr-figure img{width:74px;height:74px;object-fit:contain;border:1px solid var(--border-warm);border-radius:6px;background:white}.qr-figure figcaption{color:var(--text-tertiary);font-size:11px}.qr-placeholder{display:flex;align-items:center;gap:8px;margin-top:10px;padding:10px;border:1px dashed var(--border-warm);border-radius:8px;color:var(--text-tertiary);font-size:11px}.qr-placeholder i{font-size:24px}.qr-placeholder small{display:block}.radar-section{margin-top:12px;padding-top:12px;border-top:1px solid var(--border-warm)}.radar-heading{display:flex;align-items:flex-end;justify-content:space-between;gap:16px}.radar-heading span{color:var(--text-tertiary);font-family:var(--font-mono);font-size:11px}.radar-wrap{position:relative;max-width:300px;margin:0 auto}.radar-scale{position:absolute;right:8px;top:4px;color:var(--text-tertiary);font-family:var(--font-mono);font-size:9px}.radar-chart{display:block;width:100%;height:auto}.radar-label{fill:var(--text-secondary);font-family:var(--font-mono);font-size:11px}.radar-note{margin-top:-8px;color:var(--text-tertiary);font-size:11px;text-align:center}.timeline{position:relative;display:grid;gap:14px;margin:0;padding:0;list-style:none}.timeline::before{content:"";position:absolute;top:12px;bottom:12px;left:61px;width:2px;background:var(--border-warm)}.timeline-item{position:relative;display:grid;grid-template-columns:50px 20px minmax(0,1fr);gap:7px;align-items:start}.timeline-time{padding-top:11px;color:var(--text-tertiary);font-family:var(--font-mono);font-size:10px;text-align:right}.timeline-marker{position:relative;z-index:1;width:12px;height:12px;margin:13px auto 0;border:3px solid var(--parchment);border-radius:50%;background:var(--terracotta);box-shadow:0 0 0 2px var(--border-warm)}.timeline-card{padding:13px 14px;border:1px solid var(--border-cream);border-radius:10px;background:var(--ivory);break-inside:avoid}.timeline-card-title{display:flex;align-items:flex-start;gap:8px;margin-bottom:8px}.timeline-card-title strong{font-family:var(--font-serif);font-size:17px}.node-type{padding:2px 6px;border-radius:4px;background:#eee6da;color:var(--terracotta);font-family:var(--font-mono);font-size:9px;white-space:nowrap}.timeline-tip{margin:8px 0;color:var(--text-secondary);font-size:12px}.timeline-tip i{color:var(--food-amber)}.day-summary{margin-top:28px;padding-top:22px;border-top:2px solid var(--border-warm)}.day-summary>h3{margin:0 0 14px;font-size:26px}.summary-purpose{padding:14px 16px;border-left:4px solid var(--route-blue);background:rgba(74,124,138,.08)}.summary-purpose span{color:var(--route-blue);font-family:var(--font-mono);font-size:11px}.summary-purpose p{margin:4px 0 0}.summary-focus{margin-top:18px}.summary-focus h4,.summary-cautions h4{margin:0 0 8px;font-size:18px}.summary-focus ol{display:grid;gap:10px;margin:0;padding:0;list-style:none}.summary-focus-item{display:grid;grid-template-columns:30px minmax(0,1fr);gap:10px;padding:10px;border:1px solid var(--border-cream);border-radius:9px;background:rgba(250,249,245,.7);break-inside:avoid}.summary-number{display:grid;place-items:center;width:28px;height:28px;border-radius:50%;background:var(--terracotta);color:var(--ivory);font-family:var(--font-mono);font-weight:700}.summary-focus-item strong{font-family:var(--font-serif);font-size:16px}.summary-focus-item p{margin:4px 0 0;color:var(--text-secondary);font-size:12px}.summary-cautions{margin-top:16px;padding:12px 14px;border-left:4px solid var(--alert-rust);background:rgba(160,82,45,.07)}.summary-cautions ul{margin:0;padding-left:18px}.summary-cautions li+li{margin-top:5px}.source-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.source-card{margin:0;padding:16px;border:1px solid var(--border-cream);border-radius:11px;background:rgba(250,249,245,.82);break-inside:avoid}.source-card h3 i{color:var(--terracotta)}.source-card p{color:var(--text-secondary);font-size:13px}.source-quote{margin:0;padding:10px 12px;border-left:3px solid var(--terracotta);background:rgba(201,100,66,.06)}.source-quote p{font-family:var(--font-serif);font-size:15px}.source-quote cite,.closing-quote cite{display:block;color:var(--text-tertiary);font-size:11px}.closing-map{margin-bottom:10px}.route-legend{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:18px}.route-legend span{padding:5px 9px;border:1px solid var(--border-cream);border-radius:999px;font-size:11px}.route-legend .outbound{color:var(--route-blue)}.route-legend .return{color:var(--terracotta)}.reflection-card{padding:18px;border:1px solid var(--border-cream);border-radius:12px;background:rgba(250,249,245,.82)}.reflection-card>p{font-family:var(--font-serif);font-size:18px}.reflection-stats{display:flex;flex-wrap:wrap;gap:8px;color:var(--text-tertiary);font-family:var(--font-mono);font-size:11px}.closing-quote{margin:22px 0 0;padding:18px;border-left:4px solid var(--terracotta);background:rgba(201,100,66,.06)}.closing-quote p{margin:0 0 8px;font-family:var(--font-serif);font-size:20px}.xuxiake-page{background-color:#f2ede2}.xuxiake-page .page-content{display:flex;align-items:center;justify-content:center}.xuxiake-frame{max-width:560px;text-align:center}.xuxiake-frame h1{margin:18px 0 10px;font-size:42px}.xuxiake-theme{font-family:var(--font-serif);font-size:24px;color:var(--terracotta)}.xuxiake-rule{width:160px;height:1px;margin:22px auto;background:var(--terracotta)}.xuxiake-message{font-family:var(--font-serif);font-size:18px}.xuxiake-route{display:flex;align-items:center;justify-content:center;gap:12px;margin-top:28px;font-family:var(--font-serif);font-size:18px}.xuxiake-date{margin-top:10px;color:var(--text-tertiary);font-family:var(--font-mono);font-size:11px}.empty-copy{color:var(--text-tertiary);font-size:13px}@media print{html{background:white}body{background:white}.page{width:210mm;min-height:297mm;margin:0;box-shadow:none}.page,.map-figure,.qr-figure{-webkit-print-color-adjust:exact;print-color-adjust:exact}}`;

export function renderGuidebookHtml(plan: TripPlan): string {
  const pages = [
    renderCover(plan),
    renderOverview(plan),
    renderRoute(plan),
    renderBudget(plan),
    ...plan.days.flatMap((day, index) => [
      renderDayMapPage(plan, day, index),
      renderDaySummary(day, index),
    ]),
    renderSources(plan),
    renderClosing(plan),
    renderXuxiakePage(plan),
  ];

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>${escapeHtml(plan.meta.title)}</title><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@300;400;500;700&amp;family=Noto+Serif+SC:wght@400;600;700;900&amp;family=JetBrains+Mono:wght@400;500&amp;display=swap"><link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@latest/dist/tabler-icons.min.css"><style>${GUIDEBOOK_CSS}</style></head><body>${pages.join("")}</body></html>`;
}
