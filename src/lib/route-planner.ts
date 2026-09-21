export type TransportMode = "economy" | "balanced" | "speed" | "train" | "flight" | "drive" | "bus" | "ship";
export type TravelStyle = "direct" | "wander";
export type ReturnMode = "scenic" | "fast";

export type RouteLeg = {
  id: string;
  from: string;
  to: string;
  transport: TransportMode;
  style: TravelStyle;
  kind: "outbound" | "return";
};

export type RoutePlan = {
  origin: string;
  destination: string;
  waypoints: string[];
  roundTrip: boolean;
  returnMode: ReturnMode | null;
  legs: RouteLeg[];
};

export type TransportPriceReference = {
  legId: string;
  from: string;
  to: string;
  mode: TransportMode;
  distanceKm: number;
  minimumUnitPrice: number;
  minimumPartyTotal: number;
  travelerCount: number;
  basis: string;
  sources: {
    title: string;
    url: string;
    content: string;
  }[];
};

export type RouteLegPreference = {
  transport?: TransportMode;
  style?: TravelStyle;
};

export type RoutePlanInput = {
  origin: string;
  destination: string;
  waypoints: string[];
  roundTrip: boolean;
  returnMode: ReturnMode | null;
  defaultStyle: TravelStyle;
  legPreferences: Record<string, RouteLegPreference>;
};

export function removeWaypointAt(waypoints: string[], index: number): string[] {
  return waypoints.filter((_, itemIndex) => itemIndex !== index);
}

export function buildRoutePlan(input: RoutePlanInput): RoutePlan {
  const origin = input.origin.trim();
  const destination = input.destination.trim();
  const waypoints = input.waypoints.map((waypoint) => waypoint.trim()).filter(Boolean);

  if (waypoints.length > 5) {
    throw new Error("最多设置 5 个途经点");
  }
  if (!origin) throw new Error("请填写出发地");
  if (!destination) throw new Error("请填写目的地");

  const nodes = [origin, ...waypoints, destination];
  const legs: RouteLeg[] = nodes.slice(0, -1).map((from, index) => {
    const id = `outbound:${index}`;
    const preference = input.legPreferences[id];
    return {
      id,
      from,
      to: nodes[index + 1],
      transport: preference?.transport ?? "balanced",
      style: preference?.style ?? input.defaultStyle,
      kind: "outbound",
    };
  });

  if (input.roundTrip) {
    const preference = input.legPreferences.return;
    legs.push({
      id: "return",
      from: destination,
      to: origin,
      transport: preference?.transport ?? "balanced",
      style:
        preference?.style ??
        (input.returnMode === "scenic" ? "wander" : "direct"),
      kind: "return",
    });
  }

  return {
    origin,
    destination,
    waypoints,
    roundTrip: input.roundTrip,
    returnMode: input.roundTrip ? input.returnMode ?? "fast" : null,
    legs,
  };
}
