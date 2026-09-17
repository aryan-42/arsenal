import { TOPICS } from './config';
import { suggestConnections } from './connections';
import { db } from './db';
import { embedDocuments } from './embeddings';
import { searchText } from './extract';
import { registerPrompt } from './prompts';
import { sendMessage } from './telegram';
import type { IdeaRow } from './types';
import { errMsg, shortId, truncate } from './util';
import { ideaStem, writeIdeaNote } from './vault';

const RELATION_EMOJI: Record<string, string> = {
  supports: '🤝',
  contradicts: '⚡',
  'example-of': '🔎',
  extends: '➕',
  'same-pattern': '🔁',
};

/** Splits "Title\nbody" or a single paragraph into a title and body. */
export function splitIdea(text: string): { title: string; body: string } {
  const clean = text.trim();
  const lines = clean.split('\n');
  if (lines.length > 1 && lines[0].length <= 120) {
    return { title: lines[0].replace(/^#+\s*/, '').trim(), body: lines.slice(1).join('\n').trim() };
  }
  const sentence = clean.match(/^(.{10,120}?[.!?])(\s|$)/);
  if (sentence && sentence[1].length < clean.length) {
    return { title: sentence[1].replace(/[.!?]$/, '').trim(), body: clean };
  }
  return { title: truncate(clean, 90).replace(/…$/, ''), body: clean };
}

/** Creates an idea in your own words, writes its note, and suggests connections. */
export async function createIdea(opts: {
  text: string;
  chatId: number;
  replyTo?: number;
  sourceId?: string | null;
  topics?: string[];
}): Promise<void> {
  const { title, body } = splitIdea(opts.text);
  let topics = (opts.topics ?? []).filter((t) => TOPICS.includes(t));
  if (!topics.length && opts.sourceId) {
    const { data } = await db().from('sources').select('topics').eq('id', opts.sourceId).maybeSingle();
    topics = (data?.topics as string[] | undefined) ?? [];
  }
  const text = searchText(title, body);
  const [embedding] = await embedDocuments([text]);
  const { data, error } = await db()
    .from('ideas')
    .insert({
      short_id: shortId(),
      source_id: opts.sourceId ?? null,
      title,
      body,
      origin: 'mine',
      status: 'seedling',
      topics,
      search_text: text,
      embedding,
    })
    .select('*')
    .single();
  if (error || !data) throw new Error(`Could not save idea: ${error?.message}`);
  const idea = data as IdeaRow;

  let vaultNote = '';
  try {
    await writeIdeaNote(idea.id);
  } catch (e) {
    vaultNote = `\n⚠️ Saved, but writing to the vault failed: ${truncate(errMsg(e), 120)}`;
  }

  const suggestions = await suggestConnections(idea.id);
  const lines = [`🌱 Idea saved: ${truncate(title, 100)}`];
  if (suggestions.length) {
    lines.push('', 'Possible connections:');
    for (const s of suggestions) {
      lines.push(`${RELATION_EMOJI[s.relation] ?? '•'} ${s.relation} "${truncate(ideaStem(s.other).replace(/ \([a-z0-9]{6}\)$/, ''), 70)}"`);
      if (s.reason) lines.push(`   ${truncate(s.reason, 160)}`);
      lines.push(`   /accept ${s.short_id}   /reject ${s.short_id}`);
    }
  } else {
    lines.push('No strong connections yet. They appear as your book grows.');
  }
  const messageId = await sendMessage(opts.chatId, lines.join('\n') + vaultNote, opts.replyTo);
  await registerPrompt(opts.chatId, messageId, 'idea', idea.id);
}
