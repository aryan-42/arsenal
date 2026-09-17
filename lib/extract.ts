import { MAX_CANDIDATES, MAX_HIGHLIGHTS, MAX_SOURCE_CHARS, OWNER_CONTEXT, TOPICS } from './config';
import { callTool } from './llm';
import type { SourceRow } from './types';

export interface Extraction {
  title: string;
  author?: string;
  summary: string;
  highlights: { text: string; location?: string }[];
  candidate_ideas: { title: string; body: string }[];
  topics: string[];
  proposed_topics: string[];
}

const SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'The real title if known; otherwise a clear, specific one.' },
    author: { type: 'string', description: 'Author, speaker, channel or publication; empty string if unknown.' },
    summary: {
      type: 'string',
      description: '3-4 sentences: what the source argues or shows. Plain, specific, no hype.',
    },
    highlights: {
      type: 'array',
      maxItems: MAX_HIGHLIGHTS,
      description: 'The most striking passages worth keeping for decades.',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'A short exact quote under 30 words.' },
          location: { type: 'string', description: 'Page, chapter or timestamp if visible; else empty.' },
        },
        required: ['text'],
      },
    },
    candidate_ideas: {
      type: 'array',
      maxItems: MAX_CANDIDATES,
      description: "The source's most important transferable ideas.",
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'The idea stated as a claim, max 12 words.' },
          body: { type: 'string', description: '2-3 sentences explaining the idea and why it holds.' },
        },
        required: ['title', 'body'],
      },
    },
    topics: {
      type: 'array',
      items: { type: 'string', enum: TOPICS },
      description: '1-3 topics from the allowed list.',
    },
    proposed_topics: {
      type: 'array',
      items: { type: 'string' },
      description: 'Only if no allowed topic fits well: up to 1 new kebab-case topic. Usually empty.',
    },
  },
  required: ['title', 'summary', 'highlights', 'candidate_ideas', 'topics'],
};

const SYSTEM = `You help maintain a commonplace book.

${OWNER_CONTEXT}

For each source you receive, prepare material the owner will react to. You never write the owner's opinions; you surface what is worth keeping.

HIGHLIGHTS (0-${MAX_HIGHLIGHTS})
- Exact, short quotes (under 30 words) copied from the content. Never invent or reword a quote.
- Choose passages that are striking, precise, surprising or memorable: a sharp formulation, a vivid example, a number that changes how you see something.
- Skip filler, greetings, calls to action and sponsor segments.
- Add a location (page, chapter, timestamp) only if it is visible in the content.

CANDIDATE IDEAS (0-${MAX_CANDIDATES})
- Transferable ideas from the source, stated as claims, e.g. "Constraints increase creative output", not "The video talks about constraints".
- An idea should still make sense and be useful years later, outside the source's context.
- Short content can hold an idea too: a caption naming a product, trend or result may point to a pattern.
- These are the source's ideas, not the owner's.

GENERAL
- Work only from the content, the owner's note, and the title/caption. Add nothing from your own knowledge.
- The owner's note says why they saved it; weight your choices toward it.
- Topics must come from the allowed list. Propose a new topic only if nothing fits.
- Never claim content is unavailable when a <content> block is present. Return empty lists only if there is truly nothing worth keeping.`;

/** Long sources are sampled as evenly spaced excerpts across the whole text, not cut at the start. */
export function condenseContent(text: string, max: number, windows = 8): { body: string; condensed: boolean } {
  if (text.length <= max) return { body: text, condensed: false };
  const size = Math.floor(max / windows);
  const step = (text.length - size) / (windows - 1);
  const parts: string[] = [];
  for (let i = 0; i < windows; i++) {
    const start = Math.floor(i * step);
    const pct = Math.round((start / text.length) * 100);
    parts.push(`[Excerpt ${i + 1}/${windows}, starting ${pct}% into the source]\n${text.slice(start, start + size)}`);
  }
  return { body: parts.join('\n\n'), condensed: true };
}

export function buildExtractionInput(src: SourceRow): string {
  const content = src.raw_text ?? '';
  const { body, condensed } = condenseContent(content, MAX_SOURCE_CHARS);
  return [
    `FORMAT: ${src.format}`,
    src.url ? `URL: ${src.url}` : null,
    src.title ? `TITLE: ${src.title}` : null,
    src.author ? `AUTHOR: ${src.author}` : null,
    `OWNER'S NOTE (why they saved it): ${src.user_note?.trim() || 'none'}`,
    '',
    body
      ? `CONTENT (${content.length.toLocaleString('en-US')} characters${condensed ? '; long source, so evenly spaced excerpts covering the whole source are shown' : ''}):\n<content>\n${body}\n</content>`
      : "CONTENT: not available. Work only from the owner's note and any title/caption above.",
  ]
    .filter((l) => l !== null)
    .join('\n');
}

export function normalizeTopic(t: string): string {
  return t.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export async function extract(src: SourceRow): Promise<Extraction> {
  const r = await callTool<Partial<Extraction>>({
    system: SYSTEM,
    user: buildExtractionInput(src),
    toolName: 'save_reading',
    toolDescription: 'Save the summary, highlights, candidate ideas and topics for this source.',
    schema: SCHEMA,
    maxTokens: 6000,
  });

  const content = (src.raw_text ?? '').replace(/\s+/g, ' ').toLowerCase();
  const highlights = (Array.isArray(r.highlights) ? r.highlights : [])
    .map((h) => ({ text: String(h?.text ?? '').trim().replace(/^["“]|["”]$/g, ''), location: String(h?.location ?? '').trim() || undefined }))
    .filter((h) => h.text.length > 0)
    // Keep only quotes that actually appear in the content (models sometimes paraphrase)
    .filter((h) => !content || content.includes(h.text.replace(/\s+/g, ' ').toLowerCase().slice(0, 40)))
    .slice(0, MAX_HIGHLIGHTS);

  const candidate_ideas = (Array.isArray(r.candidate_ideas) ? r.candidate_ideas : [])
    .map((c) => ({ title: String(c?.title ?? '').trim(), body: String(c?.body ?? '').trim() }))
    .filter((c) => c.title)
    .slice(0, MAX_CANDIDATES);

  const topics = [...new Set((Array.isArray(r.topics) ? r.topics : []).map(normalizeTopic))]
    .filter((t) => TOPICS.includes(t))
    .slice(0, 3);
  const proposed_topics = [...new Set((Array.isArray(r.proposed_topics) ? r.proposed_topics : []).map(normalizeTopic))]
    .filter((t) => t && !TOPICS.includes(t))
    .slice(0, 1);

  return {
    title: String(r.title ?? '').trim() || src.title || 'Untitled',
    author: String(r.author ?? '').trim() || undefined,
    summary: String(r.summary ?? '').trim(),
    highlights,
    candidate_ideas,
    topics,
    proposed_topics,
  };
}

export function searchText(...parts: (string | null | undefined | string[])[]): string {
  return parts
    .flat()
    .filter((p): p is string => Boolean(p))
    .join('\n');
}
