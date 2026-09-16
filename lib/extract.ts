import { callTool } from './claude';
import { MAX_CARDS_PER_SOURCE, MAX_SOURCE_CHARS, OWNER_CONTEXT } from './config';
import { CARD_KINDS, USE_FOR, type CardFields, type CardKind, type SourceRow, type UseFor } from './types';

export interface ExtractedCard {
  kind: CardKind;
  title: string;
  body: string;
  fields?: CardFields;
  implication: string;
  domains: string[];
  use_for: UseFor[];
}

export interface Extraction {
  source: {
    title: string;
    author?: string;
    summary: string;
    key_points: string[];
    domains: string[];
  };
  cards: ExtractedCard[];
}

const str = (description: string) => ({ type: 'string', description });

const SCHEMA = {
  type: 'object',
  properties: {
    source: {
      type: 'object',
      properties: {
        title: str('Clear, specific title for the source. Use the real title if known.'),
        author: str('Author, channel, or organisation if known; empty string otherwise.'),
        summary: str('2-4 sentence paraphrased summary.'),
        key_points: { type: 'array', items: { type: 'string' }, description: '3-5 paraphrased key points.' },
        domains: { type: 'array', items: { type: 'string' }, description: '1-3 lowercase kebab-case topics.' },
      },
      required: ['title', 'summary', 'key_points', 'domains'],
    },
    cards: {
      type: 'array',
      maxItems: MAX_CARDS_PER_SOURCE,
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: CARD_KINDS },
          title: str('Max 12 words, specific. Stat titles include the number.'),
          body: str('1-3 sentences, fully paraphrased, self-contained (readable without the source).'),
          fields: {
            type: 'object',
            description: 'Only the fields for this kind. Leave a field out if the content does not state it.',
            properties: {
              metric: str('stat: what is measured'),
              value: str('stat: the number exactly as stated'),
              unit: str('stat: unit, e.g. %, INR crore, employees'),
              year: str('stat: year or period the number refers to'),
              geography: str('stat: country/region/market'),
              definition: str('stat: how the metric is defined, if stated'),
              origin: str('stat: who produced the number, e.g. "NASSCOM survey, cited by author"'),
              statement: str('claim: the claim in one sentence'),
              epistemic: { type: 'string', enum: ['fact', 'estimate', 'opinion'], description: 'claim: evidence type' },
              attributed_to: str('claim: who makes the claim'),
              company: str('case: named organisation'),
              action: str('case: what they did'),
              result: str('case: outcome, with numbers if stated'),
              context: str('case: situation or constraint'),
              concept: str('framework: name of the model/framework'),
              when_to_use: str('framework: when it applies'),
              limits: str('framework: where it breaks down'),
              narrative: str('story: the story, paraphrased'),
              lesson: str('story: the point it proves'),
              problem: str('opportunity: the unmet problem'),
              who_has_it: str('opportunity: who experiences it'),
              current_workaround: str('opportunity: how people cope today'),
              why_now: str('opportunity: what changed that makes it solvable/urgent'),
              product_angle: str('opportunity: tentative product angle'),
            },
          },
          implication: str('One specific sentence: why this matters and how it could be used. No generic filler.'),
          domains: { type: 'array', items: { type: 'string' }, description: '1-3 lowercase kebab-case topics' },
          use_for: { type: 'array', items: { type: 'string', enum: USE_FOR } },
        },
        required: ['kind', 'title', 'body', 'implication', 'domains', 'use_for'],
      },
    },
  },
  required: ['source', 'cards'],
};

const SYSTEM = `You extract reusable evidence from content the owner saved.

${OWNER_CONTEXT}

Your output becomes "evidence cards" they will pull into slides, exam answers, interview answers, posts and startup theses. Quality beats quantity.

CARD KINDS
- stat: a number stated in the content.
- claim: an argument or finding. Mark epistemic: fact (verifiable, sourced), estimate (projection/model), opinion (someone's view).
- case: a real, named organisation, what it did, and the result.
- framework: a named or clearly structured model, when it applies, and its limits.
- story: a narrative worth retelling and the lesson it proves.
- opportunity: an unmet problem the content gives evidence for: who has it, current workaround, why now, tentative product angle. Never invent startup ideas the content does not support.

RULES
1. Return 0 to ${MAX_CARDS_PER_SOURCE} cards. Return 0 cards for fluff, pure motivation, ads, or content with nothing reusable. Never pad.
2. Each card is atomic (one item) and self-contained (makes sense without the source).
3. Paraphrase everything. Never copy more than 10 consecutive words from the content.
4. Numbers: only use numbers explicitly stated in the content. Never calculate, estimate, round, convert, or fill gaps from your own knowledge. Keep the value exactly as stated. Fill unit/year/geography/definition only if the content states them; otherwise leave them out. Record who produced the number in origin.
5. Do not add facts from your own knowledge anywhere. If the content is wrong or dubious, still extract only what it says, and prefer kind "claim" with the right epistemic label.
6. The owner's note says why they saved this. Prioritise cards that serve that reason. If the note contains the owner's own idea or observation, capture it as a card attributed to "owner".
7. implication must be specific to this evidence, e.g. "Supports sizing the addressable market for gig-worker benefits in Tier-2 cities", not "This is important for businesses".
8. domains: lowercase kebab-case, consistent and reusable (e.g. hr-analytics, gig-economy, fintech, upi, leadership, ai-adoption).
9. use_for: only the uses the card genuinely serves.
10. Always fill the source summary and key points, even when returning 0 cards.`;

export function buildExtractionInput(src: SourceRow): string {
  const content = src.raw_text ?? '';
  const truncated = content.length > MAX_SOURCE_CHARS;
  const body = truncated ? content.slice(0, MAX_SOURCE_CHARS) : content;
  return [
    `FORMAT: ${src.format}`,
    src.url ? `URL: ${src.url}` : null,
    src.title ? `TITLE: ${src.title}` : null,
    src.author ? `AUTHOR: ${src.author}` : null,
    `OWNER'S NOTE (why they saved it): ${src.user_note?.trim() || 'none'}`,
    '',
    body
      ? `CONTENT${truncated ? ' (truncated)' : ''}:\n<content>\n${body}\n</content>`
      : 'CONTENT: not available. Work only from the owner\'s note and any title/caption above.',
  ]
    .filter((l) => l !== null)
    .join('\n');
}

export async function extract(src: SourceRow): Promise<Extraction> {
  const result = await callTool<Extraction>({
    system: SYSTEM,
    user: buildExtractionInput(src),
    toolName: 'save_evidence',
    toolDescription: 'Save the source summary and the extracted evidence cards.',
    schema: SCHEMA,
    maxTokens: 8000,
  });
  const cards = (result.cards ?? [])
    .filter((c) => CARD_KINDS.includes(c.kind) && c.title?.trim())
    .slice(0, MAX_CARDS_PER_SOURCE)
    .map((c) => ({
      ...c,
      fields: cleanFields(c.fields),
      domains: (c.domains ?? []).map(normalizeDomain).filter(Boolean).slice(0, 3),
      use_for: (c.use_for ?? []).filter((u): u is UseFor => USE_FOR.includes(u)),
    }));
  return {
    source: {
      title: result.source?.title?.trim() || src.title || 'Untitled',
      author: result.source?.author?.trim() || undefined,
      summary: result.source?.summary?.trim() ?? '',
      key_points: (result.source?.key_points ?? []).slice(0, 5),
      domains: (result.source?.domains ?? []).map(normalizeDomain).filter(Boolean).slice(0, 3),
    },
    cards,
  };
}

function normalizeDomain(d: string): string {
  return d.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function cleanFields(fields: CardFields | undefined): CardFields {
  const out: CardFields = {};
  for (const [k, v] of Object.entries(fields ?? {})) {
    if (typeof v === 'string' && v.trim()) (out as Record<string, string>)[k] = v.trim();
  }
  return out;
}

/** A stat is incomplete when it lacks a value, unit, year or geography. */
export function isIncomplete(kind: CardKind, fields: CardFields): boolean {
  if (kind !== 'stat') return false;
  return !fields.value || !fields.unit || !fields.year || !fields.geography;
}

export function searchTextFor(card: { title: string; body: string; implication?: string | null; fields: CardFields; domains: string[] }): string {
  return [card.title, card.body, card.implication ?? '', ...Object.values(card.fields), card.domains.join(' ')]
    .filter(Boolean)
    .join('\n');
}
