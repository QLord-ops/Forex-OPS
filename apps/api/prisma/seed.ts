import "../src/env.js";
import { PrismaClient } from "@prisma/client";
import { MockRoutingProvider } from "../src/services/routing.js";
import { TourService } from "../src/services/tours.js";

const prisma = new PrismaClient();
const routingProvider = new MockRoutingProvider();
const tourService = new TourService(prisma, routingProvider);

function hoursFromNow(hours: number): string {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

// The seed wipes vehicles and tours, so it only runs against a local development database.
function assertLocalDatabase() {
  const url = process.env.DATABASE_URL ?? "";
  const local = url.startsWith("file:") || /@(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//.test(url);
  // A separate development database elsewhere can be seeded on purpose; production never.
  const allowedRemote = process.env.OPS_SEED_ALLOW_REMOTE === "yes";
  if (process.env.NODE_ENV === "production" || (!local && !allowedRemote)) {
    console.error("Seed отменён: он удаляет все машины и туры и работает только с локальной базой (для отдельной тестовой базы: OPS_SEED_ALLOW_REMOTE=yes).");
    process.exit(1);
  }
}

async function main() {
  assertLocalDatabase();
  await prisma.alert.deleteMany();
  await prisma.event.deleteMany();
  await prisma.leg.deleteMany();
  await prisma.stop.deleteMany();
  await prisma.tour.deleteMany();
  await prisma.vehicle.deleteMany();

  const vehicles = await Promise.all(
    [
      { vehicleNumber: "936", licensePlate: "KS-OP 936" },
      { vehicleNumber: "728", licensePlate: "KS-OP 728" },
      { vehicleNumber: "414", licensePlate: "KS-OP 414" },
      { vehicleNumber: "563", licensePlate: "KS-OP 563" }
    ].map((data) => prisma.vehicle.create({ data }))
  );

  const byNumber = new Map(vehicles.map((vehicle) => [vehicle.vehicleNumber, vehicle]));
  const v936 = byNumber.get("936")!;
  const v728 = byNumber.get("728")!;
  const v414 = byNumber.get("414")!;

  const tour936Active = await tourService.createTour({
    vehicleId: v936.id,
    orderNumber: "DEMO-936-A",
    stops: [
      {
        sequence: 1,
        type: "LOAD",
        company: "Demo Lager Göttingen",
        address: "Göttingen",
        appointmentAt: hoursFromNow(-2.25)
      },
      {
        sequence: 2,
        type: "UNLOAD",
        company: "Demo Werk Zwickau",
        address: "Zwickau",
        appointmentAt: hoursFromNow(1.25)
      }
    ]
  });

  await tourService.recordLoaded(tour936Active.stops[0].id, new Date(Date.now() - 2 * 60 * 60 * 1000), "Seed: beladen");

  await tourService.createTour({
    vehicleId: v936.id,
    orderNumber: "DEMO-936-B",
    stops: [
      {
        sequence: 1,
        type: "LOAD",
        company: "Demo Umschlag Leipzig",
        address: "Leipzig",
        appointmentAt: hoursFromNow(3)
      },
      {
        sequence: 2,
        type: "UNLOAD",
        company: "Demo Kunde Hannover",
        address: "Hannover",
        appointmentAt: hoursFromNow(8)
      }
    ]
  });

  const tour728 = await tourService.createTour({
    vehicleId: v728.id,
    orderNumber: "DEMO-728-A",
    stops: [
      { sequence: 1, type: "LOAD", address: "Hamburg", appointmentAt: hoursFromNow(-1) },
      { sequence: 2, type: "UNLOAD", address: "Bremen", appointmentAt: hoursFromNow(1) }
    ]
  });
  await tourService.recordLoaded(tour728.stops[0].id, new Date(Date.now() - 70 * 60 * 1000), "Seed: beladen");

  const tour414 = await tourService.createTour({
    vehicleId: v414.id,
    orderNumber: "DEMO-414-A",
    stops: [
      { sequence: 1, type: "LOAD", address: "Kassel", appointmentAt: hoursFromNow(-4) },
      { sequence: 2, type: "UNLOAD", address: "Erfurt", appointmentAt: hoursFromNow(-1.5) }
    ]
  });
  await tourService.recordLoaded(tour414.stops[0].id, new Date(Date.now() - 4 * 60 * 60 * 1000), "Seed: beladen");
  await tourService.recordUnloaded(tour414.stops[1].id, new Date(Date.now() - 90 * 60 * 1000), "Seed: entladen");

  console.log("Seed complete: vehicles 936, 728, 414, 563 created.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
