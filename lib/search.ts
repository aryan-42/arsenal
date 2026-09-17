import { db } from './db';
import { embedQuery } from './embeddings';
import type { SearchHit } from './types';

/** Turns a natural-language question into an OR keyword query for Postgres. */
export function toKeywordQuery(text: string): string {
  const words = text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}-]*/gu) ?? [];
  const unique = [...new Set(words.map((w) => w.replace(/^-+|-+$/g, '')).filter((w) => w.length >= 3 && w !== 'or'))];
  return unique.slice(0, 16).join(' or ');
}

export async function searchBook(
  query: string,
  opts: { count?: number; kinds?: ('idea' | 'highlight' | 'source')[] } = {},
): Promise<SearchHit[]> {
  const embedding = await embedQuery(query);
  const { data, error } = await db().rpc('search_book', {
    query_text: toKeywordQuery(query),
    query_embedding: embedding,
    match_count: opts.count ?? 20,
    kinds: opts.kinds ?? null,
  });
  if (error) throw new Error(`Search failed: ${error.message}`);
  return (data ?? []) as SearchHit[];
}
