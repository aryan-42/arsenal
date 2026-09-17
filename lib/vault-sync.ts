import { TOPICS, vault, vaultPath } from './config';
import { db, fetchAll } from './db';
import { embedDocuments } from './embeddings';
import { searchText } from './extract';
import { getBlobText, getTree } from './github';
import { suggestConnections } from './connections';
import { getSection, ideaBodyFromMarkdown, parseFrontmatter } from './markdown';
import type { IdeaRow, SourceRow } from './types';
import { errMsg, shortId } from './util';
import { writeIdeaNote, writeSourceNote } from './vault';

export interface SyncResult {
  pushed: number;
  ideasAdded: number;
  ideasUpdated: number;
  ideasRemoved: number;
  sourcesUpdated: number;
  warning?: string;
}

/** Writes anything that never reached the vault (for example after a GitHub error). */
async function pushUnsynced(): Promise<number> {
  let pushed = 0;
  const { data: srcs } = await db()
    .from('sources')
    .select('id')
    .is('vault_path', null)
    .in('status', ['processed', 'link_only'])
    .order('created_at')
    .limit(8);
  for (const s of (srcs ?? []) as { id: string }[]) {
    await writeSourceNote(s.id);
    pushed++;
  }
  const { data: ideas } = await db()
    .from('ideas')
    .select('id')
    .is('vault_path', null)
    .eq('origin', 'mine')
    .in('status', ['seedling', 'evergreen'])
    .order('created_at')
    .limit(8);
  for (const i of (ideas ?? []) as { id: string }[]) {
    await writeIdeaNote(i.id);
    pushed++;
  }
  return pushed;
}

const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x).toLowerCase().trim()).filter(Boolean) : []);

/**
 * Reads the vault back from GitHub:
 * - ideas you create or edit in `01 Ideas` join the book (and get connection suggestions)
 * - deleted idea files leave it
 * - "What struck me" / "Sessions" you write in Obsidian are indexed
 * - a book marked `status: finished` in Obsidian is marked finished
 */
export async function syncVault(): Promise<SyncResult> {
  const result: SyncResult = { pushed: 0, ideasAdded: 0, ideasUpdated: 0, ideasRemoved: 0, sourcesUpdated: 0 };
  result.pushed = await pushUnsynced();

  const { entries, truncated } = await getTree();
  const ideasPrefix = `${vaultPath(vault.ideas)}/`;
  const sourcesPrefix = `${vaultPath(vault.sources)}/`;
  const ideaFiles = entries.filter((e) => e.type === 'blob' && e.path.startsWith(ideasPrefix) && e.path.endsWith('.md'));
  const sourceFiles = entries.filter((e) => e.type === 'blob' && e.path.startsWith(sourcesPrefix) && e.path.endsWith('.md'));

  // ----- Ideas -----
  const ideas = await fetchAll<IdeaRow>(
    (f, t) => db().from('ideas').select('id, short_id, vault_path, vault_sha, status, body').not('vault_path', 'is', null).range(f, t),
    'sync ideas',
  );
  const byPath = new Map(ideas.map((i) => [i.vault_path!, i]));
  const byShort = new Map(ideas.map((i) => [i.short_id, i]));
  const seen = new Set<string>();
  const newIdeaIds: string[] = [];

  for (const file of ideaFiles) {
    const known = byPath.get(file.path);
    if (known && known.vault_sha === file.sha) {
      seen.add(known.id);
      continue;
    }
    const text = await getBlobText(file.sha);
    const fm = parseFrontmatter(text) ?? {};
    if (fm.type && fm.type !== 'idea') continue;
    const { title, body } = ideaBodyFromMarkdown(text);
    const finalTitle = title || file.path.split('/').pop()!.replace(/\.md$/, '').replace(/ \([a-z0-9]{6}\)$/, '');
    const status = String(fm.status ?? '').toLowerCase() === 'evergreen' ? 'evergreen' : 'seedling';
    const topics = asList(fm.topics).filter((t) => TOPICS.includes(t));
    const match: IdeaRow | undefined = (fm.idea_id ? byShort.get(String(fm.idea_id)) : undefined) ?? known;

    if (match) {
      seen.add(match.id);
      const bodyChanged = match.body !== body;
      const st = searchText(finalTitle, body);
      const [embedding] = bodyChanged ? await embedDocuments([st]) : [undefined];
      await db()
        .from('ideas')
        .update({
          vault_path: file.path,
          vault_sha: file.sha,
          title: finalTitle,
          body,
          status,
          topics,
          search_text: st,
          ...(bodyChanged ? { embedding } : {}),
          updated_at: new Date().toISOString(),
        })
        .eq('id', match.id);
      result.ideasUpdated++;
    } else {
      // An idea you wrote directly in Obsidian
      const st = searchText(finalTitle, body);
      const [embedding] = await embedDocuments([st]);
      const { data, error } = await db()
        .from('ideas')
        .insert({
          short_id: shortId(),
          title: finalTitle,
          body,
          origin: 'mine',
          status,
          topics,
          vault_path: file.path,
          vault_sha: file.sha,
          search_text: st,
          embedding,
        })
        .select('id')
        .single();
      if (!error && data) {
        seen.add(data.id);
        newIdeaIds.push(data.id);
        result.ideasAdded++;
      }
    }
  }

  // Safety: never remove everything because of a wrong folder name or a truncated listing
  if (truncated) {
    result.warning = 'GitHub returned a truncated file list, so removals were skipped.';
  } else if (!ideaFiles.length && ideas.length) {
    result.warning = `No files found in "${ideasPrefix}". Check VAULT_IDEAS_DIR. Removals were skipped.`;
  } else {
    for (const idea of ideas) {
      if (!seen.has(idea.id) && idea.status !== 'deleted') {
        await db().from('ideas').update({ status: 'deleted' }).eq('id', idea.id);
        result.ideasRemoved++;
      }
    }
  }

  // Connection suggestions for a few new Obsidian ideas per run (keeps model usage low)
  for (const id of newIdeaIds.slice(0, 3)) {
    try {
      await suggestConnections(id);
    } catch (e) {
      console.error('sync suggestConnections', errMsg(e));
    }
  }

  // ----- Sources -----
  const sources = await fetchAll<SourceRow>(
    (f, t) => db().from('sources').select('id, vault_path, vault_sha, format, reaction, reading_status').not('vault_path', 'is', null).range(f, t),
    'sync sources',
  );
  const srcByPath = new Map(sources.map((s) => [s.vault_path!, s]));
  for (const file of sourceFiles) {
    const src = srcByPath.get(file.path);
    if (!src || src.vault_sha === file.sha) continue;
    const text = await getBlobText(file.sha);
    const fm = parseFrontmatter(text) ?? {};
    const reaction = getSection(text, src.format === 'book' ? 'Sessions' : 'What struck me') || null;
    const patch: Record<string, unknown> = { vault_sha: file.sha, reaction };
    if (src.format === 'book') {
      const st = String(fm.status ?? '').toLowerCase();
      if (['reading', 'finished', 'abandoned'].includes(st) && st !== src.reading_status) {
        patch.reading_status = st;
        if (st === 'finished') patch.finished_at = new Date().toISOString();
      }
    }
    await db().from('sources').update(patch).eq('id', src.id);
    result.sourcesUpdated++;
  }

  return result;
}
