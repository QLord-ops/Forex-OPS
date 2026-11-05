export type NotificationPriority = "ACTION" | "RISK" | "INFO";

export type PriorityInput = {
  id: string;
  vehicleId: string;
  stopId: string | null;
  type: string;
  payloadJson: string;
  createdAt: Date;
};

export type StopFacts = {
  id: string;
  type: string;
  arrivedAt: Date | null;
  completedAt: Date | null;
  appointmentAt: Date | null;
  appointmentWindowStartAt: Date | null;
};

export type PriorityFacts = {
  stops: Map<string, StopFacts>;
  /** Leg id → the stop the leg drives to. */
  legTarget: Map<string, string>;
};

export type Prioritized<T> = T & {
  priority: NotificationPriority;
  urgent: boolean;
  resolved: boolean;
  resolvedReason: string | null;
};

const ORDER: Record<NotificationPriority, number> = { ACTION: 0, RISK: 1, INFO: 2 };

function payloadOf(json: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(json);
    return value && typeof value === "object" ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

const doneLabel = (stop: StopFacts) => stop.type === "UNLOAD" ? "ENTLADEN уже отмечен" : "BELADEN уже отмечен";

/** Ids of the items that a later one of the same kind replaces: only the newest jam per stop and deviation per truck count. */
function supersededIds(items: PriorityInput[]) {
  const newest = new Map<string, PriorityInput>();
  for (const item of items) {
    const key = item.type === "TRAFFIC_DELAY" ? `traffic:${item.stopId ?? item.vehicleId}`
      : item.type === "ROUTE_DEVIATION" ? `deviation:${item.vehicleId}` : null;
    if (!key) continue;
    const current = newest.get(key);
    if (!current || item.createdAt > current.createdAt) newest.set(key, item);
  }
  const winners = new Set([...newest.values()].map((item) => item.id));
  return new Set(items.filter((item) => (item.type === "TRAFFIC_DELAY" || item.type === "ROUTE_DEVIATION") && !winners.has(item.id)).map((item) => item.id));
}

function classify(item: PriorityInput, facts: PriorityFacts, superseded: Set<string>, now: Date) {
  const payload = payloadOf(item.payloadJson);
  const stop = item.stopId ? facts.stops.get(item.stopId) ?? null : null;
  const completed = stop?.completedAt ? doneLabel(stop) : null;
  switch (item.type) {
    case "STOP_DEPARTED":
      return { priority: "ACTION" as const, urgent: true, reason: completed };
    case "PREVIOUS_TOUR_OPEN": {
      const open = typeof payload.openStopId === "string" ? facts.stops.get(payload.openStopId) : stop;
      return { priority: "ACTION" as const, urgent: false, reason: open?.completedAt ? "прошлый тур закрыт" : null };
    }
    case "APPOINTMENT_MATCH":
      return { priority: "ACTION" as const, urgent: false, reason: null };
    case "LONG_DWELL": {
      const critical = payload.severity === "CRITICAL";
      return { priority: critical ? "ACTION" as const : "RISK" as const, urgent: critical, reason: completed };
    }
    case "ROUTE_DEVIATION": {
      const target = typeof payload.legId === "string" ? facts.stops.get(facts.legTarget.get(payload.legId) ?? "") : null;
      const reason = superseded.has(item.id) ? "есть новее" : target?.arrivedAt ? "машина уже на точке" : null;
      return { priority: "ACTION" as const, urgent: false, reason };
    }
    case "PREDICTED_ARRIVAL":
      return { priority: "RISK" as const, urgent: false, reason: stop?.arrivedAt ? "прибытие уже записано" : null };
    case "TRAFFIC_DELAY":
      return { priority: "RISK" as const, urgent: false, reason: superseded.has(item.id) ? "есть новее" : stop?.arrivedAt ? "машина уже на точке" : null };
    case "TERMIN_MET":
      return { priority: payload.onTime === false ? "RISK" as const : "INFO" as const, urgent: false, reason: null };
    case "AUTO_ARRIVAL":
      return { priority: "INFO" as const, urgent: false, reason: completed };
    case "DAILY_REST_AT_STOP": {
      const ended = typeof payload.until === "string" && Date.parse(payload.until) <= now.getTime();
      return { priority: "INFO" as const, urgent: false, reason: completed ?? (ended ? "отдых закончился" : null) };
    }
    default:
      return { priority: "RISK" as const, urgent: false, reason: null };
  }
}

const terminOf = (stop: StopFacts | null | undefined) => (stop?.appointmentAt ?? stop?.appointmentWindowStartAt)?.getTime() ?? Number.POSITIVE_INFINITY;

/**
 * What the dispatcher should see first, e.g. in the morning after the night: decisions, then risks, then information.
 * Nothing is closed here; items that no longer apply only move down into «Для сведения».
 */
export function prioritize<T extends PriorityInput>(items: T[], facts: PriorityFacts, now = new Date()): Array<Prioritized<T>> {
  const superseded = supersededIds(items);
  return items
    .map((item) => {
      const { priority, urgent, reason } = classify(item, facts, superseded, now);
      return { ...item, priority: reason ? "INFO" as const : priority, urgent: urgent && !reason, resolved: reason !== null, resolvedReason: reason };
    })
    .sort((a, b) => ORDER[a.priority] - ORDER[b.priority]
      || Number(a.resolved) - Number(b.resolved)
      || Number(b.urgent) - Number(a.urgent)
      || terminOf(a.stopId ? facts.stops.get(a.stopId) : null) - terminOf(b.stopId ? facts.stops.get(b.stopId) : null)
      || a.createdAt.getTime() - b.createdAt.getTime());
}
