import { callText, callTool } from './llm';
import { OWNER_CONTEXT, vault, vaultPath } from './config';
import { commitChanges } from './github';
import { frontmatter } from './markdown';
import { formatCardForPrompt, searchCards, sourcesById } from './search';
import type { SearchResult } from './types';
import { dateIST, fileStem, sanitizeFilename, shortId, toPlain, truncate } from './util';

interface PackPlan {
  title: string;
  sub_questions: { question: string; search_queries: string[] }[];
}

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Short title for the problem, max 8 words' },
    sub_questions: {
      type: 'array',
      maxItems: 6,
      items: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'A sub-question the team must answer' },
          search_queries: {
            type: 'array',
            maxItems: 3,
            items: { type: 'string' },
            description: 'Short keyword-rich queries to search an evidence bank',
          },
        },
        required: ['question', 'search_queries'],
      },
    },
  },
  required: ['title', 'sub_questions'],
};

const PACK_SYSTEM = `You build an evidence pack from the owner's personal evidence bank, for a new case, exam, or interview.

${OWNER_CONTEXT}

RULES
1. Use only the candidate cards provided. No outside facts or numbers.
2. For each sub-question, keep only genuinely relevant cards. Drop weak matches.
3. Cite card ids in square brackets, e.g. [k3m9qa]. Flag ⚠️ on any stat with verified: NO.
4. Label hypotheses clearly as hypotheses.

OUTPUT (markdown)
## <sub-question>
- [id] one line on what this card proves for the sub-question
(if none: "- No relevant evidence in the bank.")

## Gaps to research
- specific data or examples still needed (metric, geography, year)

## First hypotheses
- 2-3 hypotheses the evidence points to, each with the cards behind it`;

export async function buildPack(problem: string): Promise<string> {
  const plan = await callTool<PackPlan>({
    system: `Break a problem statement into the sub-questions a strong team must answer, with search queries for each.\n\n${OWNER_CONTEXT}`,
    user: `PROBLEM STATEMENT:\n${problem}`,
    toolName: 'plan_pack',
    toolDescription: 'Save the pack plan.',
    schema: PLAN_SCHEMA,
    maxTokens: 2000,
  });

  const groups: { question: string; cards: SearchResult[] }[] = [];
  const allCards = new Map<string, SearchResult>();
  for (const sq of plan.sub_questions.slice(0, 6)) {
    const merged = new Map<string, SearchResult>();
    for (const q of sq.search_queries.slice(0, 3)) {
      for (const card of await searchCards(q, { count: 8 })) {
        const existing = merged.get(card.id);
        if (!existing || card.score > existing.score) merged.set(card.id, card);
      }
    }
    const top = [...merged.values()].sort((a, b) => b.score - a.score).slice(0, 8);
    top.forEach((c) => allCards.set(c.id, c));
    groups.push({ question: sq.question, cards: top });
  }

  if (!allCards.size) {
    return `No evidence in your bank for "${plan.title}" yet.\n\nSub-questions to research:\n${plan.sub_questions.map((s) => `• ${s.question}`).join('\n')}`;
  }

  const sources = await sourcesById([...allCards.values()].map((c) => c.source_id));
  const context = groups
    .map(
      (g, i) =>
        `SUB-QUESTION ${i + 1}: ${g.question}\n` +
        (g.cards.length ? g.cards.map((c) => formatCardForPrompt(c, sources.get(c.source_id))).join('\n\n') : '(no candidate cards)'),
    )
    .join('\n\n---\n\n');

  const pack = await callText({
    system: PACK_SYSTEM,
    user: `PROBLEM STATEMENT:\n${problem}\n\n${context}`,
    maxTokens: 4000,
  });

  // Save to the vault with clickable links to each card
  const byShort = new Map([...allCards.values()].map((c) => [c.short_id, c]));
  const linked = pack.replace(/\[([a-hj-km-np-z2-9]{6})\]/g, (match, id: string) => {
    const card = byShort.get(id);
    return card?.vault_path ? `[[${fileStem(card.vault_path)}|${id}]]` : match;
  });
  const path = vaultPath(vault.inbox, `Pack - ${sanitizeFilename(plan.title, 60)} (${shortId()}).md`);
  const content = [
    frontmatter({ type: 'pack', created: dateIST() }),
    `# Pack: ${plan.title}`,
    '## Problem statement',
    truncate(problem, 3000),
    linked,
  ].join('\n\n');

  let saved = `\n\nSaved to vault: ${path}`;
  try {
    await commitChanges(`Arsenal pack: ${truncate(plan.title, 50)}`, [{ path, content }]);
  } catch (e) {
    saved = `\n\n(Could not save to vault: ${truncate(String(e), 120)})`;
  }
  return `📦 PACK: ${plan.title}\n\n${toPlain(pack)}${saved}`;
}
