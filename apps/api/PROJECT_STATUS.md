# API Project Status

## DONE

- Fastify TypeScript API with Prisma and SQLite.
- Vehicle, Tour, Stop, Leg, Event and Alert schema plus SQL migration snapshot.
- Routing abstraction, OSRM/Nominatim provider, routing service and deterministic fallback.
- Simulation, ETA, vehicle, tour queue and alert services.
- Dynamic calculated position on route geometry with 85 km/h speed cap.
- ACTIVE/QUEUED scheduling, transfer legs and automatic next-tour activation.
- Immutable stop events and deduplicated alert lifecycle.
- Safe editing/cancellation of future queued plans without deleting event history.
- Seed and 14 passing unit tests for simulation, scheduling, queue and alerts.

## TODO

- Isolated SQLite endpoint integration tests.
- HERE Truck Routing provider.
- Optional structured request correlation and production logging configuration.

## KNOWN LIMITATIONS

- Public OSRM/Nominatim can be unavailable; fallback routes are approximate and not truck-aware.
- Running or historized tours are deliberately immutable through the plan editor.
- This API is intended for localhost single-user operation and has no authentication layer.

## NEXT STEPS

- Run the full root-level validation commands documented in `README.md`.
- Add API integration coverage before broadening tour editing rules.
