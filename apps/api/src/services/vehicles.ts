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
