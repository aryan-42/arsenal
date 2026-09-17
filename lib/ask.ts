import { OWNER_CONTEXT } from './config';
import { db, sourcesById } from './db';
import { callText } from './llm';
import { searchBook } from './search';
import type { IdeaRow } from './types';
import { dateIST, truncate } from './util';

const SYSTEM = `You answer questions using ONLY the owner's commonplace book.

${OWNER_CONTEXT}

The book contains three kinds of entries:
- IDEA (yours): written by the owner in their own words. This is their thinking.
- IDEA (source's): an idea drafted from a source, not yet adopted by the owner.
- HIGHLIGHT: a passage kept from something they read.
- SOURCE: a summary of something they read or watched.

RULES
1. Use only the entries provided. Add nothing from your own knowledge.
2. Cite the entry id in square brackets after each point, e.g. [k3m9qa].
3. Keep the owner's own ideas clearly distinct from what sources said.
4. Dates matter: when the question is about change over time, compare older and newer entries explicitly.
5. Point out tensions between entries when you see them.
6. End with "NOT IN YOUR BOOK YET": what the book doesn't cover for this question.
7. Plain text, short CAPS labels allowed, no # headings or tables. Under 3,000 characters.`;

export async function askBook(question: string): Promise<string> {
  const hits = await searchBook(question, { count: 25 });
  if (!hits.length) return `Your book has nothing on this yet.\n\nNOT IN YOUR BOOK YET\n"${truncate(question, 80)}"`;

  const ideaIds = hits.filter((h) => h.kind === 'idea').map((h) => h.id);
  const { data: ideas } = ideaIds.length ? await db().from('ideas').select('id, origin').in('id', ideaIds) : { data: [] };
  const origin = new Map(((ideas ?? []) as Pick<IdeaRow, 'id' | 'origin'>[]).map((i) => [i.id, i.origin]));
  const sources = await sourcesById(hits.map((h) => h.source_id).filter((id): id is string => Boolean(id)));

  const context = hits
    .map((h) => {
      const label = h.kind === 'idea' ? `IDEA (${origin.get(h.id) === 'mine' ? 'yours' : "source's"})` : h.kind.toUpperCase();
      const src = h.source_id ? sources.get(h.source_id) : undefined;
      return [
        `[${h.short_id}] ${label} | ${dateIST(h.created_at)}`,
        h.title ? `Title: ${h.title}` : null,
        h.body ? truncate(h.body, 700) : null,
        src && h.kind !== 'source' ? `From: ${src.title ?? 'Untitled'}` : null,
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');

  const answer = await callText({ system: SYSTEM, user: `QUESTION: ${question}\n\nENTRIES:\n\n${context}`, maxTokens: 2500 });

  const byShort = new Map(hits.map((h) => [h.short_id, h]));
  const cited = [...new Set([...answer.matchAll(/\[([a-hj-km-np-z2-9]{6})\]/g)].map((m) => m[1]))].filter((id) => byShort.has(id));
  if (!cited.length) return answer;
  const refs = cited.map((id) => {
    const h = byShort.get(id)!;
    const src = h.source_id ? sources.get(h.source_id) : undefined;
    return `[${id}] ${truncate(h.kind === 'source' ? h.title ?? '' : src?.title ?? h.title ?? '', 70)}`;
  });
  return `${answer}\n\nREFERENCES\n${refs.join('\n')}`;
}
