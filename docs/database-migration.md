# Production database migration

OPS Disponent uses PostgreSQL through Prisma. The provider can be changed without
changing the application schema.

## Target configuration

- Managed PostgreSQL in Frankfurt.
- `DATABASE_URL`: pooled PgBouncer connection used by the Vercel API.
- `DATABASE_URL_UNPOOLED`: direct primary connection used only by Prisma migrations.
- TLS must be required for both connections.
- Automated backups and point-in-time recovery must be enabled before cutover.

Never commit connection strings. Store them in the provider and Vercel secret
settings only.

## Safe cutover

1. Keep the existing Neon project and backup branch unchanged.
2. Create the destination database and a least-privilege application user.
3. Put the direct destination connection in `DATABASE_URL_UNPOOLED` locally.
4. Validate connectivity with `npm run db:check --workspace @ops/api`.
5. Apply the immutable Prisma migrations with `npm run db:deploy --workspace @ops/api`.
6. Export the Neon production database with `pg_dump` when Neon access is restored.
7. Import the dump into the destination using `pg_restore`.
8. Compare table counts and sample vehicle, tour, stop, event and alert records.
9. Configure the pooled and direct destination URLs in the Vercel API project.
10. Redeploy the API, then verify `/health`, `/dashboard`, order creation, history,
    timers and Webfleet telemetry.
11. Keep Neon read-only until the new database has passed the observation period.

## Rollback

If verification fails, restore the previous Vercel environment variables and
redeploy the API. Do not delete either database until the destination has been
verified and a fresh independent backup exists.
