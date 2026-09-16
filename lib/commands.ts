import { answerQuestion, type AskMode } from './ask';
import { NOTE_WINDOW_MINUTES } from './config';
import { db, getSetting, getSource, setSetting, updateSource } from './db';
import { embeddingsEnabled } from './embeddings';
import { describeModel } from './llm';
import { env } from './env';
import { pdfToText } from './fetchers';
import { runDigest, runOpportunityClustering } from './jobs';
import { buildPack } from './pack';
import { markLinkOnly, processSource } from './pipeline';
import { downloadFile, sendMessage, typing } from './telegram';
import { transcribeVoice } from './transcribe';
import type { SourceRow, TgMessage, TgUpdate } from './types';
import { cleanText, detectFormat, errMsg, extractUrls, normalizeUrl, shortId, stripUrls, truncate } from './util';
import { deleteCards, setVerified, syncVault } from './vault-sync';

const HELP = `ARSENAL: your evidence bank

CAPTURE
• Send any link: YouTube, article, report/PDF, tweet, reel
• Add why in the same message, or send a voice/text note within ${NOTE_WINDOW_MINUTES} min (or reply to my message)
• Send a PDF or .txt file directly
• Plain text on its own = a captured thought

ASK (answers only from your cards, with citations)
/ask <question>: direct answer
/case <question>: Finding, Evidence, Implication, Gaps
/exam <question>: Concept, Explanation, Examples
/interview <theme>: stories and examples
/content <topic>: hooks and facts for posts
/pack <problem statement>: evidence pack for a new case, exam, or JD

MAINTAIN
/unverified: stats waiting for a check
/verify <id> [id...]  /unverify <id>  /delete <id>
/focus <what you are working on>: shapes the Sunday digest
/skip: keep a source as link only
/retry: re-run the last failed source
/sync: pull your Obsidian edits now
/stats  /digest  /opportunities`;

export async function handleUpdate(update: TgUpdate): Promise<void> {
  const msg = update.message;
  if (!msg?.from) return;
  if (String(msg.from.id) !== env.allowedUserId) {
    await sendMessage(msg.chat.id, 'This is a private bot.');
    return;
  }
  try {
    if (msg.document) return await handleDocument(msg);
    if (msg.voice || msg.audio) return await handleVoice(msg);
    const text = (msg.text ?? msg.caption ?? '').trim();
    if (!text) return;
    if (text.startsWith('/')) return await handleCommand(msg, text);
    const urls = extractUrls(text, msg.entities ?? msg.caption_entities ?? []);
    if (urls.length) return await handleLinks(msg, text, urls);
    return await handlePlainText(msg, text);
  } catch (e) {
    console.error(e);
    await sendMessage(msg.chat.id, `❌ ${truncate(errMsg(e), 400)}`, msg.message_id);
  }
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

async function insertSource(row: Partial<SourceRow> & { chat_id: number; message_id: number }): Promise<SourceRow | null> {
  const { data, error } = await db().from('sources').insert({ short_id: shortId(), ...row }).select('*').single();
  if (error) {
    if (error.code === '23505') return null; // duplicate delivery from Telegram
    throw new Error(`Could not save source: ${error.message}`);
  }
  return data as SourceRow;
}

async function handleLinks(msg: TgMessage, text: string, urls: ReturnType<typeof extractUrls>): Promise<void> {
  const note = stripUrls(text, urls) || null;
  for (const { url } of urls) {
    const normalized = normalizeUrl(url);
    const { data: existing } = await db()
      .from('sources')
      .select('*')
      .eq('normalized_url', normalized)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existing) {
      const src = existing as SourceRow;
      if (note) {
        await attachNote(src, note, msg.message_id);
      } else {
        await sendMessage(msg.chat.id, `Already captured: ${truncate(src.title ?? src.url ?? '', 80)} (${src.status}). Add a note to re-extract with it.`, msg.message_id);
      }
      continue;
    }

    const format = detectFormat(url);
    const src = await insertSource({
      chat_id: msg.chat.id,
      message_id: msg.message_id,
      url,
      normalized_url: normalized,
      format,
      user_note: note,
      status: 'pending',
    });
    if (!src) continue;

    const hint = format === 'reel' && !note ? '\n🎙️ Reels are mostly unreadable. Send a quick voice or text note on why it matters.' : '';
    const botMessageId = await sendMessage(msg.chat.id, `📥 Captured, reading…${hint}`, msg.message_id);
    await updateSource(src.id, { bot_message_id: botMessageId });
    await processSource(src.id);
  }
}

/** The source a note should attach to: the message you replied to, or your last capture within the window. */
async function findNoteTarget(msg: TgMessage): Promise<SourceRow | null> {
  if (msg.reply_to_message) {
    const { data } = await db()
      .from('sources')
      .select('*')
      .eq('chat_id', msg.chat.id)
      .or(`bot_message_id.eq.${msg.reply_to_message.message_id},message_id.eq.${msg.reply_to_message.message_id}`)
      .limit(1)
      .maybeSingle();
    if (data) return data as SourceRow;
  }
  const since = new Date(Date.now() - NOTE_WINDOW_MINUTES * 60 * 1000).toISOString();
  const { data } = await db()
    .from('sources')
    .select('*')
    .eq('chat_id', msg.chat.id)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as SourceRow) ?? null;
}

async function attachNote(src: SourceRow, text: string, replyTo: number, kind: 'text' | 'voice' = 'text'): Promise<void> {
  // Long pasted text for a source we couldn't read = the content itself
  if (src.status === 'needs_content' && src.format !== 'reel' && kind === 'text' && text.length > 300) {
    await updateSource(src.id, { raw_text: cleanText(text) });
    await sendMessage(src.chat_id, `📄 Content added to ${truncate(src.title ?? 'source', 60)}, extracting…`, replyTo);
    await processSource(src.id);
    return;
  }

  const fresh = await getSource(src.id);
  const combined = fresh.user_note ? `${fresh.user_note}\n${text}` : text;
  await updateSource(src.id, { user_note: combined });

  if (fresh.status === 'pending' || fresh.status === 'processing') {
    await sendMessage(src.chat_id, `📝 Note added to ${truncate(fresh.title ?? 'the capture', 60)} (used in extraction).`, replyTo);
    return;
  }
  if (fresh.status === 'needs_content' && fresh.format !== 'reel') {
    await sendMessage(src.chat_id, '📝 Note saved. I still need the content: paste the text, or send /skip to keep the link and note.', replyTo);
    return;
  }
  await sendMessage(src.chat_id, `📝 Note added to ${truncate(fresh.title ?? 'source', 60)}, re-extracting…`, replyTo);
  await processSource(src.id);
}

async function handlePlainText(msg: TgMessage, text: string): Promise<void> {
  const target = await findNoteTarget(msg);
  if (target) return attachNote(target, text, msg.message_id);
  await captureThought(msg, text);
}

async function captureThought(msg: TgMessage, text: string): Promise<void> {
  const src = await insertSource({
    chat_id: msg.chat.id,
    message_id: msg.message_id,
    format: 'other',
    title: `Thought: ${truncate(text.split('\n')[0], 60)}`,
    raw_text: text,
    user_note: 'My own thought or observation.',
    status: 'pending',
  });
  if (!src) return;
  const botMessageId = await sendMessage(msg.chat.id, '💭 Thought captured, extracting…', msg.message_id);
  await updateSource(src.id, { bot_message_id: botMessageId });
  await processSource(src.id);
}

async function handleVoice(msg: TgMessage): Promise<void> {
  const fileId = msg.voice?.file_id ?? msg.audio?.file_id;
  if (!fileId) return;
  await typing(msg.chat.id);
  const { buffer } = await downloadFile(fileId);
  const text = await transcribeVoice(buffer, msg.audio?.file_name ?? 'voice.ogg');
  const target = await findNoteTarget(msg);
  if (target) {
    await attachNote(target, text, msg.message_id, 'voice');
  } else {
    await sendMessage(msg.chat.id, `🎙️ "${truncate(text, 200)}"`, msg.message_id);
    await captureThought(msg, text);
  }
}

async function handleDocument(msg: TgMessage): Promise<void> {
  const doc = msg.document!;
  const name = doc.file_name ?? 'document';
  const isPdf = doc.mime_type === 'application/pdf' || /\.pdf$/i.test(name);
  const isText = /^text\//.test(doc.mime_type ?? '') || /\.(txt|md)$/i.test(name);
  if (!isPdf && !isText) {
    await sendMessage(msg.chat.id, 'I can read PDF, .txt and .md files. For other files, send a link or paste the text.', msg.message_id);
    return;
  }
  if ((doc.file_size ?? 0) > 20 * 1024 * 1024) {
    await sendMessage(msg.chat.id, 'Telegram bots can only download files up to 20 MB. Send a link to it instead.', msg.message_id);
    return;
  }
  await typing(msg.chat.id);
  const { buffer } = await downloadFile(doc.file_id);
  let text: string | null;
  let title = name.replace(/\.(pdf|txt|md)$/i, '').replace(/[-_]+/g, ' ');
  if (isPdf) {
    const pdf = await pdfToText(buffer);
    text = pdf.text;
    title = pdf.title ?? title;
  } else {
    text = cleanText(new TextDecoder().decode(buffer));
  }
  const src = await insertSource({
    chat_id: msg.chat.id,
    message_id: msg.message_id,
    format: isPdf ? 'report' : 'other',
    title,
    raw_text: text,
    user_note: msg.caption?.trim() || null,
    status: 'pending',
    error: text ? null : 'The PDF has no text layer (probably scanned).',
  });
  if (!src) return;
  const botMessageId = await sendMessage(msg.chat.id, `📥 ${truncate(title, 60)}: reading…`, msg.message_id);
  await updateSource(src.id, { bot_message_id: botMessageId });
  await processSource(src.id);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const ASK_MODES: Record<string, AskMode> = { ask: 'ask', case: 'case', exam: 'exam', interview: 'interview', content: 'content' };
const IDS = (arg: string) => [...new Set(arg.toLowerCase().split(/[\s,]+/).map((s) => s.replace(/[[\]]/g, '')).filter(Boolean))];

async function handleCommand(msg: TgMessage, text: string): Promise<void> {
  const match = text.match(/^\/(\w+)(?:@\w+)?\s*([\s\S]*)$/);
  const command = match?.[1]?.toLowerCase() ?? '';
  const arg = match?.[2]?.trim() ?? '';
  const chat = msg.chat.id;
  const reply = (t: string) => sendMessage(chat, t, msg.message_id);

  if (ASK_MODES[command]) {
    if (!arg) return void (await reply(`Usage: /${command} <question>`));
    await typing(chat);
    return void (await reply(await answerQuestion(arg, ASK_MODES[command])));
  }

  switch (command) {
    case 'start':
    case 'help':
      await reply(HELP);
      return;

    case 'pack':
      if (arg.length < 30) return void (await reply('Paste the full problem statement, syllabus, or job description after /pack.'));
      await typing(chat);
      await reply('📦 Building your pack. This takes about a minute…');
      await reply(await buildPack(arg));
      return;

    case 'unverified': {
      const { data } = await db()
        .from('cards')
        .select('short_id, kind, title, fields, incomplete, source_id')
        .eq('deleted', false)
        .eq('verified', false)
        .in('kind', ['stat', 'claim'])
        .order('created_at')
        .limit(15);
      const rows = (data ?? []) as { short_id: string; kind: string; title: string; fields: Record<string, string>; incomplete: boolean; source_id: string }[];
      if (!rows.length) return void (await reply('Nothing waiting. All stats and claims are verified. ✅'));
      const { data: srcs } = await db().from('sources').select('id, title, url').in('id', [...new Set(rows.map((r) => r.source_id))]);
      const byId = new Map((srcs ?? []).map((s: { id: string; title: string | null; url: string | null }) => [s.id, s]));
      const lines = rows.map((r) => {
        const s = byId.get(r.source_id);
        const value = r.fields?.value ? ` = ${r.fields.value}${r.fields.unit ? ` ${r.fields.unit}` : ''}` : '';
        return `[${r.short_id}] ${r.kind.toUpperCase()}${r.incomplete ? ' ⚠️incomplete' : ''}: ${truncate(r.title, 80)}${value}\n   ${truncate(s?.title ?? '', 50)}${s?.url ? ` ${s.url}` : ''}`;
      });
      await reply(`OLDEST UNVERIFIED (check against the source)\n\n${lines.join('\n\n')}\n\n/verify id id   ·   /delete id`);
      return;
    }

    case 'verify':
    case 'unverify':
      if (!arg) return void (await reply(`Usage: /${command} <card id> [more ids]`));
      await reply(await setVerified(IDS(arg), command === 'verify'));
      return;

    case 'delete':
      if (!arg) return void (await reply('Usage: /delete <card id> [more ids]'));
      await reply(await deleteCards(IDS(arg)));
      return;

    case 'focus':
      if (!arg) {
        const focus = await getSetting<{ text: string }>('focus');
        return void (await reply(focus?.text ? `Current focus: ${focus.text}\nChange it with /focus <text>` : 'No focus set. Example: /focus ABG case on digital HR operating model; FINM exam'));
      }
      await setSetting('focus', { text: arg });
      await reply(`🎯 Focus set: ${arg}`);
      return;

    case 'skip': {
      const { data } = await db()
        .from('sources')
        .select('id, title, url')
        .eq('chat_id', chat)
        .eq('status', 'needs_content')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!data) return void (await reply('Nothing is waiting for content.'));
      await markLinkOnly(data.id);
      await reply(`🔗 Kept as link only: ${truncate(data.title ?? data.url ?? '', 80)}`);
      return;
    }

    case 'retry': {
      const { data } = await db()
        .from('sources')
        .select('id, title, url')
        .eq('chat_id', chat)
        .in('status', ['failed', 'processing', 'pending'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!data) return void (await reply('Nothing to retry.'));
      await reply(`🔁 Retrying ${truncate(data.title ?? data.url ?? '', 80)}…`);
      await processSource(data.id);
      return;
    }

    case 'sync': {
      await typing(chat);
      const r = await syncVault();
      await reply(
        `🔄 Vault synced\nPushed: ${r.pushed} source(s) · Changed: ${r.changed} · Verified: ${r.verified} · Deleted: ${r.deleted} · Restored: ${r.restored}${r.warning ? `\n⚠️ ${r.warning}` : ''}`,
      );
      return;
    }

    case 'stats': {
      const count = async (table: string, filter: (q: any) => any = (q) => q) => {
        const { count } = await filter(db().from(table).select('id', { count: 'exact', head: true }));
        return count ?? 0;
      };
      const [sources, cards, unverified, waiting] = await Promise.all([
        count('sources'),
        count('cards', (q) => q.eq('deleted', false)),
        count('cards', (q) => q.eq('deleted', false).eq('verified', false).eq('kind', 'stat')),
        count('sources', (q) => q.in('status', ['needs_content', 'failed'])),
      ]);
      const kinds = await Promise.all(
        ['stat', 'claim', 'case', 'framework', 'story', 'opportunity'].map(async (k) => `${k} ${await count('cards', (q) => q.eq('deleted', false).eq('kind', k))}`),
      );
      await reply(
        `📚 BANK\nSources: ${sources}\nCards: ${cards} (${kinds.join(', ')})\nUnverified stats: ${unverified}\nWaiting on you: ${waiting}\nSemantic search: ${embeddingsEnabled() ? 'on' : 'off (keyword only)'}\nModel: ${describeModel()}`,
      );
      return;
    }

    case 'digest':
      await typing(chat);
      await runDigest();
      return;

    case 'opportunities':
      await typing(chat);
      await runOpportunityClustering();
      return;

    default:
      await reply(`Unknown command /${command}. Send /help.`);
  }
}
