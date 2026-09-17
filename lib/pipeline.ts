import { TOPICS } from './config';
import { db, getSetting, getSource, setSetting, updateSource } from './db';
import { embedDocuments } from './embeddings';
import { extract, searchText, type Extraction } from './extract';
import { fetchContent } from './fetchers';
import { registerPrompt } from './prompts';
import { sendMessage, typing } from './telegram';
import type { SourceRow } from './types';
import { errMsg, shortId, truncate } from './util';
import { writeSourceNote } from './vault';

/** Fetch → extract → save → vault → ask for your reaction. Safe to re-run (replaces machine output only). */
export async function processSource(sourceId: string): Promise<void> {
  let src = await getSource(sourceId);
  await typing(src.chat_id);
  try {
    await updateSource(src.id, { status: 'processing', error: null });

    if (!src.raw_text && src.url) {
      const fetched = await fetchContent(src.url);
      await updateSource(src.id, {
        format: fetched.format,
        title: src.title ?? fetched.title ?? null,
        author: src.author ?? fetched.author ?? null,
        raw_text: fetched.text ?? null,
        error: fetched.text ? null : fetched.reason ?? null,
      });
      src = await getSource(src.id);
    }

    const canExtract = Boolean(src.raw_text) || (src.format === 'reel' && Boolean(src.user_note));
    if (!canExtract) {
      await updateSource(src.id, { status: 'needs_content' });
      const ask = src.format === 'reel'
        ? 'Send a voice or text note on what this reel says and why it matters.'
        : 'Paste the text or transcript as your next message.';
      await sendMessage(
        src.chat_id,
        `⚠️ ${truncate(src.title ?? src.url ?? 'Source', 80)}\n${src.error ?? 'No readable content.'}\n\n${ask}\nOr send /skip to keep just the link.`,
        src.message_id,
      );
      return;
    }

    const extraction = await extract(src);
    await saveExtraction(src, extraction);
    await updateSource(src.id, { status: 'processed', processed_at: new Date().toISOString() });

    let vaultNote = '';
    try {
      await writeSourceNote(src.id);
    } catch (e) {
      vaultNote = `\n⚠️ Saved, but writing to the vault failed: ${truncate(errMsg(e), 140)}. Send /sync to retry.`;
    }

    src = await getSource(src.id);
    const { data: cands } = await db()
      .from('ideas')
      .select('short_id, title')
      .eq('source_id', src.id)
      .eq('status', 'candidate');
    const lines = [
      `✅ ${truncate(src.title ?? 'Saved', 90)}`,
      extraction.summary ? truncate(extraction.summary, 280) : null,
      '',
      `${extraction.highlights.length} highlight${extraction.highlights.length === 1 ? '' : 's'} kept`,
      ...((cands ?? []) as { short_id: string; title: string }[]).map((c) => `💡 [${c.short_id}] ${truncate(c.title, 90)}`),
      '',
      '✍️ What struck you? Reply to this message.',
    ].filter((l) => l !== null) as string[];
    const messageId = await sendMessage(src.chat_id, lines.join('\n') + vaultNote, src.message_id);
    await registerPrompt(src.chat_id, messageId, 'source', src.id);
  } catch (e) {
    await updateSource(src.id, { status: 'failed', error: truncate(errMsg(e), 500) });
    await sendMessage(src.chat_id, `❌ Failed: ${truncate(errMsg(e), 300)}\nSend /retry to try again.`, src.message_id);
  }
}

async function saveExtraction(src: SourceRow, x: Extraction): Promise<void> {
  // Replace only machine output; your highlights and ideas are never touched
  await db().from('highlights').delete().eq('source_id', src.id).eq('origin', 'machine');
  await db().from('ideas').delete().eq('source_id', src.id).eq('status', 'candidate');

  const highlightRows = x.highlights.map((h) => ({
    short_id: shortId(),
    source_id: src.id,
    text: h.text,
    location: h.location ?? null,
    origin: 'machine',
    search_text: h.text,
  }));
  const candidateRows = x.candidate_ideas.map((c) => ({
    short_id: shortId(),
    source_id: src.id,
    title: c.title,
    body: c.body,
    origin: 'from-source',
    status: 'candidate',
    topics: x.topics,
    search_text: searchText(c.title, c.body),
  }));
  const title = src.url && src.title ? src.title : x.title;
  const sourceSearch = searchText(title, src.author ?? x.author, x.summary, x.topics, src.user_note);

  const embeddings = await embedDocuments([
    sourceSearch,
    ...highlightRows.map((h) => h.search_text),
    ...candidateRows.map((c) => c.search_text),
  ]);

  if (highlightRows.length) {
    const r = await db().from('highlights').insert(highlightRows.map((h, i) => ({ ...h, embedding: embeddings[1 + i] })));
    if (r.error) throw new Error(`Could not save highlights: ${r.error.message}`);
  }
  if (candidateRows.length) {
    const offset = 1 + highlightRows.length;
    const r = await db().from('ideas').insert(candidateRows.map((c, i) => ({ ...c, embedding: embeddings[offset + i] })));
    if (r.error) throw new Error(`Could not save candidate ideas: ${r.error.message}`);
  }

  const upd = await db()
    .from('sources')
    .update({
      title,
      author: src.author ?? x.author ?? null,
      summary: x.summary,
      topics: x.topics,
      search_text: sourceSearch,
      embedding: embeddings[0],
    })
    .eq('id', src.id);
  if (upd.error) throw new Error(`Could not update source: ${upd.error.message}`);

  if (x.proposed_topics.length) {
    const proposals = (await getSetting<Record<string, number>>('topic_proposals')) ?? {};
    for (const t of x.proposed_topics) if (!TOPICS.includes(t)) proposals[t] = (proposals[t] ?? 0) + 1;
    await setSetting('topic_proposals', proposals);
  }
}

export async function markLinkOnly(sourceId: string): Promise<void> {
  await updateSource(sourceId, { status: 'link_only', processed_at: new Date().toISOString() });
  await writeSourceNote(sourceId);
}
