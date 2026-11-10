import type { storedAnswerOf } from './order-documents.js';
import { finishModelAnswer, importPromptVersion, type ImportCustomerContext, type LearnedImportRules, type ReadStats } from './pdf-order-import.js';

// A week: long enough for a re-upload of the same Auftrag, short enough that the model's hints are not stale.
const REUSE_ANSWER_MS = 7 * 24 * 3600_000;
type StoredAnswer = NonNullable<ReturnType<typeof storedAnswerOf>>;

/**
 * The same file under the same rules and customer was read by the model before: its answer is worked out again by
 * the rules of now. Null when there is no such answer or it no longer fits — then the model reads the file.
 */
export async function readingFromStore(stored: StoredAnswer | null, layout: 'PDF' | 'IMAGE', customer: ImportCustomerContext, learned: () => Promise<LearnedImportRules | null>, now = Date.now()) {
  if (!stored || stored.answer.layout !== layout || stored.answer.promptVersion !== importPromptVersion(layout, customer)) return null;
  const age = now - Date.parse(stored.answer.readAt);
  if (!(age >= 0 && age <= REUSE_ANSWER_MS)) return null;
  try {
    const preview = finishModelAnswer(stored.answer.answer, { layout, readMode: stored.answer.readMode, learned: await learned(), customer });
    return { ...preview, modelAnswer: stored.answer, readStats: stored.readStats as ReadStats | undefined, answerReused: true as const,
      warnings: [...preview.warnings, { code: 'DOCUMENT_REUSED', message: 'Этот файл уже читался — показан сохранённый ответ ИИ, разобранный по текущим правилам.' }] };
  } catch {
    return null;
  }
}
