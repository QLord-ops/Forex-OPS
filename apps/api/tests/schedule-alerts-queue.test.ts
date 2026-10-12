import { describe, expect, it } from "vitest";
import { AlertService } from "../src/services/alerts.js";
import { EtaService } from "../src/services/eta.js";
import { assertStopActionAllowed, determineNewTourPlacement, selectNextQueuedTour } from "../src/services/tours.js";

describe("ETA schedule, alerts and queue behavior", () => {
  it("keeps a new tour queued while another tour is active", () => {
    const placement = determineNewTourPlacement([
      { id: "active-1", status: "ACTIVE", plannedStartAt: new Date("2026-09-29T08:00:00Z"), createdAt: new Date() }
    ]);

    expect(placement).toEqual({ status: "QUEUED", previousTourId: "active-1", queueIndex: 0 });
  });

  it("starts the first tour as active when the vehicle is free", () => {
    expect(determineNewTourPlacement([])).toEqual({ status: "ACTIVE", queueIndex: 0 });
  });

  it("selects the first queued tour for automatic activation after completion", () => {
    const selected = selectNextQueuedTour([
      {
        id: "queued-late",
        status: "QUEUED",
        plannedStartAt: new Date("2026-09-29T18:00:00Z"),
        createdAt: new Date("2026-09-29T07:30:00Z")
      },
      {
        id: "active-current",
        status: "ACTIVE",
        plannedStartAt: new Date("2026-09-29T08:00:00Z"),
        createdAt: new Date("2026-09-29T07:00:00Z")
      },
      {
        id: "queued-next",
        status: "QUEUED",
        plannedStartAt: new Date("2026-09-29T16:00:00Z"),
        createdAt: new Date("2026-09-29T07:20:00Z")
      }
    ]);

    expect(selected?.id).toBe("queued-next");
  });

  it("does not allow queued tour actions or repeated stop confirmations", () => {
    expect(() => assertStopActionAllowed(null, "QUEUED")).toThrow("активных маршрутов");
    expect(() => assertStopActionAllowed(new Date("2026-09-29T10:00:00Z"), "ACTIVE")).toThrow("уже подтверждена");
    expect(() => assertStopActionAllowed(null, "ACTIVE")).toThrow("подтвердить прибытие");
    expect(() => assertStopActionAllowed(null, "ACTIVE", new Date())).not.toThrow();
  });

  it("calculates a chained schedule across active and queued tours", () => {
    const service = new EtaService();
    const schedule = service.calculateVehicleSchedule(
      [
        {
          id: "tour-1",
          status: "ACTIVE",
          plannedStartAt: new Date("2026-09-29T08:00:00Z"),
          createdAt: new Date("2026-09-29T07:00:00Z"),
          stops: [
            completedStop("load-1", 1, "LOAD", "Göttingen", "2026-09-29T08:00:00Z", "2026-09-29T09:17:00Z"),
            openStop("unload-1", 2, "UNLOAD", "Zwickau", "2026-09-29T13:00:00Z")
          ],
          legs: [
            {
              fromStopId: "load-1",
              toStopId: "unload-1",
              startedAt: new Date("2026-09-29T09:17:00Z"),
              simulatedDurationSeconds: 3 * 3600,
              status: "ACTIVE",
              createdAt: new Date("2026-09-29T08:00:00Z")
            }
          ]
        },
        {
          id: "tour-2",
          status: "QUEUED",
          plannedStartAt: new Date("2026-09-29T16:00:00Z"),
          createdAt: new Date("2026-09-29T07:30:00Z"),
          stops: [openStop("load-2", 1, "LOAD", "Leipzig", "2026-09-29T16:00:00Z")],
          legs: []
        }
      ] as never,
      new Date("2026-09-29T10:00:00Z")
    );

    expect(schedule[0].predictedEta.toISOString()).toBe("2026-09-29T12:17:00.000Z");
    expect(schedule[0].predictedDelayMinutes).toBe(0);
    expect(schedule[1].earliestArrival.toISOString()).toBe("2026-09-29T14:00:00.000Z");
    expect(schedule[1].latestArrival.toISOString()).toBe("2026-09-29T15:00:00.000Z");
    expect(schedule[1].earliestDeparture.toISOString()).toBe("2026-09-29T17:00:00.000Z");
  });

  it("adds transfer time from the previous final stop to the first queued stop", () => {
    const service = new EtaService();
    const schedule = service.calculateVehicleSchedule(
      [
        {
          id: "tour-1",
          status: "ACTIVE",
          plannedStartAt: new Date("2026-09-29T08:00:00Z"),
          createdAt: new Date("2026-09-29T07:00:00Z"),
          stops: [
            completedStop("load-1", 1, "LOAD", "Göttingen", "2026-09-29T08:00:00Z", "2026-09-29T09:17:00Z"),
            openStop("unload-1", 2, "UNLOAD", "Zwickau", "2026-09-29T14:00:00Z")
          ],
          legs: [
            {
              fromStopId: "load-1",
              toStopId: "unload-1",
              startedAt: new Date("2026-09-29T12:00:00Z"),
              simulatedDurationSeconds: 9600,
              status: "ACTIVE",
              createdAt: new Date("2026-09-29T08:00:00Z")
            }
          ]
        },
        {
          id: "tour-2",
          status: "QUEUED",
          plannedStartAt: new Date("2026-09-29T16:00:00Z"),
          createdAt: new Date("2026-09-29T07:30:00Z"),
          stops: [openStop("load-2", 1, "LOAD", "Leipzig", "2026-09-29T16:00:00Z")],
          legs: [
            {
              fromStopId: "unload-1",
              toStopId: "load-2",
              startedAt: null,
              simulatedDurationSeconds: 5100,
              status: "WAITING",
              createdAt: new Date("2026-09-29T07:31:00Z")
            }
          ]
        }
      ] as never,
      new Date("2026-09-29T13:00:00Z")
    );

    expect(schedule[0].predictedEta.toISOString()).toBe("2026-09-29T14:40:00.000Z");
    expect(schedule[1].predictedEta.toISOString()).toBe("2026-09-29T17:05:00.000Z");
    expect(schedule[1].latestArrival.toISOString()).toBe("2026-09-29T18:05:00.000Z");
    expect(schedule[1].predictedDelayMinutes).toBe(125);
  });

  it("keeps an arrived leg ETA anchored to its actual start instead of adding the full trip to now", () => {
    const service = new EtaService();
    const schedule = service.calculateVehicleSchedule(
      [
        {
          id: "tour-arrived",
          status: "ACTIVE",
          plannedStartAt: new Date("2026-09-29T08:00:00Z"),
          createdAt: new Date("2026-09-29T07:00:00Z"),
          stops: [
            completedStop("load-arrived", 1, "LOAD", "Göttingen", "2026-09-29T08:00:00Z", "2026-09-29T08:00:00Z"),
            openStop("unload-arrived", 2, "UNLOAD", "Zwickau", "2026-09-29T11:00:00Z")
          ],
          legs: [
            {
              fromStopId: "load-arrived",
              toStopId: "unload-arrived",
              startedAt: new Date("2026-09-29T08:00:00Z"),
              simulatedDurationSeconds: 3 * 3600,
              status: "ARRIVED",
              createdAt: new Date("2026-09-29T08:00:00Z")
            }
          ]
        }
      ] as never,
      new Date("2026-10-05T12:00:00Z")
    );

    expect(schedule[0].predictedEta.toISOString()).toBe("2026-09-29T11:00:00.000Z");
    expect(schedule[0].predictedDelayMinutes).toBe(0);
    expect(schedule[0].earliestDeparture.toISOString()).toBe("2026-10-05T12:00:00.000Z");
  });

  it("creates at most one TWO_HOURS or ONE_HOUR alert per stop", async () => {
    const upserts: Array<{ type: string; stopId: string }> = [];
    const resolvedIds: string[][] = [];
    let openAlerts: Array<{ id: string; stopId: string; type: string }> = [];
    const db = {
      alert: {
        findMany: async () => openAlerts,
        updateMany: async (args: { where: { id: { in: string[] } } }) => {
          resolvedIds.push(args.where.id.in);
          openAlerts = openAlerts.filter((alert) => !args.where.id.in.includes(alert.id));
          return { count: args.where.id.in.length };
        },
        upsert: async (args: { where: { stopId_type: { stopId: string; type: string } } }) => {
          upserts.push(args.where.stopId_type);
          openAlerts = [
            ...openAlerts.filter(
              (alert) =>
                alert.stopId !== args.where.stopId_type.stopId || alert.type !== args.where.stopId_type.type
            ),
            {
              id: `alert-${args.where.stopId_type.type}`,
              stopId: args.where.stopId_type.stopId,
              type: args.where.stopId_type.type
            }
          ];
          return args.where.stopId_type;
        }
      }
    };

    const service = new AlertService(db as never);
    await service.refreshVehicleAlerts(
      "vehicle-1",
      [
        {
          vehicleId: "vehicle-1",
          tourId: "tour-1",
          stopId: "stop-1",
          sequence: 2,
          type: "UNLOAD",
          address: "Zwickau",
          appointmentAt: new Date("2026-09-29T12:00:00Z"),
          earliestArrival: new Date("2026-09-29T12:45:00Z"),
          earliestDeparture: new Date("2026-09-29T12:45:00Z"),
          predictedEta: new Date("2026-09-29T12:45:00Z"),
          predictedDelayMinutes: 45,
          riskColor: "RED",
          tourStatus: "ACTIVE"
        }
      ] as never,
      new Date("2026-09-29T10:30:00Z")
    );
    await service.refreshVehicleAlerts(
      "vehicle-1",
      [
        {
          vehicleId: "vehicle-1",
          tourId: "tour-1",
          stopId: "stop-1",
          sequence: 2,
          type: "UNLOAD",
          address: "Zwickau",
          appointmentAt: new Date("2026-09-29T12:00:00Z"),
          earliestArrival: new Date("2026-09-29T12:45:00Z"),
          earliestDeparture: new Date("2026-09-29T12:45:00Z"),
          predictedEta: new Date("2026-09-29T12:45:00Z"),
          predictedDelayMinutes: 45,
          riskColor: "RED",
          tourStatus: "ACTIVE"
        }
      ] as never,
      new Date("2026-09-29T11:15:00Z")
    );

    expect(upserts).toEqual([
      { stopId: "stop-1", type: "TWO_HOURS" },
      { stopId: "stop-1", type: "ONE_HOUR" }
    ]);
    expect(resolvedIds).toEqual([["alert-TWO_HOURS"]]);
  });

  it("resolves an open alert when a stop is no longer at risk", async () => {
    const resolvedIds: string[][] = [];
    const db = {
      alert: {
        findMany: async () => [{ id: "alert-1", stopId: "stop-1", type: "ONE_HOUR" }],
        updateMany: async (args: { where: { id: { in: string[] } } }) => {
          resolvedIds.push(args.where.id.in);
          return { count: args.where.id.in.length };
        },
        upsert: async () => {
          throw new Error("No alert should be created");
        }
      }
    };

    const service = new AlertService(db as never);
    await service.refreshVehicleAlerts("vehicle-1", [], new Date("2026-09-29T11:15:00Z"));

    expect(resolvedIds).toEqual([["alert-1"]]);
  });
});

function openStop(id: string, sequence: number, type: "LOAD" | "UNLOAD", address: string, appointmentAt: string) {
  return {
    id,
    sequence,
    type,
    address,
    appointmentAt: new Date(appointmentAt),
    completedAt: null
  };
}

function completedStop(
  id: string,
  sequence: number,
  type: "LOAD" | "UNLOAD",
  address: string,
  appointmentAt: string,
  completedAt: string
) {
  return {
    ...openStop(id, sequence, type, address, appointmentAt),
    completedAt: new Date(completedAt)
  };
}
