import { config } from "dotenv";
import { resolve } from "node:path";

const localEnvCandidates = [
  resolve(process.cwd(), ".env.local"),
  resolve(process.cwd(), "../../.env.local"),
  resolve(process.cwd(), "apps/api/.env"),
  resolve(process.cwd(), ".env")
];

// Hosted environment variables always win. Locally, prefer the Neon-managed root file
// and keep apps/api/.env only as a backwards-compatible fallback.
for (const path of localEnvCandidates) config({ path, override: false });
