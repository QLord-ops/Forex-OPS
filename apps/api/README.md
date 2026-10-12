# OPS Disponent API

Backend for the local dispatcher MVP. It stores vehicle, tour, stop, leg, event and alert state in SQLite via Prisma and exposes Fastify REST endpoints for the React dashboard.

## Local Setup

From the repository root:

```bash
npm install
npm run db:setup
npm run dev
```

The API runs on `http://127.0.0.1:3001` by default.

SQLite database path: `apps/api/prisma/dev.db`.

## Endpoints

- `GET /health`
- `GET /vehicles`
- `POST /vehicles`
- `GET /vehicles/:id`
- `GET /vehicles/:id/tours`
- `POST /tours`
- `GET /tours/:id`
- `PATCH /tours/:id`
- `POST /stops/:id/loaded`
- `POST /stops/:id/unloaded`
- `GET /vehicles/:id/current-position`
- `GET /vehicles/:id/timeline`
- `GET /alerts`
- `GET /dashboard`

All API responses use ISO date strings. Position responses include `Berechnete Position – keine GPS-Daten`.

## Create a Vehicle

```bash
curl -X POST http://127.0.0.1:3001/vehicles \
  -H 'content-type: application/json' \
  -d '{"vehicleNumber":"999","licensePlate":"KS-OP 999","maxSpeedKmh":85}'
```

## Create an Auftrag

```bash
curl -X POST http://127.0.0.1:3001/tours \
  -H 'content-type: application/json' \
  -d '{
    "vehicleId":"<vehicle-id>",
    "orderNumber":"A-1001",
    "stops":[
      {"sequence":1,"type":"LOAD","address":"Göttingen","appointmentAt":"2026-09-29T08:00:00.000Z"},
      {"sequence":2,"type":"UNLOAD","address":"Zwickau","appointmentAt":"2026-09-29T13:00:00.000Z"}
    ]
  }'
```

If the vehicle already has an `ACTIVE` or `QUEUED` tour, the new tour is stored as `QUEUED` and chained through `previousTourId`.

## Operational Events

```bash
curl -X POST http://127.0.0.1:3001/stops/<load-stop-id>/loaded
curl -X POST http://127.0.0.1:3001/stops/<unload-stop-id>/unloaded
```

`BELADEN` starts the outgoing leg from the actual timestamp. `ENTLADEN` completes the incoming leg. A final unload completes the tour and activates the next queued tour for that vehicle.

## Routing Provider Swap

Business logic depends only on the `RoutingProvider` interface in `src/services/routing.ts`:

- `geocode(address)`
- `calculateRoute(origin, destination)`
- `calculateMultiStopRoute(stops)`

To replace OSRM with HERE Truck Routing later, add a `HereRoutingProvider` implementing the same interface and instantiate it in `src/app.ts` and `prisma/seed.ts`. No tour, ETA or simulation service changes are required.
