import { db, getSetting, getSource, setSetting } from './db';
import { setFrontmatterField } from './markdown';
import { registerPrompt } from './prompts';
import { sendMessage } from './telegram';
import type { SourceRow } from './types';
import { dateIST, errMsg, shortId, truncate } from './util';
import { editVaultFiles, recordShas, writeSourceNote } from './vault';

export async function currentBook(): Promise<SourceRow | null> {
  const setting = await getSetting<{ source_id: string }>('current_book');
  if (!setting?.source_id) return null;
  try {
    const book = await getSource(setting.source_id);
    return book.reading_status === 'reading' ? book : null;
  } catch {
    return null;
  }
}

/** "Thinking, Fast and Slow by Daniel Kahneman" -> title + author */
export function parseBookTitle(input: string): { title: string; author: string | null } {
  const m = input.trim().match(/^(.+?)\s+(?:by|-|—|–)\s+(.+)$/i);
  return m ? { title: m[1].trim(), author: m[2].trim() } : { title: input.trim(), author: null };
}

/** Starts a book, or switches to one you're already reading with a matching title. */
export async function startBook(input: string, chatId: number, messageId: number): Promise<void> {
  const { title, author } = parseBookTitle(input);
  const { data: existing } = await db()
    .from('sources')
    .select('*')
    .eq('format', 'book')
    .eq('reading_status', 'reading')
    .ilike('title', `%${title.replace(/[%_]/g, '')}%`)
    .limit(1)
    .maybeSingle();

  let book = existing as SourceRow | null;
  let verb = 'Switched to';
  if (!book) {
    const { data, error } = await db()
      .from('sources')
      .insert({
        short_id: shortId(),
        chat_id: chatId,
        message_id: messageId,
        format: 'book',
        title,
        author,
        status: 'processed',
        reading_status: 'reading',
        started_at: new Date().toISOString(),
        search_text: [title, author].filter(Boolean).join('\n'),
      })
      .select('*')
      .single();
    if (error || !data) throw new Error(`Could not create book: ${error?.message}`);
    book = data as SourceRow;
    verb = 'Now reading';
    try {
      await writeSourceNote(book.id);
    } catch (e) {
      await sendMessage(chatId, `⚠️ Book saved, but the vault note failed: ${truncate(errMsg(e), 120)}`);
    }
  }
  await setSetting('current_book', { source_id: book.id });

  const msg = await sendMessage(
    chatId,
    [
      `📖 ${verb}: ${book.title}${book.author ? ` by ${book.author}` : ''}`,
      '',
      'While reading, send:',
      '• p.84 the passage // why it struck you',
      '• a photo of the page (caption: p.84 bottom paragraph)',
      '• a voice or text note after a session',
      '',
      '/finished when you finish · /books to see all',
    ].join('\n'),
    messageId,
  );
  await registerPrompt(chatId, msg, 'book', book.id);
}

/** Parses "p.84 text // why", "loc 1203: text", "ch 3 text". Returns null if there's no location marker. */
export function parseHighlightMessage(text: string): { location: string; quote: string; why: string | null } | null {
  const m = text.trim().match(/^(p{1,2}\.?|pg\.?|page|loc\.?|location|ch\.?|chapter)\s*(\d+[\d\-–]*)\s*[:.\-–]?\s*([\s\S]+)$/i);
  if (!m) return null;
  const label = m[1].toLowerCase().replace(/\./g, '');
  const prefix = label.startsWith('loc') ? 'loc ' : label.startsWith('ch') ? 'ch ' : 'p.';
  const [quote, ...why] = m[3].split(/\s*\/\/\s*|\s+why:\s*/i);
  return { location: `${prefix}${m[2]}`, quote: quote.trim(), why: why.join(' ').trim() || null };
}

export async function finishBook(chatId: number): Promise<string> {
  const book = await currentBook();
  if (!book) return 'No book in progress. Start one with /reading <title> by <author>.';
  await db()
    .from('sources')
    .update({ reading_status: 'finished', finished_at: new Date().toISOString() })
    .eq('id', book.id);
  await setSetting('current_book', null);
  if (book.vault_path) {
    try {
      const shas = await editVaultFiles(`Finished: ${truncate(book.title ?? '', 50)}`, [
        { path: book.vault_path, transform: (t) => setFrontmatterField(setFrontmatterField(t, 'status', 'finished'), 'finished', dateIST()) },
      ]);
      await recordShas(shas);
    } catch {
      // non-critical
    }
  }
  const { count } = await db().from('highlights').select('id', { count: 'exact', head: true }).eq('source_id', book.id);
  return [
    `🎉 Finished ${book.title} (${count ?? 0} highlights).`,
    '',
    'Close the book properly:',
    '1. /summary what the book says, in your words, without looking back',
    '2. /disagree what you think it gets wrong',
    '3. /idea for the 3–5 ideas you want to keep',
    '',
    "In a month I'll send your highlights back for a second look.",
  ].join('\n');
}

export async function lastFinishedOrCurrentBook(): Promise<SourceRow | null> {
  const current = await currentBook();
  if (current) return current;
  const { data } = await db()
    .from('sources')
    .select('*')
    .eq('format', 'book')
    .eq('reading_status', 'finished')
    .order('finished_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as SourceRow) ?? null;
}

export async function listBooks(): Promise<string> {
  const { data } = await db()
    .from('sources')
    .select('id, title, author, reading_status, started_at, finished_at')
    .eq('format', 'book')
    .order('started_at', { ascending: false })
    .limit(20);
  const books = (data ?? []) as SourceRow[];
  if (!books.length) return 'No books yet. Start one with /reading <title> by <author>.';
  const current = await currentBook();
  const counts = await Promise.all(
    books.map(async (b) => (await db().from('highlights').select('id', { count: 'exact', head: true }).eq('source_id', b.id)).count ?? 0),
  );
  const lines = books.map((b, i) => {
    const mark = current?.id === b.id ? '▶️' : b.reading_status === 'finished' ? '✅' : b.reading_status === 'abandoned' ? '⏸️' : '📖';
    const when = b.reading_status === 'finished' && b.finished_at ? `finished ${dateIST(b.finished_at)}` : `since ${dateIST(b.started_at ?? '')}`;
    return `${mark} ${truncate(b.title ?? '', 60)}${b.author ? ` (${truncate(b.author, 30)})` : ''}\n   ${counts[i]} highlights, ${when}`;
  });
  return `📚 YOUR BOOKS\n\n${lines.join('\n\n')}\n\nSwitch with /reading <title>`;
}
