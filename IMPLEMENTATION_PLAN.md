# Vehicle operations implementation

Approved scope: vehicle-only calculated duty/rest state, optional appointments and cities, confirmed arrivals and dwell timers, active route revisions, free-tier traffic monitoring and global notifications. No GPS, drivers, paid requests, or database reset.

Delivery lanes:
1. Pure vehicle clock engine + deterministic tests.
2. TomTom routing and persistent quota + mocked provider tests.
3. Nullable appointments, city, history query-key fix, duration UI.
4. Active-route preview/apply preserving completed history and downstream transfers.
5. Operational UI with clock setup, arrival/stop controls, notifications and proposals.
6. Root: safe schema migration/backup, runtime integration, ETA, worker/SSE, verification.

Verification: focused tests first, isolated SQLite integration, typecheck/lint/build, browser smoke without test writes to the live DB, security/correctness review. Existing legacy records retain unknown clock/arrival metadata. No commits requested.
