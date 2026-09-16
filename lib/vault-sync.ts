import { vault, vaultPath } from './config';
import { db, fetchAll } from './db';
import { commitChanges, getBlobText, getFileText, getTree } from './github';
import { parseFrontmatter } from './markdown';
import { truncate } from './util';
import { writeSourceToVault } from './vault-write';

export interface SyncResult {
  pushed: number;
  changed: number;
  verified: number;
  unverified: number;
  deleted: number;
  restored: number;
  warning?: string;
}

interface SyncCard {
  id: string;
  short_id: string;
  source_id: string;
  vault_path: string | null;
  vault_sha: string | null;
  verified: boolean;
  deleted: boolean;
}

/** Push cards that never reached the vault (for example after a GitHub error). */
async function pushUnsynced(): Promise<number> {
  const { data } = await db()
    .from('cards')
    .select('source_id')
    .is('vault_path', null)
    .eq('deleted', false)
    .limit(200);
  const sourceIds = [...new Set((data ?? []).map((r: { source_id: string }) => r.source_id))].slice(0, 10);
  for (const id of sourceIds) await writeSourceToVault(id);
  return sourceIds.length;
}

/**
 * Reads the vault back from GitHub and applies what you did in Obsidian:
 * verified: true/false edits, deleted files, and renamed files.
 */
export async function syncVault(): Promise<SyncResult> {
  const result: SyncResult = { pushed: 0, changed: 0, verified: 0, unverified: 0, deleted: 0, restored: 0 };
  result.pushed = await pushUnsynced();

  const { entries, truncated } = await getTree();
  const prefix = `${vaultPath(vault.evidence)}/`;
  const files = entries.filter((e) => e.type === 'blob' && e.path.startsWith(prefix) && e.path.endsWith('.md'));

  const cards = await fetchAll<SyncCard>(
    (from, to) =>
      db().from('cards').select('id, short_id, source_id, vault_path, vault_sha, verified, deleted').not('vault_path', 'is', null).range(from, to),
    'sync cards',
  );
  const byPath = new Map(cards.map((c) => [c.vault_path!, c]));
  const byShort = new Map(cards.map((c) => [c.short_id, c]));
  const seen = new Set<string>();

  for (const file of files) {
    const known = byPath.get(file.path);
    if (known && known.vault_sha === file.sha) {
      seen.add(known.id);
      if (known.deleted) {
        await db().from('cards').update({ deleted: false }).eq('id', known.id);
        result.restored++;
      }
      continue;
    }
    const fm = parseFrontmatter(await getBlobText(file.sha));
    const card = fm?.card_id ? byShort.get(String(fm.card_id)) : undefined;
    if (!card) continue;
    seen.add(card.id);

    const verified = fm!.verified === true || fm!.verified === 'true';
    await db()
      .from('cards')
      .update({ vault_path: file.path, vault_sha: file.sha, verified, deleted: false, updated_at: new Date().toISOString() })
      .eq('id', card.id);
    result.changed++;
    if (verified && !card.verified) result.verified++;
    if (!verified && card.verified) result.unverified++;
    if (card.deleted) result.restored++;
  }

  // Safety: never mass-delete because of a misconfigured folder or a truncated tree
  if (truncated) {
    result.warning = 'GitHub returned a truncated file list, so deletions were skipped.';
  } else if (!files.length && cards.length) {
    result.warning = `No files found in "${prefix}". Check VAULT_EVIDENCE_DIR and VAULT_ROOT. Deletions were skipped.`;
  } else {
    const missing = cards.filter((c) => !c.deleted && !seen.has(c.id));
    for (const card of missing) {
      await db().from('cards').update({ deleted: true }).eq('id', card.id);
      result.deleted++;
    }
  }
  return result;
}

/** Sets verified on cards and mirrors the change into their vault files. */
export async function setVerified(shortIds: string[], value: boolean): Promise<string> {
  const { data } = await db().from('cards').select('id, short_id, vault_path, deleted').in('short_id', shortIds);
  const rows = (data ?? []) as { id: string; short_id: string; vault_path: string | null; deleted: boolean }[];
  const missing = shortIds.filter((id) => !rows.some((r) => r.short_id === id));

  const writes: { path: string; content: string }[] = [];
  for (const row of rows) {
    await db().from('cards').update({ verified: value, updated_at: new Date().toISOString() }).eq('id', row.id);
    if (!row.vault_path) continue;
    const text = await getFileText(row.vault_path);
    if (!text) continue;
    let updated = text.replace(/^verified:\s*(true|false)\s*$/m, `verified: ${value}`);
    if (value) updated = updated.replace(/\n> \[!warning\] Unverified\n> [^\n]*\n?/, '\n');
    if (updated !== text) writes.push({ path: row.vault_path, content: updated });
  }
  if (writes.length) {
    const shas = await commitChanges(`Arsenal: ${value ? 'verify' : 'unverify'} ${rows.length} card(s)`, writes);
    for (const row of rows) {
      if (row.vault_path && shas[row.vault_path]) {
        await db().from('cards').update({ vault_sha: shas[row.vault_path] }).eq('id', row.id);
      }
    }
  }
  const done = rows.map((r) => r.short_id).join(', ');
  return [
    done ? `${value ? '✅ Verified' : '↩️ Unverified'}: ${done}` : '',
    missing.length ? `Not found: ${missing.join(', ')}` : '',
  ].filter(Boolean).join('\n');
}

export async function deleteCards(shortIds: string[]): Promise<string> {
  const { data } = await db().from('cards').select('id, short_id, vault_path').in('short_id', shortIds);
  const rows = (data ?? []) as { id: string; short_id: string; vault_path: string | null }[];
  if (!rows.length) return 'No matching cards.';
  const paths = rows.map((r) => r.vault_path).filter((p): p is string => Boolean(p));
  if (paths.length) await commitChanges(`Arsenal: delete ${rows.length} card(s)`, [], paths);
  await db().from('cards').update({ deleted: true, vault_path: null, vault_sha: null }).in('id', rows.map((r) => r.id));
  return `🗑️ Deleted: ${truncate(rows.map((r) => r.short_id).join(', '), 200)}`;
}
