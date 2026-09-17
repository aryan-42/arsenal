import { db, getIdea, getSource } from './db';
import { embedDocuments } from './embeddings';
import { formatHighlight, appendToSection } from './markdown';
import type { HighlightRow, ReflectionKind } from './types';
import { dateIST, errMsg, shortId, truncate } from './util';
import { editVaultFiles, recordShas } from './vault';

async function saveReflection(row: { source_id?: string | null; idea_id?: string | null; kind: ReflectionKind; text: string }) {
  await db().from('reflections').insert(row);
}

async function vaultAppend(path: string | null, heading: string, line: string, label: string): Promise<string> {
  if (!path) return '';
  try {
    const shas = await editVaultFiles(label, [{ path, transform: (t) => appendToSection(t, heading, line) }]);
    await recordShas(shas);
    return '';
  } catch (e) {
    return `\n⚠️ Saved, but the vault update failed: ${truncate(errMsg(e), 120)}`;
  }
}

/** Your reaction to a source ("What struck me"), or a reading session for a book. */
export async function addReaction(sourceId: string, text: string): Promise<string> {
  const src = await getSource(sourceId);
  const isBook = src.format === 'book';
  const line = `- **${dateIST()}:** ${text.trim()}`;
  await saveReflection({ source_id: src.id, kind: isBook ? 'session' : 'reaction', text });
  await db()
    .from('sources')
    .update({ reaction: src.reaction ? `${src.reaction}\n${line}` : line })
    .eq('id', src.id);
  const warn = await vaultAppend(src.vault_path, isBook ? 'Sessions' : 'What struck me', line, `Reflection: ${truncate(src.title ?? '', 50)}`);
  return `✍️ Added to ${truncate(src.title ?? 'the note', 70)}${warn}`;
}

/** A later thought on an idea you wrote (e.g. replying to a resurfaced idea). */
export async function addIdeaAddendum(ideaId: string, text: string): Promise<string> {
  const idea = await getIdea(ideaId);
  await saveReflection({ idea_id: idea.id, kind: 'addendum', text });
  const warn = await vaultAppend(idea.vault_path, 'Later thoughts', `- **${dateIST()}:** ${text.trim()}`, `Later thought: ${truncate(idea.title, 50)}`);
  return `✍️ Added a later thought to "${truncate(idea.title, 70)}"${warn}`;
}

/** A later thought on a highlight, kept in the source note. */
export async function addHighlightAddendum(highlightId: string, text: string): Promise<string> {
  const { data } = await db().from('highlights').select('*').eq('id', highlightId).single();
  const h = data as HighlightRow;
  const src = await getSource(h.source_id);
  await saveReflection({ source_id: src.id, kind: 'addendum', text: `On ^${h.short_id}: ${text}` });
  const heading = src.format === 'book' ? 'One month later' : 'What struck me';
  const warn = await vaultAppend(src.vault_path, heading, `- **${dateIST()}** (on ^${h.short_id}): ${text.trim()}`, `Later thought: ${truncate(src.title ?? '', 50)}`);
  return `✍️ Added to ${truncate(src.title ?? 'the note', 70)}${warn}`;
}

/** A highlight you chose yourself (reading mode, or a pasted passage). */
export async function addOwnHighlight(sourceId: string, text: string, location: string | null, why: string | null): Promise<string> {
  const src = await getSource(sourceId);
  const row = { short_id: shortId(), source_id: src.id, text: text.trim(), location, why, origin: 'mine' as const };
  const [embedding] = await embedDocuments([`${row.text}\n${why ?? ''}`]);
  const { error } = await db()
    .from('highlights')
    .insert({ ...row, search_text: `${row.text}\n${why ?? ''}`, embedding });
  if (error) throw new Error(`Could not save highlight: ${error.message}`);
  const warn = await vaultAppend(src.vault_path, 'Highlights', formatHighlight(row), `Highlight: ${truncate(src.title ?? '', 50)}`);
  return `📌 ${location ? `${location}: ` : ''}highlight added to ${truncate(src.title ?? 'the book', 60)}${why ? '' : '\nTip: add // why it struck you'}${warn}`;
}

export async function addBookSection(sourceId: string, heading: 'Summary in my words' | 'What I disagree with', kind: ReflectionKind, text: string): Promise<string> {
  const src = await getSource(sourceId);
  await saveReflection({ source_id: src.id, kind, text });
  const warn = await vaultAppend(src.vault_path, heading, text.trim(), `${heading}: ${truncate(src.title ?? '', 50)}`);
  return `✍️ ${heading} saved for ${truncate(src.title ?? 'the book', 60)}${warn}`;
}
