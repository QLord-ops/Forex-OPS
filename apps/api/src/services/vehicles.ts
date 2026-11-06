import type { Prisma, PrismaClient } from "@prisma/client";
import { tourInclude } from "./tours.js";

export type CreateVehicleInput = {
  vehicleNumber: string;
  licensePlate?: string;
  maxSpeedKmh: number;
};

export class VehicleService {
  constructor(private readonly db: PrismaClient) {}

  list() {
    return this.db.vehicle.findMany({
      include: { tours: { where: { status: { in: ["ACTIVE", "QUEUED"] } }, orderBy: { plannedStartAt: "asc" } } },
      orderBy: { vehicleNumber: "asc" }
    });
  }

  create(input: CreateVehicleInput) {
    return this.db.vehicle.create({ data: input });
  }

  /** Number, plate and speed limit; the changed fields come back for the audit log. Another truck with that number → 409. */
  async update(id: string, patch: Partial<CreateVehicleInput>) {
    const current = await this.db.vehicle.findUniqueOrThrow({ where: { id }, select: { vehicleNumber: true, licensePlate: true, maxSpeedKmh: true } });
    const data: Partial<CreateVehicleInput> = {};
    if (patch.vehicleNumber !== undefined && patch.vehicleNumber !== current.vehicleNumber) data.vehicleNumber = patch.vehicleNumber;
    if (patch.licensePlate !== undefined && (patch.licensePlate || null) !== current.licensePlate) data.licensePlate = patch.licensePlate;
    if (patch.maxSpeedKmh !== undefined && patch.maxSpeedKmh !== current.maxSpeedKmh) data.maxSpeedKmh = patch.maxSpeedKmh;
    if (data.vehicleNumber) {
      const taken = await this.db.vehicle.findFirst({ where: { vehicleNumber: data.vehicleNumber, NOT: { id } }, select: { id: true } });
      if (taken) throw Object.assign(new Error(`Грузовик с номером ${data.vehicleNumber} уже есть.`), { statusCode: 409 });
    }
    const vehicle = Object.keys(data).length ? await this.db.vehicle.update({ where: { id }, data: { ...data, licensePlate: data.licensePlate === "" ? null : data.licensePlate } }) : await this.db.vehicle.findUniqueOrThrow({ where: { id } });
    const before = Object.fromEntries(Object.keys(data).map((key) => [key, current[key as keyof typeof current]]));
    const after = Object.fromEntries(Object.keys(data).map((key) => [key, vehicle[key as keyof typeof current]]));
    return { vehicle, before, after };
  }

  getDetails(id: string) {
    return this.db.vehicle.findUniqueOrThrow({
      where: { id },
      include: {
        tours: { include: tourInclude, orderBy: [{ plannedStartAt: "asc" }, { createdAt: "asc" }] },
        events: { orderBy: { timestamp: "desc" } },
        alerts: { orderBy: { createdAt: "desc" } }
      }
    } satisfies Prisma.VehicleFindUniqueArgs);
  }
}
