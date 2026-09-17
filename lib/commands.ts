import { askBook } from './ask';
import { addBookSection, addHighlightAddendum, addIdeaAddendum, addOwnHighlight, addReaction } from './reflections';
import { currentBook, finishBook, lastFinishedOrCurrentBook, listBooks, parseHighlightMessage, startBook } from './books';
import { NOTE_WINDOW_MINUTES, TOPICS } from './config';
import { decideConnections } from './connections';
import { db, getSetting, getSource, setSetting, updateSource } from './db';
import { embeddingsEnabled } from './embeddings';
import { env } from './env';
import { pdfToText } from './fetchers';
import { createIdea } from './ideas';
import { monthlyReport, resurface, weeklyReview } from './jobs';
import { describeModel } from './llm';
import { markLinkOnly, processSource } from './pipeline';
import { findPrompt, registerPrompt } from './prompts';
import { downloadFile, sendMessage, typing } from './telegram';
import { transcribeVoice } from './transcribe';
import type { SourceRow, TgMessage, TgUpdate } from './types';
import { cleanText, detectFormat, errMsg, extractUrls, normalizeUrl, shortId, stripUrls, truncate } from './util';
import { readImageText } from './vision';
import { syncVault } from './vault-sync';

const HELP = `YOUR COMMONPLACE BOOK

SAVE WHAT YOU READ
• Send a link (article, YouTube, tweet, reel, PDF). Add why in the same message
• Reply to my ✅ message with what struck you
• Send a PDF or .txt file directly

BOOKS
/reading <title> by <author>: start or switch book
While reading: "p.84 passage // why", a page photo, or a voice note
/finished · /summary <text> · /disagree <text> · /books

YOUR IDEAS
/idea <your idea in your own words>
Any text or voice note on its own also becomes an idea
/accept <id> · /reject <id>: decide suggested connections
/dismiss <id>: drop a candidate idea

ASK AND REVISIT
/ask <question>: answers from your book, with references
Reply to a resurfaced idea to add a later thought

MAINTAIN
/topics · /topic add <name> · /stats · /sync
/redo [n] · /retry · /skip · /review · /monthly · /resurface`;

export async function handleUpdate(update: TgUpdate): Promise<void> {
  const msg = update.message;
  if (!msg?.from) return;
  if (String(msg.from.id) !== env.allowedUserId) {
    await sendMessage(msg.chat.id, 'This is a private bot.');
    return;
  }
  try {
    const text = (msg.text ?? msg.caption ?? '').trim();
    if (text.startsWith('/')) return await handleCommand(msg, text);
    if (msg.reply_to_message && (await handleReply(msg))) return;
    if (msg.document) return await handleDocument(msg);
    if (msg.photo?.length) return await handlePhoto(msg);
    if (msg.voice || msg.audio) return await handleVoice(msg);
    if (!text) return;
    const urls = extractUrls(text, msg.entities ?? msg.caption_entities ?? []);
    if (urls.length) return await handleLinks(msg, text, urls);
    return await handlePlainText(msg, text);
  } catch (e) {
    console.error(e);
    await sendMessage(msg.chat.id, `❌ ${truncate(errMsg(e), 400)}`, msg.message_id);
  }
}

// ---------------------------------------------------------------------------
// Replies route to the note the bot message was about
// ---------------------------------------------------------------------------

async function messageText(msg: TgMessage): Promise<string | null> {
  if (msg.voice || msg.audio) {
    const { buffer } = await downloadFile((msg.voice ?? msg.audio)!.file_id);
    return transcribeVoice(buffer, msg.audio?.file_name ?? 'voice.ogg');
  }
  return (msg.text ?? msg.caption ?? '').trim() || null;
}

async function handleReply(msg: TgMessage): Promise<boolean> {
  const prompt = await findPrompt(msg.chat.id, msg.reply_to_message!.message_id);
  if (!prompt) return false;
  const text = await messageText(msg);
  if (!text) return true;
  const reply = (t: string) => sendMessage(msg.chat.id, t, msg.message_id);

  if (prompt.kind === 'source') {
    const src = await getSource(prompt.target_id);
    if (src.status === 'needs_content' && src.format !== 'reel' && text.length > 300) {
      await updateSource(src.id, { raw_text: cleanText(text) });
      await reply('📄 Content added, reading…');
      await processSource(src.id);
      return true;
    }
    await reply(await addReaction(src.id, text));
    return true;
  }
  if (prompt.kind === 'book') {
    const hl = parseHighlightMessage(text);
    await reply(hl ? await addOwnHighlight(prompt.target_id, hl.quote, hl.location, hl.why) : await addReaction(prompt.target_id, text));
    return true;
  }
  if (prompt.kind === 'idea') {
    await reply(await addIdeaAddendum(prompt.target_id, text));
    return true;
  }
  if (prompt.kind === 'highlight') {
    await reply(await addHighlightAddendum(prompt.target_id, text));
    return true;
  }
  return false;
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
        await sendMessage(msg.chat.id, await addReaction(src.id, note), msg.message_id);
      } else {
        const id = await sendMessage(msg.chat.id, `Already in your book: ${truncate(src.title ?? src.url ?? '', 80)}\nReply to add what struck you.`, msg.message_id);
        await registerPrompt(msg.chat.id, id, 'source', src.id);
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
    const hint = format === 'reel' && !note ? '\n🎙️ Reels are mostly unreadable. Send a quick voice or text note on what it says.' : '';
    const id = await sendMessage(msg.chat.id, `📥 Saving to your book…${hint}`, msg.message_id);
    await updateSource(src.id, { bot_message_id: id });
    await registerPrompt(msg.chat.id, id, 'source', src.id);
    await processSource(src.id);
  }
}

/** The capture you just made, if it was within the last few minutes. */
async function recentCapture(chatId: number): Promise<SourceRow | null> {
  const since = new Date(Date.now() - NOTE_WINDOW_MINUTES * 60 * 1000).toISOString();
  const { data } = await db()
    .from('sources')
    .select('*')
    .eq('chat_id', chatId)
    .neq('format', 'book')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as SourceRow) ?? null;
}

async function routeFreeText(msg: TgMessage, text: string): Promise<void> {
  const reply = (t: string) => sendMessage(msg.chat.id, t, msg.message_id);

  // 1. A note for the link you just sent
  const recent = await recentCapture(msg.chat.id);
  if (recent) {
    if (recent.status === 'needs_content' && recent.format !== 'reel' && text.length > 300) {
      await updateSource(recent.id, { raw_text: cleanText(text) });
      await reply('📄 Content added, reading…');
      await processSource(recent.id);
      return;
    }
    if (recent.status === 'needs_content' && recent.format === 'reel') {
      await updateSource(recent.id, { user_note: recent.user_note ? `${recent.user_note}\n${text}` : text });
      await reply('📝 Got it, reading the reel with your note…');
      await processSource(recent.id);
      return;
    }
    if (recent.status === 'pending' || recent.status === 'processing') {
      await updateSource(recent.id, { user_note: recent.user_note ? `${recent.user_note}\n${text}` : text });
      await reply('📝 Added as why you saved it.');
      return;
    }
    await reply(await addReaction(recent.id, text));
    return;
  }

  // 2. Reading mode: highlights and session notes go to the current book
  const book = await currentBook();
  if (book) {
    const hl = parseHighlightMessage(text);
    await reply(hl ? await addOwnHighlight(book.id, hl.quote, hl.location, hl.why) : await addReaction(book.id, text));
    return;
  }

  // 3. Otherwise it's your own idea
  if (text.length < 15) {
    await reply('Send a link to save it, /idea to write an idea, or /help.');
    return;
  }
  await typing(msg.chat.id);
  await createIdea({ text, chatId: msg.chat.id, replyTo: msg.message_id });
}

async function handlePlainText(msg: TgMessage, text: string): Promise<void> {
  await routeFreeText(msg, text);
}

async function handleVoice(msg: TgMessage): Promise<void> {
  await typing(msg.chat.id);
  const text = await messageText(msg);
  if (!text) return;
  await sendMessage(msg.chat.id, `🎙️ "${truncate(text, 200)}"`, msg.message_id);
  await routeFreeText(msg, text);
}

async function handlePhoto(msg: TgMessage): Promise<void> {
  await typing(msg.chat.id);
  const photo = msg.photo!.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a));
  const { buffer, path } = await downloadFile(photo.file_id);
  const caption = (msg.caption ?? '').trim();
  const parsed = caption ? parseHighlightMessage(caption) : null;
  const hint = parsed ? parsed.quote : caption;
  const mediaType = path.endsWith('.png') ? 'image/png' : 'image/jpeg';
  const text = await readImageText(Buffer.from(buffer).toString('base64'), mediaType, hint);
  if (!text) {
    await sendMessage(msg.chat.id, "Couldn't read text in that photo. Try a sharper, well-lit shot.", msg.message_id);
    return;
  }

  const book = await currentBook();
  if (book) {
    const why = parsed?.why ?? null;
    await sendMessage(msg.chat.id, await addOwnHighlight(book.id, text, parsed?.location ?? null, why), msg.message_id);
    return;
  }
  // No book in progress: save the photographed text as a source
  const src = await insertSource({
    chat_id: msg.chat.id,
    message_id: msg.message_id,
    format: 'other',
    title: caption ? truncate(caption, 80) : `Photo: ${truncate(text.split('\n')[0], 60)}`,
    raw_text: text,
    user_note: caption || null,
    status: 'pending',
  });
  if (src) await processSource(src.id);
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
    await sendMessage(msg.chat.id, 'Telegram bots can only download files up to 20 MB. Send a link instead.', msg.message_id);
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
  const id = await sendMessage(msg.chat.id, `📥 ${truncate(title, 60)}: reading…`, msg.message_id);
  await registerPrompt(msg.chat.id, id, 'source', src.id);
  await processSource(src.id);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const IDS = (arg: string) => [...new Set(arg.toLowerCase().split(/[\s,]+/).map((s) => s.replace(/[[\]]/g, '')).filter(Boolean))];

async function handleCommand(msg: TgMessage, text: string): Promise<void> {
  const match = text.match(/^\/(\w+)(?:@\w+)?\s*([\s\S]*)$/);
  const command = match?.[1]?.toLowerCase() ?? '';
  const arg = match?.[2]?.trim() ?? '';
  const chat = msg.chat.id;
  const reply = (t: string) => sendMessage(chat, t, msg.message_id);

  switch (command) {
    case 'start':
    case 'help':
      await reply(HELP);
      return;

    case 'ask':
      if (!arg) return void (await reply('Usage: /ask <question>'));
      await typing(chat);
      await reply(await askBook(arg));
      return;

    case 'idea': {
      if (arg.length < 10) return void (await reply('Write the idea after /idea, in your own words.'));
      await typing(chat);
      // If replying to a capture, link the idea to that source
      let sourceId: string | null = null;
      if (msg.reply_to_message) {
        const p = await findPrompt(chat, msg.reply_to_message.message_id);
        if (p && (p.kind === 'source' || p.kind === 'book')) sourceId = p.target_id;
      }
      if (!sourceId) sourceId = (await currentBook())?.id ?? null;
      await createIdea({ text: arg, chatId: chat, replyTo: msg.message_id, sourceId });
      return;
    }

    case 'accept':
    case 'reject':
      if (!arg) return void (await reply(`Usage: /${command} <connection id>`));
      await reply(await decideConnections(IDS(arg), command === 'accept'));
      return;

    case 'dismiss': {
      if (!arg) return void (await reply('Usage: /dismiss <candidate idea id>'));
      const { data } = await db().from('ideas').update({ status: 'dismissed' }).in('short_id', IDS(arg)).eq('status', 'candidate').select('short_id');
      await reply(data?.length ? `Dismissed: ${data.map((d: { short_id: string }) => d.short_id).join(', ')}` : 'No matching candidate ideas.');
      return;
    }

    case 'reading':
      if (!arg) {
        const book = await currentBook();
        return void (await reply(book ? `▶️ Reading ${book.title}. Switch with /reading <title>.` : 'Start a book: /reading <title> by <author>'));
      }
      await startBook(arg, chat, msg.message_id);
      return;

    case 'books':
      await reply(await listBooks());
      return;

    case 'finished':
      await reply(await finishBook(chat));
      return;

    case 'summary':
    case 'disagree': {
      if (!arg) return void (await reply(`Usage: /${command} <your words>`));
      const book = await lastFinishedOrCurrentBook();
      if (!book) return void (await reply('No book to attach this to. Start one with /reading.'));
      await reply(
        command === 'summary'
          ? await addBookSection(book.id, 'Summary in my words', 'summary', arg)
          : await addBookSection(book.id, 'What I disagree with', 'verdict', arg),
      );
      return;
    }

    case 'topics': {
      const proposals = (await getSetting<Record<string, number>>('topic_proposals')) ?? {};
      const extra = (await getSetting<string[]>('extra_topics')) ?? [];
      const waiting = Object.entries(proposals).sort((a, b) => b[1] - a[1]);
      await reply(
        [
          `TOPICS\n${[...TOPICS, ...extra].join(', ')}`,
          waiting.length ? `\nPROPOSED BY YOUR READING\n${waiting.map(([t, n]) => `• ${t} (${n})`).join('\n')}\nAdd one: /topic add <name>` : '',
          extra.length ? '\nTo make added topics permanent, add them to TOPICS in Vercel.' : '',
        ].join('\n'),
      );
      return;
    }

    case 'topic': {
      const m = arg.match(/^add\s+(.+)$/i);
      if (!m) return void (await reply('Usage: /topic add <name>'));
      const name = m[1].toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      const extra = (await getSetting<string[]>('extra_topics')) ?? [];
      await setSetting('extra_topics', [...new Set([...extra, name])]);
      const proposals = (await getSetting<Record<string, number>>('topic_proposals')) ?? {};
      delete proposals[name];
      await setSetting('topic_proposals', proposals);
      await reply(`Added topic: ${name}\nFor the model to use it, add it to TOPICS in Vercel and redeploy:\nTOPICS=${[...TOPICS, name].join(', ')}`);
      return;
    }

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

    case 'redo': {
      const n = Math.min(Math.max(Number(arg) || 1, 1), 10);
      const { data } = await db()
        .from('sources')
        .select('id')
        .eq('chat_id', chat)
        .neq('format', 'book')
        .in('status', ['processed', 'link_only', 'failed'])
        .order('created_at', { ascending: false })
        .limit(n);
      const rows = (data ?? []) as { id: string }[];
      if (!rows.length) return void (await reply('Nothing to redo yet.'));
      await reply(`🔁 Re-reading ${rows.length} source(s)…`);
      for (const row of rows.reverse()) await processSource(row.id);
      return;
    }

    case 'sync': {
      await typing(chat);
      const r = await syncVault();
      await reply(
        `🔄 Synced with your vault\nWritten: ${r.pushed} · Ideas added from Obsidian: ${r.ideasAdded} · Updated: ${r.ideasUpdated} · Removed: ${r.ideasRemoved} · Sources updated: ${r.sourcesUpdated}${r.warning ? `\n⚠️ ${r.warning}` : ''}`,
      );
      return;
    }

    case 'stats': {
      const count = async (table: string, filter: (q: any) => any = (q) => q) => (await filter(db().from(table).select('id', { count: 'exact', head: true }))).count ?? 0;
      const [sources, books, highlights, mine, candidates, accepted, suggested] = await Promise.all([
        count('sources', (q) => q.neq('format', 'book')),
        count('sources', (q) => q.eq('format', 'book')),
        count('highlights'),
        count('ideas', (q) => q.eq('origin', 'mine').in('status', ['seedling', 'evergreen'])),
        count('ideas', (q) => q.eq('status', 'candidate')),
        count('connections', (q) => q.eq('status', 'accepted')),
        count('connections', (q) => q.eq('status', 'suggested')),
      ]);
      const book = await currentBook();
      await reply(
        [
          '📚 YOUR BOOK',
          `Sources: ${sources} · Books: ${books}${book ? ` (reading ${truncate(book.title ?? '', 40)})` : ''}`,
          `Highlights: ${highlights}`,
          `Ideas in your words: ${mine} · Candidates: ${candidates}`,
          `Connections: ${accepted} accepted, ${suggested} to decide`,
          `Search by meaning: ${embeddingsEnabled() ? 'on' : 'off (add VOYAGE_API_KEY)'}`,
          `Model: ${describeModel()}`,
        ].join('\n'),
      );
      return;
    }

    case 'review':
      await typing(chat);
      await weeklyReview();
      return;

    case 'monthly':
      await typing(chat);
      await monthlyReport();
      return;

    case 'resurface': {
      const r = await resurface();
      if (r.startsWith('nothing')) await reply('Nothing old enough to resurface yet. Ideas come back after a week, highlights after a few days.');
      return;
    }

    default:
      await reply(`Unknown command /${command}. Send /help.`);
  }
}
