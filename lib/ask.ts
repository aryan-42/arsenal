import { callText } from './llm';
import { OWNER_CONTEXT } from './config';
import { appendSources, formatCardForPrompt, searchCards, sourcesById } from './search';
import { truncate } from './util';

export type AskMode = 'ask' | 'case' | 'exam' | 'interview' | 'content';

const MODE_FORMAT: Record<AskMode, string> = {
  ask: `Give a direct answer first (2-3 sentences). Then EVIDENCE: bullets, each with a citation. Then GAPS.`,
  case: `Structure for a consulting-standard case team. For each distinct finding:
FINDING: one line
EVIDENCE: the supporting card(s), each labelled FACT, ESTIMATE, OPINION, or ⚠️UNVERIFIED STAT, with citation
IMPLICATION: what it means strategically for this question
Order findings by strength of evidence. Then GAPS.`,
  exam: `CONCEPT: name it.
EXPLANATION: clear, exam-ready explanation grounded in the cards.
EXAMPLES: real examples from the cards, with citations.
EXAM ANGLE: how this could be asked and the key points to hit.
Then GAPS.`,
  interview: `Give 3-5 usable examples or stories. For each:
EXAMPLE: one line
PROVES: the competency or point it demonstrates
SAY IT: one natural sentence to use in an interview
with citations. Then GAPS.`,
  content: `Give up to 5 post ideas. For each:
HOOK: a scroll-stopping first line
FACT: the supporting evidence, with citation (flag ⚠️ if unverified)
CAPTION SOURCE: the source line to credit
Then GAPS.`,
};

function system(mode: AskMode): string {
  return `You answer questions using ONLY the owner's personal evidence bank.

${OWNER_CONTEXT}

RULES
1. Use only the cards provided. Do not add facts, numbers, or examples from your own knowledge.
2. Cite the card id in square brackets right after each point, e.g. [k3m9qa].
3. Ignore cards that are not relevant. Never force a weak card into the answer.
4. Any stat card with verified: NO must be flagged ⚠️ unverified. Mention missing year/geography for incomplete stats.
5. Keep facts, estimates and opinions clearly distinguished.
6. Always end with GAPS: what the bank lacks for this question, stated as specific data or examples to find (metric, geography, year).
7. If nothing relevant exists, say so plainly and list the GAPS.
8. Plain text only: no markdown tables, no # headings. Use short CAPS labels. Under 3,500 characters.

OUTPUT FORMAT
${MODE_FORMAT[mode]}`;
}

export async function answerQuestion(question: string, mode: AskMode): Promise<string> {
  const cards = await searchCards(question, { count: 25 });
  if (!cards.length) {
    return `Nothing in your evidence bank matches this yet.\n\nGAPS\nNo cards on "${truncate(question, 80)}". Capture 2-3 strong sources on it, then ask again.`;
  }
  const sources = await sourcesById(cards.map((c) => c.source_id));
  const context = cards.map((c) => formatCardForPrompt(c, sources.get(c.source_id))).join('\n\n');
  const answer = await callText({
    system: system(mode),
    user: `QUESTION (${mode} mode): ${question}\n\nCARDS FROM THE EVIDENCE BANK (ranked by search relevance):\n\n${context}`,
    maxTokens: 3000,
  });
  return appendSources(answer, cards, sources);
}
