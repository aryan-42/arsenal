import { db, getSource, updateSource } from './db';
import { embedDocuments } from './embeddings';
import { extract, isIncomplete, searchTextFor, type Extraction } from './extract';
import { fetchContent } from './fetchers';
import { sendMessage, typing } from './telegram';
import type { CardKind, SourceRow } from './types';
import { errMsg, shortId, truncate } from './util';
import { writeSourceToVault } from './vault-write';

const KIND_EMOJI: Record<CardKind, string> = {
  stat: '📊',
  claim: '💬',
  case: '🏢',
  framework: '🧩',
  story: '📖',
  opportunity: '💡',
};

/** Full pipeline for one source. Safe to call again (re-extracts and replaces cards). */
export async function processSource(sourceId: string): Promise<void> {
  let src = await getSource(sourceId);
  await typing(src.chat_id);
  try {
    await updateSource(src.id, { status: 'processing', error: null });

    // 1. Fetch content if we don't have it yet
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

    // 2. Without content, a reel can still work from your note; everything else asks for help
    const canExtract = Boolean(src.raw_text) || (src.format === 'reel' && Boolean(src.user_note));
    if (!canExtract) {
      await updateSource(src.id, { status: 'needs_content' });
      const ask =
        src.format === 'reel'
          ? 'Send a voice or text note on what this reel says and why it matters.'
          : 'Paste the text or transcript as your next message.';
      await sendMessage(
        src.chat_id,
        `⚠️ ${truncate(src.title ?? src.url ?? 'Source', 80)}\n${src.error ?? 'No readable content.'}\n\n${ask}\nOr send /skip to keep just the link.`,
        src.message_id,
      );
      return;
    }

    // 3. Extract; if you added a note while this was running, re-run once so it is used
    let extraction: Extraction | null = null;
    const oldVaultPaths: string[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const noteUsed = src.user_note;
      extraction = await extract(src);
      oldVaultPaths.push(...(await saveExtraction(src, extraction)));
      src = await getSource(src.id);
      if (src.user_note === noteUsed) break;
    }

    await updateSource(src.id, { status: 'processed', processed_at: new Date().toISOString() });
    src = await getSource(src.id);

    // 4. Vault
    let vaultNote = '';
    try {
      await writeSourceToVault(src.id, { rewriteSource: true, deletePaths: oldVaultPaths });
    } catch (e) {
      vaultNote = `\n⚠️ Saved, but the vault write failed: ${truncate(errMsg(e), 150)}. Send /sync to retry.`;
    }

    await sendMessage(src.chat_id, summaryMessage(src, extraction!) + vaultNote, src.message_id);
  } catch (e) {
    await updateSource(src.id, { status: 'failed', error: truncate(errMsg(e), 500) });
    await sendMessage(src.chat_id, `❌ Failed: ${truncate(errMsg(e), 300)}\nSend /retry to try again.`, src.message_id);
  }
}

/** Replaces the source's cards. Returns vault paths of the replaced cards (to delete from the vault). */
async function saveExtraction(src: SourceRow, extraction: Extraction): Promise<string[]> {
  const { data: oldCards } = await db().from('cards').select('vault_path').eq('source_id', src.id);
  const oldPaths = (oldCards ?? []).map((c: { vault_path: string | null }) => c.vault_path).filter((p): p is string => Boolean(p));

  const del = await db().from('cards').delete().eq('source_id', src.id);
  if (del.error) throw new Error(`Could not replace old cards: ${del.error.message}`);

  const rows = extraction.cards.map((c) => {
    const fields = c.fields ?? {};
    return {
      short_id: shortId(),
      source_id: src.id,
      kind: c.kind,
      title: c.title.trim(),
      body: c.body?.trim() ?? '',
      fields,
      implication: c.implication?.trim() || null,
      domains: c.domains,
      use_for: c.use_for,
      verified: false,
      incomplete: isIncomplete(c.kind, fields),
      search_text: searchTextFor({ title: c.title, body: c.body ?? '', implication: c.implication, fields, domains: c.domains }),
    };
  });

  if (rows.length) {
    const embeddings = await embedDocuments(rows.map((r) => r.search_text));
    const insert = await db()
      .from('cards')
      .insert(rows.map((r, i) => ({ ...r, embedding: embeddings[i] })));
    if (insert.error) throw new Error(`Could not save cards: ${insert.error.message}`);
  }

  await updateSource(src.id, {
    title: src.url && src.title ? src.title : extraction.source.title,
    author: src.author ?? extraction.source.author ?? null,
    summary: extraction.source.summary,
    key_points: extraction.source.key_points,
    domains: extraction.source.domains,
  });
  return oldPaths;
}

function summaryMessage(src: SourceRow, extraction: Extraction): string {
  const cards = extraction.cards;
  const header = `✅ ${truncate(src.title ?? 'Saved', 90)}`;
  if (!cards.length) {
    return `${header}\nNo reusable evidence, archived with summary only.`;
  }
  return [header, `${cards.length} card${cards.length === 1 ? '' : 's'}:`, ...cards.map((c) => `${KIND_EMOJI[c.kind]} ${truncate(c.title, 80)}`)]
    .concat(cards.some((c) => c.kind === 'stat') ? ['', '⚠️ Stats are unverified until checked. /unverified'] : [])
    .join('\n');
}

/** Keep the link (and note) without extraction. */
export async function markLinkOnly(sourceId: string): Promise<void> {
  await updateSource(sourceId, { status: 'link_only', processed_at: new Date().toISOString() });
  await writeSourceToVault(sourceId, { rewriteSource: true });
}
