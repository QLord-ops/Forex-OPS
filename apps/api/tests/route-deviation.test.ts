import { describe, expect, it } from "vitest";

import type { CurrentPosition } from "../src/domain.js";
import { RouteDeviationService } from "../src/services/route-deviation.js";

function position(offRouteMeters: number, recordedAt: string): CurrentPosition {
  return { etaSource: "GPS", offRouteMeters, telemetryRecordedAt: recordedAt, legId: "leg-1" } as CurrentPosition;
}

describe("route deviation", () => {
  it("reports once after two GPS points beyond 2 km, and again only after coming back", async () => {
    const offs = [500, 2600, 2600, 3100, 3500, 400, 2500, 2700];
    let index = 0;
    const published: Array<{ type: string; message: string }> = [];
    const db = { vehicle: { findMany: async () => [{ id: "v1", vehicleNumber: "9724" }] } } as never;
    const service = new RouteDeviationService(db, async () => position(offs[index], `2026-11-04T09:${String(index).padStart(2, "0")}:00Z`),
      async (input) => { published.push(input); });
    for (index = 0; index < offs.length; index += 1) await service.check(new Date(), true);
    expect(published).toHaveLength(2);
    expect(published[0]).toMatchObject({ type: "ROUTE_DEVIATION" });
    expect(published[0].message).toContain("LKW 9724 отклонилась от маршрута");
  });

  it("counts each GPS point once and ignores calculated positions", async () => {
    const published: unknown[] = [];
    const db = { vehicle: { findMany: async () => [{ id: "v1", vehicleNumber: "1" }] } } as never;
    const same = new RouteDeviationService(db, async () => position(5000, "2026-11-04T09:00:00Z"), async (input) => { published.push(input); });
    for (let i = 0; i < 4; i += 1) await same.check(new Date(), true);
    const calculated = new RouteDeviationService(db, async () => ({ etaSource: "CALCULATED", offRouteMeters: null } as unknown as CurrentPosition), async (input) => { published.push(input); });
    for (let i = 0; i < 4; i += 1) await calculated.check(new Date(), true);
    expect(published).toHaveLength(0);
  });
});
