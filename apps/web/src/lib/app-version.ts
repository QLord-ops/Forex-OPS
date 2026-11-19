/** The entry script of a built page: its name carries a hash that changes with every deploy. */
export function entryOf(html: string): string | null {
  return /<script\b[^>]*\bsrc="([^"]*\/assets\/[^"]+\.js)"/.exec(html)?.[1] ?? null
}

/** A page opened before a deploy keeps running the old program until it is reloaded. */
export function newerBuild(running: string | null, published: string | null): boolean {
  return Boolean(running && published && running !== published)
}
