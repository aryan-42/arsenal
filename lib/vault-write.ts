import { vault, vaultPath } from './config';
import { db, getCardsForSource, getSource } from './db';
import { commitChanges, type FileWrite } from './github';
import { cardFileName, renderCard, renderSource, sourceFileName } from './markdown';
import { fileStem, truncate } from './util';

interface WriteOptions {
  /** Regenerate the source note even if it already exists in the vault. */
  rewriteSource?: boolean;
  /** Old vault files to remove in the same commit. */
  deletePaths?: string[];
}

/**
 * Writes a source note and its not-yet-synced cards to the vault in one commit.
 * Existing card files are never overwritten, so your edits stay safe.
 */
export async function writeSourceToVault(sourceId: string, opts: WriteOptions = {}): Promise<void> {
  const src = await getSource(sourceId);
  const cards = await getCardsForSource(sourceId);

  const sourcePath = src.vault_path ?? vaultPath(vault.sources, sourceFileName(src));
  const sourceStem = fileStem(sourcePath);
  const cardPaths = cards.map((c) => ({ card: c, path: c.vault_path ?? vaultPath(vault.evidence, cardFileName(c)) }));

  const writes: FileWrite[] = [];
  if (!src.vault_path || opts.rewriteSource) {
    writes.push({ path: sourcePath, content: renderSource(src, cardPaths.map((c) => fileStem(c.path))) });
  }
  for (const { card, path } of cardPaths) {
    if (!card.vault_path) writes.push({ path, content: renderCard(card, src, sourceStem) });
  }
  const deletes = (opts.deletePaths ?? []).filter((p) => !writes.some((w) => w.path === p));
  if (!writes.length && !deletes.length) return;

  const shas = await commitChanges(`Arsenal: ${truncate(src.title ?? 'source', 60)}`, writes, deletes);

  if (shas[sourcePath] || !src.vault_path) {
    await db().from('sources').update({ vault_path: sourcePath }).eq('id', src.id);
  }
  for (const { card, path } of cardPaths) {
    if (!card.vault_path && shas[path]) {
      await db().from('cards').update({ vault_path: path, vault_sha: shas[path] }).eq('id', card.id);
    }
  }
}
