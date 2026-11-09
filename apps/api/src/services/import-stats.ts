import { z } from "zod";
import { importReasoningEffort, importServiceTier, type ReadStats } from "./pdf-order-import.js";

/** The dispatcher is promised an Auftrag within this time; the speed card counts how often it held. */
export const READ_TARGET_MS = 10_000;
const RECENT_DOCUMENTS = 100;

const ms = z.number().finite().min(0).max(3_600_000);
const tokens = z.number().int().min(0).nullable();
const readStatsSchema = z.object({
  model: z.string().max(80),
  effort: z.string().max(20),
  serviceTier: z.string().max(20).nullable(),
  readMode: z.enum(["text", "file", "image"]),
  extractMs: ms,
  modelMs: ms,
  postMs: ms,
  inputTokens: tokens,
  cachedTokens: tokens,
  outputTokens: tokens,
  reasoningTokens: tokens,
  settingsRejected: z.boolean(),
  contextMs: ms.optional(),
  totalMs: ms.optional()
});

export type ImportSpeedSummary = {
  /** Documents looked at and how many of them carry timings (Excel and older readings do not). */
  documents: number;
  count: number;
  targetMs: number;
  medianMs: number | null;
  p90Ms: number | null;
  modelMedianMs: number | null;
  withinTarget: number;
  /** Share of the input tokens OpenAI took from its prompt cache, 0..1. */
  cachedShare: number | null;
  inputTokensMedian: number | null;
  outputTokensMedian: number | null;
  reasoningTokensMedian: number | null;
  modes: { text: number; file: number; image: number };
  settingsRejected: number;
  lastReadAt: string | null;
  /** What the newest reading ran with, and what the server is set to now. */
  last: { model: string; effort: string; serviceTier: string | null } | null;
  configured: { effort: string; serviceTier: string | null };
};

export function readStatsOf(previewJson: string): ReadStats | null {
  try {
    const parsed = readStatsSchema.safeParse((JSON.parse(previewJson) as { readStats?: unknown } | null)?.readStats);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Nearest rank: the value that `share` of the readings did not exceed. */
export function percentile(values: number[], share: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(share * sorted.length) - 1))];
}

export const totalReadMs = (stats: ReadStats) => stats.totalMs ?? (stats.contextMs ?? 0) + stats.extractMs + stats.modelMs + stats.postMs;

export function summarizeReadStats(rows: Array<{ previewJson: string; createdAt: Date }>, env: NodeJS.ProcessEnv = process.env): ImportSpeedSummary {
  const read = rows.flatMap((row) => {
    const stats = readStatsOf(row.previewJson);
    return stats ? [{ stats, createdAt: row.createdAt }] : [];
  }).sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
  const totals = read.map(({ stats }) => totalReadMs(stats));
  const known = (pick: (stats: ReadStats) => number | null) => read.flatMap(({ stats }) => { const value = pick(stats); return value === null ? [] : [value]; });
  // Only readings that report both figures count, otherwise an old answer without the detail would look uncached.
  const cached = read.reduce((sum, { stats }) => sum + (stats.inputTokens !== null && stats.cachedTokens !== null ? stats.cachedTokens : 0), 0);
  const cacheBase = read.reduce((sum, { stats }) => sum + (stats.inputTokens !== null && stats.cachedTokens !== null ? stats.inputTokens : 0), 0);
  return {
    documents: rows.length,
    count: read.length,
    targetMs: READ_TARGET_MS,
    medianMs: percentile(totals, 0.5),
    p90Ms: percentile(totals, 0.9),
    modelMedianMs: percentile(read.map(({ stats }) => stats.modelMs), 0.5),
    withinTarget: totals.filter((value) => value <= READ_TARGET_MS).length,
    cachedShare: cacheBase > 0 ? cached / cacheBase : null,
    inputTokensMedian: percentile(known((stats) => stats.inputTokens), 0.5),
    outputTokensMedian: percentile(known((stats) => stats.outputTokens), 0.5),
    reasoningTokensMedian: percentile(known((stats) => stats.reasoningTokens), 0.5),
    modes: {
      text: read.filter(({ stats }) => stats.readMode === "text").length,
      file: read.filter(({ stats }) => stats.readMode === "file").length,
      image: read.filter(({ stats }) => stats.readMode === "image").length
    },
    settingsRejected: read.filter(({ stats }) => stats.settingsRejected).length,
    lastReadAt: read[0]?.createdAt.toISOString() ?? null,
    last: read[0] ? { model: read[0].stats.model, effort: read[0].stats.effort, serviceTier: read[0].stats.serviceTier } : null,
    configured: { effort: importReasoningEffort(env), serviceTier: importServiceTier(env) }
  };
}

export async function importSpeed(documents: { recentPreviews(take: number): Promise<Array<{ previewJson: string; createdAt: Date }>> }): Promise<ImportSpeedSummary> {
  return summarizeReadStats(await documents.recentPreviews(RECENT_DOCUMENTS));
}
