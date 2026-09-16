import { db, sourcesById } from './db';
import { embedQuery } from './embeddings';
import type { CardKind, SearchResult, SourceRow } from './types';
import { dateIST } from './util';

/** Turns a natural-language question into an OR keyword query for Postgres. */
export function toKeywordQuery(text: string): string {
  const words = text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}-]*/gu) ?? [];
  const unique = [...new Set(words.map((w) => w.replace(/^-+|-+$/g, '')).filter((w) => w.length >= 3 && w !== 'or'))];
  return unique.slice(0, 16).join(' or ');
}

export async function searchCards(query: string, opts: { count?: number; kinds?: CardKind[] } = {}): Promise<SearchResult[]> {
  const embedding = await embedQuery(query);
  const { data, error } = await db().rpc('search_cards', {
    query_text: toKeywordQuery(query),
    query_embedding: embedding,
    match_count: opts.count ?? 25,
    kinds: opts.kinds ?? null,
  });
  if (error) throw new Error(`Search failed: ${error.message}`);
  return (data ?? []) as SearchResult[];
}

export function formatCardForPrompt(card: SearchResult, source: SourceRow | undefined): string {
  const fields = Object.entries(card.fields ?? {})
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
  return [
    `[${card.short_id}] ${card.kind.toUpperCase()} | verified: ${card.verified ? 'yes' : 'NO'}${card.incomplete ? ' | incomplete: yes' : ''}`,
    `Title: ${card.title}`,
    card.body ? `Body: ${card.body}` : null,
    fields ? `Fields: ${fields}` : null,
    card.implication ? `Implication: ${card.implication}` : null,
    source ? `Source: ${source.title ?? 'Untitled'} (${source.format}, captured ${dateIST(source.created_at)})` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

/** Appends a SOURCES list for the card ids cited in an answer. */
export function appendSources(answer: string, cards: SearchResult[], sources: Map<string, SourceRow>): string {
  const byShort = new Map(cards.map((c) => [c.short_id, c]));
  const cited = [...answer.matchAll(/\[([a-hj-km-np-z2-9]{6})\]/g)].map((m) => m[1]).filter((id) => byShort.has(id));
  const ids = [...new Set(cited)];
  if (!ids.length) return answer;
  const lines = ids.map((id) => {
    const card = byShort.get(id)!;
    const src = sources.get(card.source_id);
    const flag = card.kind === 'stat' && !card.verified ? ' ⚠️unverified' : '';
    return `[${id}]${flag} ${src?.title ?? 'Untitled'}${src?.url ? ` - ${src.url}` : ''}`;
  });
  return `${answer}\n\nSOURCES\n${lines.join('\n')}`;
}

export { sourcesById };
