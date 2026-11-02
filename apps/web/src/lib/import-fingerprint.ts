/** One id per import attempt: a retry of the same click reuses it, so the server never creates the Auftrag twice. */
export function createImportAttemptId() {
  return globalThis.crypto?.randomUUID?.() ?? `import-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** Stable hash of an imported Auftrag: the same document confirmed twice maps to the same tour. */
export async function importFingerprint(value: unknown) {
  const canonical = JSON.stringify(value)
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))
    return `auftrag-${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`
  }
  let hash = 2166136261
  for (const character of canonical) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619)
  return `auftrag-${(hash >>> 0).toString(16).padStart(8, '0')}`
}
