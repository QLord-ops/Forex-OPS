import type { PrismaClient } from "@prisma/client";
import { coverResolver } from "./covers.js";
import { isMine } from "./customers.js";

/**
 * Who may change a truck (owner, 24.11.2026): «диспетчер не может менять чужие машины». A dispatcher changes only their
 * own — the trucks they took and the free trucks of their lines, a cover included (`isMine`). The admin and the shared
 * login change every truck. Until now this held only on the screen.
 *
 * Settings of the truck itself stay open to every dispatcher (owner, same day: «диспетчер и админ»): number and plate,
 * line, status settings, truck profile. Taking, releasing and handing over a truck have their own rules.
 */
const OPEN_ROUTES = new Set([
  "/vehicles/:id",
  "/vehicles/:id/assignment",
  "/vehicles/:id/customer-line",
  "/vehicles/:id/status-settings",
  "/vehicles/:id/truck-profile",
  // Calculations only: nothing is saved.
  "/vehicles/:id/route-options",
  "/tours/:id/replan/preview",
  "/stops/:id/appointment/preview"
]);

/** A new tour for a truck: the truck is named in the body. */
const BODY_VEHICLE_ROUTES = new Set(["/tours", "/imports/tours/confirm"]);

export type OwnershipTarget = { kind: "vehicle" | "tour" | "stop"; id: string };

/** Which truck a changing request is about, or null when the rule does not apply to it. */
export function ownershipTarget(method: string, route: string, params: unknown, body: unknown): OwnershipTarget | null {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return null;
  if (OPEN_ROUTES.has(route)) return null;
  const id = typeof params === "object" && params !== null && typeof (params as { id?: unknown }).id === "string" ? (params as { id: string }).id : null;
  if (id && route.startsWith("/vehicles/:id")) return { kind: "vehicle", id };
  if (id && route.startsWith("/tours/:id")) return { kind: "tour", id };
  if (id && route.startsWith("/stops/:id")) return { kind: "stop", id };
  if (BODY_VEHICLE_ROUTES.has(route) && typeof body === "object" && body !== null) {
    const vehicleId = (body as { vehicleId?: unknown }).vehicleId;
    if (typeof vehicleId === "string" && vehicleId) return { kind: "vehicle", id: vehicleId };
  }
  return null;
}

export async function vehicleOfTarget(db: PrismaClient, target: OwnershipTarget): Promise<string | null> {
  if (target.kind === "vehicle") return target.id;
  if (target.kind === "tour") return (await db.tour.findUnique({ where: { id: target.id }, select: { vehicleId: true } }))?.vehicleId ?? null;
  return (await db.stop.findUnique({ where: { id: target.id }, select: { tour: { select: { vehicleId: true } } } }))?.tour.vehicleId ?? null;
}

/** True when this dispatcher looks after the truck now: took it, or it is free on one of their lines (covers count). */
export async function mayChangeVehicle(db: PrismaClient, dispatcherId: string, vehicleId: string, now = new Date()): Promise<boolean> {
  const vehicle = await db.vehicle.findUnique({ where: { id: vehicleId }, select: { assignedDispatcherId: true, customerLineId: true } });
  if (!vehicle) return true;
  const resolver = await coverResolver(db, now);
  return isMine(dispatcherId, resolver.vehicle(vehicle), await resolver.linesOf(db, dispatcherId));
}

export const NOT_YOUR_VEHICLE = "Это машина коллеги: изменить её может тот, кто её ведёт, или админ. Свободную машину сначала возьмите себе.";
