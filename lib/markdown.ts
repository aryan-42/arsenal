import YAML from 'yaml';
import type { HighlightRow, IdeaRow, Relation, SourceRow } from './types';
import { dateIST, sanitizeFilename } from './util';

function scalar(key: string, value: unknown): string {
  if (value === null || value === undefined) return '""';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  const s = String(value);
  if (['captured', 'created', 'started', 'finished'].includes(key) && /^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
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

export function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

/** Replaces a simple `key: value` frontmatter line, or adds it before the closing ---. */
export function setFrontmatterField(markdown: string, key: string, value: string | boolean | number): string {
  const rendered = `${key}: ${scalar(key, value)}`;
  const fm = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return `${frontmatter({ [key]: value })}\n${markdown}`;
  const re = new RegExp(`^${key}:.*$`, 'm');
  const block = re.test(fm[1]) ? fm[1].replace(re, rendered) : `${fm[1]}\n${rendered}`;
  return markdown.replace(fm[0], `---\n${block}\n---`);
}

function findSection(lines: string[], heading: string): { start: number; end: number } | null {
  const start = lines.findIndex((l) => l.trim().toLowerCase() === `## ${heading}`.toLowerCase());
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start, end };
}

/** Text under a `## Heading` up to the next `## ` heading, without placeholder lines. */
export function getSection(markdown: string, heading: string): string | null {
  const lines = markdown.split('\n');
  const s = findSection(lines, heading);
  if (!s) return null;
  return lines
    .slice(s.start + 1, s.end)
    .filter((l) => !/^_.*_$/.test(l.trim()))
    .join('\n')
    .trim();
}

/**
 * Appends text at the end of a `## Heading` section without touching anything else.
 * Removes placeholder lines like `_Nothing yet._`. Adds the section if missing.
 */
export function appendToSection(markdown: string, heading: string, text: string): string {
  const lines = markdown.split('\n');
  const s = findSection(lines, heading);
  if (!s) return `${markdown.replace(/\s*$/, '')}\n\n## ${heading}\n\n${text}\n`;
  const body = lines.slice(s.start + 1, s.end).filter((l) => !/^_.*_$/.test(l.trim()));
  while (body.length && !body[body.length - 1].trim()) body.pop();
  while (body.length && !body[0].trim()) body.shift();
  const section = [`## ${heading}`, '', ...body, text, ''];
  return [...lines.slice(0, s.start), ...section, ...lines.slice(s.end)].join('\n');
}

/** Replaces the whole body of a `## Heading` section. Adds the section if missing. */
export function replaceSection(markdown: string, heading: string, text: string): string {
  const lines = markdown.split('\n');
  const s = findSection(lines, heading);
  if (!s) return `${markdown.replace(/\s*$/, '')}\n\n## ${heading}\n\n${text}\n`;
  return [...lines.slice(0, s.start), `## ${heading}`, '', text, '', ...lines.slice(s.end)].join('\n');
}

// ---------------------------------------------------------------------------
// File names
// ---------------------------------------------------------------------------

export function sourceFileName(src: Pick<SourceRow, 'title' | 'short_id' | 'format' | 'author'>): string {
  if (src.format === 'book') {
    const by = src.author ? ` (${sanitizeFilename(src.author, 40)})` : '';
    return `${sanitizeFilename(src.title || 'Untitled book', 70)}${by}.md`;
  }
  return `${sanitizeFilename(src.title || 'Untitled')} (${src.short_id}).md`;
}

export function ideaFileName(idea: Pick<IdeaRow, 'title' | 'short_id'>): string {
  return `${sanitizeFilename(idea.title, 90)} (${idea.short_id}).md`;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function formatHighlight(h: Pick<HighlightRow, 'text' | 'location' | 'why' | 'short_id'>): string {
  const loc = h.location ? ` (${h.location})` : '';
  const lines = [`- ${h.text}${loc} ^${h.short_id}`];
  if (h.why) lines.push(`  - **Why:** ${h.why}`);
  return lines.join('\n');
}

const RELATION_PHRASE: Record<Relation, string> = {
  supports: 'Supports',
  contradicts: 'Contradicts',
  'example-of': 'Is an example of',
  extends: 'Extends',
  'same-pattern': 'Same pattern as',
};

export function formatConnection(relation: Relation, targetStem: string, reason: string): string {
  return `- ${RELATION_PHRASE[relation]} [[${targetStem}]]${reason ? `: ${reason}` : ''}`;
}

export function renderSource(
  src: SourceRow,
  highlights: Pick<HighlightRow, 'text' | 'location' | 'why' | 'short_id'>[],
  candidates: { title: string; body: string; short_id: string }[],
  related: string[] = [],
): string {
  const isBook = src.format === 'book';
  const fm = frontmatter({
    type: 'source',
    source_id: src.short_id,
    format: src.format,
    author: src.author ?? '',
    url: src.url ?? '',
    captured: dateIST(src.created_at),
    ...(isBook
      ? {
          status: src.reading_status ?? 'reading',
          started: dateIST(src.started_at ?? src.created_at),
          finished: src.finished_at ? dateIST(src.finished_at) : '',
        }
      : {}),
    topics: src.topics ?? [],
    ...(src.archive_path ? { archive: src.archive_path } : {}),
  });

  const parts = [fm, `# ${src.title || 'Untitled'}`];
  if (isBook) {
    parts.push("## Why I'm reading it", src.user_note?.trim() || '_Nothing yet._');
    parts.push('## Highlights', highlights.length ? highlights.map(formatHighlight).join('\n') : '_Nothing yet._');
    parts.push('## Sessions', '_Nothing yet._');
    parts.push('## Summary in my words', '_Write this after finishing, without looking back at the book._');
    parts.push('## Ideas from this book', '_Nothing yet._');
    parts.push('## What I disagree with', '_Nothing yet._');
    parts.push('## One month later', '_Nothing yet._');
  } else {
    parts.push('## Why I saved this', src.user_note?.trim() || '_No note._');
    if (src.summary) parts.push('## Summary', src.summary);
    parts.push('## Highlights', highlights.length ? highlights.map(formatHighlight).join('\n') : '_No highlights._');
    if (candidates.length) {
      parts.push(
        '## Candidate ideas',
        `_The source's ideas, not yours. Write the ones that matter to you as ideas in your own words._\n\n${candidates
          .map((c) => `- **${c.title}** ^${c.short_id}\n  ${c.body}`)
          .join('\n')}`,
      );
    }
    parts.push('## What struck me', '_Nothing yet._');
    if (related.length) parts.push('## Related in my book', related.map((r) => `- [[${r}]]`).join('\n'));
  }
  return `${parts.join('\n\n')}\n`;
}

export function renderIdea(idea: IdeaRow, sourceStem: string | null): string {
  const fm = frontmatter({
    type: 'idea',
    idea_id: idea.short_id,
    status: idea.status === 'evergreen' ? 'evergreen' : 'seedling',
    origin: idea.origin,
    source: sourceStem ? `[[${sourceStem}]]` : '',
    topics: idea.topics ?? [],
    created: dateIST(idea.created_at),
  });
  return `${[fm, `# ${idea.title}`, idea.body.trim(), '## Connections', '_Nothing yet._'].join('\n\n')}\n`;
}

/** The idea as you wrote it: the H1 title and the text before the first ## section. */
export function ideaBodyFromMarkdown(markdown: string): { title: string | null; body: string } {
  const lines = stripFrontmatter(markdown).split('\n');
  const h1 = lines.findIndex((l) => /^#\s/.test(l));
  const title = h1 >= 0 ? lines[h1].replace(/^#\s+/, '').trim() : null;
  const after = h1 >= 0 ? lines.slice(h1 + 1) : lines;
  const next = after.findIndex((l) => /^##\s/.test(l));
  return { title, body: (next >= 0 ? after.slice(0, next) : after).join('\n').trim() };
}
