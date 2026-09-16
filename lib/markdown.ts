import YAML from 'yaml';
import type { CardFields, CardKind, CardRow, SourceRow } from './types';
import { dateIST, sanitizeFilename } from './util';

const KIND_LABEL: Record<CardKind, string> = {
  stat: 'Stat',
  claim: 'Claim',
  case: 'Case',
  framework: 'Framework',
  story: 'Story',
  opportunity: 'Opportunity',
};

const FIELD_LABEL: Record<keyof CardFields, string> = {
  metric: 'Metric',
  value: 'Value',
  unit: 'Unit',
  year: 'Year',
  geography: 'Geography',
  definition: 'Definition',
  origin: 'Origin of number',
  statement: 'Statement',
  epistemic: 'Evidence type',
  attributed_to: 'Attributed to',
  company: 'Company',
  action: 'Action',
  result: 'Result',
  context: 'Context',
  concept: 'Concept',
  when_to_use: 'When to use',
  limits: 'Limits',
  narrative: 'Narrative',
  lesson: 'Lesson',
  problem: 'Problem',
  who_has_it: 'Who has it',
  current_workaround: 'Current workaround',
  why_now: 'Why now',
  product_angle: 'Product angle',
};

function scalar(key: string, value: unknown): string {
  if (value === null || value === undefined) return '""';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  const s = String(value);
  if ((key === 'captured' || key === 'created') && /^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return JSON.stringify(s); // JSON strings are valid YAML double-quoted scalars
}

export function frontmatter(obj: Record<string, unknown>): string {
  const lines = ['---'];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (!value.length) lines.push(`${key}: []`);
      else {
        lines.push(`${key}:`);
        for (const item of value) lines.push(`  - ${scalar(key, item)}`);
      }
    } else {
      lines.push(`${key}: ${scalar(key, value)}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

export function parseFrontmatter(markdown: string): Record<string, unknown> | null {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  try {
    const parsed = YAML.parse(match[1]);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function sourceFileName(src: Pick<SourceRow, 'title' | 'short_id'>): string {
  return `${sanitizeFilename(src.title || 'Untitled')} (${src.short_id}).md`;
}

export function cardFileName(card: Pick<CardRow, 'kind' | 'title' | 'short_id'>): string {
  return `${KIND_LABEL[card.kind]} - ${sanitizeFilename(card.title, 70)} (${card.short_id}).md`;
}

export function renderSource(src: SourceRow, cardStems: string[]): string {
  const fm = frontmatter({
    type: 'source',
    source_id: src.short_id,
    format: src.format,
    url: src.url ?? '',
    author: src.author ?? '',
    captured: dateIST(src.created_at),
    status: src.status,
    domains: src.domains ?? [],
    cards: cardStems.length,
  });
  const parts = [
    fm,
    `# ${src.title || 'Untitled'}`,
    '## Why I saved this',
    src.user_note?.trim() || '_No note._',
  ];
  if (src.summary) parts.push('## Summary', src.summary);
  if (src.key_points?.length) parts.push('## Key points', src.key_points.map((p) => `- ${p}`).join('\n'));
  parts.push(
    '## Evidence cards',
    cardStems.length ? cardStems.map((s) => `- [[${s}]]`).join('\n') : '_No cards extracted._',
    '## My take',
    '',
  );
  return parts.join('\n\n');
}

export function renderCard(card: CardRow, src: SourceRow, sourceStem: string): string {
  const fieldEntries = Object.entries(card.fields ?? {}).filter(([, v]) => typeof v === 'string' && v.trim());
  const fm = frontmatter({
    type: 'evidence',
    card_id: card.short_id,
    kind: card.kind,
    verified: card.verified,
    incomplete: card.incomplete,
    source: `[[${sourceStem}]]`,
    url: src.url ?? '',
    captured: dateIST(card.created_at),
    domains: card.domains ?? [],
    use_for: card.use_for ?? [],
    ...Object.fromEntries(fieldEntries),
  });
  const parts = [fm, `# ${card.title}`, card.body];
  if (fieldEntries.length) {
    parts.push(
      '## Details',
      fieldEntries.map(([k, v]) => `- **${FIELD_LABEL[k as keyof CardFields] ?? k}:** ${v}`).join('\n'),
    );
  }
  if (card.implication) parts.push(`**Implication:** ${card.implication}`);
  if (card.kind === 'stat' && !card.verified) {
    parts.push('> [!warning] Unverified\n> Check this number against the source, then set `verified` to true.');
  }
  parts.push('## My note', '');
  return parts.join('\n\n');
}
