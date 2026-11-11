import { describe, expect, it } from "vitest";

import type { CurrentPosition } from "../src/domain.js";
import { RouteDeviationService, rebuiltMessage } from "../src/services/route-deviation.js";

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

  const db = { vehicle: { findMany: async () => [{ id: "v1", vehicleNumber: "9724" }] } } as never;
  const at = new Date("2026-11-11T09:00:00Z");
  const rebuilt = { distanceMeters: 312_400, eta: "2026-11-11T13:20:00Z", previousEta: "2026-11-11T12:50:00Z", mainRoads: ["A7", "A38"], live: true };
  const run = async (offs: number[], reroute: (id: string, now: Date) => Promise<typeof rebuilt | null>, source = "GPS") => {
    let index = 0;
    const published: Array<{ type: string; message: string; payload: unknown }> = [];
    const service = new RouteDeviationService(db, async () => ({ ...position(offs[index]!, `2026-11-11T09:${String(index).padStart(2, "0")}:00Z`), etaSource: source } as CurrentPosition),
      async (input) => { published.push(input); }, reroute);
    for (index = 0; index < offs.length; index += 1) await service.check(at, true);
    return published;
  };

  it("on a detour the route is rebuilt and the dispatcher is only told", async () => {
    const calls: string[] = [];
    const published = await run([500, 2600, 3100], async (id) => { calls.push(id); return rebuilt; });
    expect(calls).toEqual(["v1"]);
    expect(published).toHaveLength(1);
    expect(published[0]!.message).toBe("LKW 9724 поехал по другому маршруту. Новый маршрут построен от позиции GPS: 312 км через A7, A38. ETA 14:20 (было 13:50).");
    expect(published[0]!.payload).toMatchObject({ rebuilt: true, legId: "leg-1", distanceMeters: 312_400, live: true });
  });

  it("asks the dispatcher as before when the route could not be rebuilt", async () => {
    for (const reroute of [async () => null, async () => { throw new Error("routing down"); }]) {
      const published = await run([2600, 3100], reroute);
      expect(published).toHaveLength(1);
      expect(published[0]!.message).toContain("отклонилась от маршрута");
      expect(published[0]!.message).toContain("Посмотрите варианты маршрута");
      expect(published[0]!.payload).not.toHaveProperty("rebuilt");
    }
  });

  it("a calculated position never rebuilds, and a second detour after a rebuild is told again", async () => {
    let calls = 0;
    expect(await run([2600, 3100, 3500], async () => { calls += 1; return rebuilt; }, "CALCULATED")).toHaveLength(0);
    expect(calls).toBe(0);
    // Rebuilt at the second point; the truck leaves the new line again at the fifth.
    expect(await run([2600, 3100, 200, 2700, 2900], async () => { calls += 1; return rebuilt; })).toHaveLength(2);
    expect(calls).toBe(2);
  });

  it("says when there is no traffic data, names another day and leaves out an unchanged ETA", () => {
    expect(rebuiltMessage("7", { ...rebuilt, live: false, mainRoads: [], previousEta: rebuilt.eta }, at))
      .toBe("LKW 7 поехал по другому маршруту. Новый маршрут построен от позиции GPS: 312 км. ETA 14:20. Без данных о пробках.");
    expect(rebuiltMessage("7", { ...rebuilt, eta: "2026-11-12T05:40:00Z", previousEta: null }, at)).toContain("ETA 12.11. 06:40.");
  });
});
