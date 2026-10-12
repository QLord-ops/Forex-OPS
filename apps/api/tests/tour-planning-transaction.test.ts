import { describe, expect, it, vi } from "vitest";
import { TourService, type CreateTourInput } from "../src/services/tours.js";

describe("tour planning transaction boundary", () => {
  it("preserves downstream transfer legs by rejecting edits to an intermediate tour", async () => {
    const fixture = planningFixture();
    Object.assign(fixture.state.current, { nextTours: [{ id: "next-tour" }] });
    await expect(fixture.service.updateFutureTour("editing-tour", input())).rejects.toMatchObject({ statusCode: 409 });
    expect(fixture.db.$transaction).not.toHaveBeenCalled();
  });
  it("resolves every address and road route before starting a create transaction", async () => {
    const fixture = planningFixture();
    await fixture.service.createTour(input());

    expect(fixture.routing.geocode).toHaveBeenCalledTimes(3);
    expect(fixture.routing.calculateRoute).toHaveBeenCalledTimes(3);
    expect(fixture.db.$transaction).toHaveBeenCalledTimes(1);
    expect(fixture.tx.stop.create).toHaveBeenCalledTimes(3);
    expect(fixture.tx.leg.create.mock.calls.map(([args]) => [args.data.fromStopId, args.data.toStopId])).toEqual([
      ["previous-stop", "new-stop-1"],
      ["new-stop-1", "new-stop-2"],
      ["new-stop-2", "new-stop-3"]
    ]);
    expect(fixture.tx.leg.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ distanceMeters: 1000, routingDurationSeconds: 120 })
    }));
  });

  it("does not start a write transaction when route preparation fails", async () => {
    const fixture = planningFixture();
    fixture.routing.calculateRoute.mockRejectedValueOnce(new Error("OSRM unavailable"));

    await expect(fixture.service.createTour(input())).rejects.toThrow("OSRM unavailable");
    expect(fixture.db.$transaction).not.toHaveBeenCalled();
    expect(fixture.tx.tour.create).not.toHaveBeenCalled();
  });

  it("rejects a changed queue before persisting a prepared tour", async () => {
    const fixture = planningFixture();
    fixture.onRoute = () => { fixture.state.openTours = []; };

    await expect(fixture.service.createTour(input())).rejects.toMatchObject({ statusCode: 409 });
    expect(fixture.tx.tour.create).not.toHaveBeenCalled();
    expect(fixture.tx.stop.create).not.toHaveBeenCalled();
  });

  it("rejects changes to the previous final stop before persisting its transfer route", async () => {
    const fixture = planningFixture();
    fixture.onRoute = () => { fixture.state.previousTour.stops[0].latitude = 49; };

    await expect(fixture.service.createTour(input())).rejects.toMatchObject({ statusCode: 409 });
    expect(fixture.tx.tour.create).not.toHaveBeenCalled();
  });

  it("prepares update routes before deleting the old plan and keeps all writes transactional", async () => {
    const fixture = planningFixture();
    await fixture.service.updateFutureTour("editing-tour", input());

    expect(fixture.routing.calculateRoute).toHaveBeenCalledTimes(3);
    expect(fixture.tx.stop.deleteMany).toHaveBeenCalledOnce();
    expect(fixture.tx.leg.deleteMany).toHaveBeenCalledOnce();
    expect(fixture.tx.alert.deleteMany).toHaveBeenCalledOnce();
    expect(fixture.tx.tour.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "QUEUED", previousTourId: "previous-tour" })
    }));
  });

  it("preserves the existing plan on update routing failure", async () => {
    const fixture = planningFixture();
    fixture.routing.calculateRoute.mockRejectedValueOnce(new Error("OSRM unavailable"));

    await expect(fixture.service.updateFutureTour("editing-tour", input())).rejects.toThrow("OSRM unavailable");
    expect(fixture.db.$transaction).not.toHaveBeenCalled();
    expect(fixture.tx.stop.deleteMany).not.toHaveBeenCalled();
  });

  it("rechecks editability after preparation and preserves a tour activated in the meantime", async () => {
    const fixture = planningFixture();
    fixture.onRoute = () => { fixture.state.current.status = "ACTIVE"; };

    await expect(fixture.service.updateFutureTour("editing-tour", input())).rejects.toMatchObject({ statusCode: 409 });
    expect(fixture.tx.stop.deleteMany).not.toHaveBeenCalled();
    expect(fixture.tx.tour.update).not.toHaveBeenCalled();
  });

  it("rejects a concurrent edit before replacing the existing stops", async () => {
    const fixture = planningFixture();
    fixture.onRoute = () => { fixture.state.current.orderNumber = "CHANGED"; };

    await expect(fixture.service.updateFutureTour("editing-tour", input())).rejects.toMatchObject({ statusCode: 409 });
    expect(fixture.tx.stop.deleteMany).not.toHaveBeenCalled();
  });
});

function input(): CreateTourInput {
  return {
    vehicleId: "vehicle-1",
    orderNumber: "IMPORT-1",
    stops: ["Berlin", "Hannover", "Hamburg"].map((address, index) => ({
      sequence: index + 1,
      type: index === 0 ? "LOAD" : "UNLOAD",
      address,
      appointmentAt: `2026-10-07T${10 + index}:00:00.000Z`
    }))
  };
}

function planningFixture() {
  let inTransaction = false;
  let stopIndex = 0;
  const previousTour = {
    id: "previous-tour",
    vehicleId: "vehicle-1",
    status: "ACTIVE",
    plannedStartAt: new Date("2026-10-06T08:00:00Z"),
    createdAt: new Date("2026-10-06T07:00:00Z"),
    stops: [{ id: "previous-stop", latitude: 51, longitude: 10 }]
  };
  const state = {
    vehicle: { id: "vehicle-1", maxSpeedKmh: 85 },
    openTours: [previousTour],
    previousTour,
    current: {
      id: "editing-tour",
      vehicleId: "vehicle-1",
      orderNumber: "BEFORE",
      status: "QUEUED",
      previousTourId: "previous-tour",
      stops: [{ id: "old-stop", completedAt: null }],
      events: [],
      nextTours: []
    }
  };
  const vehicleReads = { findUniqueOrThrow: vi.fn(async () => structuredClone(state.vehicle)) };
  const tourReads = {
    findMany: vi.fn(async () => structuredClone(state.openTours)),
    findUnique: vi.fn(async (args: { where: { id: string } }) => structuredClone(
      args.where.id === "previous-tour" ? state.previousTour : state.current
    )),
    findUniqueOrThrow: vi.fn(async () => ({ id: "result-tour" }))
  };
  const write = (result: unknown = {}) => vi.fn(async (_args: unknown) => {
    expect(inTransaction).toBe(true);
    return result;
  });
  const tx = {
    vehicle: vehicleReads,
    tour: { ...tourReads, create: write({ id: "new-tour" }), update: write() },
    stop: {
      create: vi.fn(async (_args: unknown) => {
        expect(inTransaction).toBe(true);
        stopIndex += 1;
        return { id: `new-stop-${stopIndex}` };
      }),
      deleteMany: write()
    },
    leg: {
      create: vi.fn(async (_args: { data: { fromStopId: string; toStopId: string } }) => {
        expect(inTransaction).toBe(true);
        return {};
      }),
      deleteMany: write()
    },
    alert: { deleteMany: write() }
  };
  const db = {
    vehicle: vehicleReads,
    tour: tourReads,
    $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => {
      inTransaction = true;
      try {
        return await callback(tx);
      } finally {
        inTransaction = false;
      }
    })
  };
  const controls = { onRoute: () => {} };
  const routing = {
    geocode: vi.fn(async (address: string) => {
      expect(inTransaction).toBe(false);
      return { label: address, latitude: 52, longitude: 13, provider: "test" };
    }),
    calculateRoute: vi.fn(async () => {
      expect(inTransaction).toBe(false);
      controls.onRoute();
      return {
        geometry: [{ latitude: 51, longitude: 10 }, { latitude: 52, longitude: 13 }],
        distanceMeters: 1000,
        durationSeconds: 120,
        provider: "test"
      };
    }),
    calculateMultiStopRoute: vi.fn()
  };
  return {
    state, tx, db, routing,
    service: new TourService(db as never, routing),
    set onRoute(callback: () => void) { controls.onRoute = callback; }
  };
}
