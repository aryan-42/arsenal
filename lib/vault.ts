import { vault, vaultPath } from './config';
import { db, getHighlights, getIdea, getSource } from './db';
import { commitChanges, getFileText, type FileWrite } from './github';
import { appendToSection, getSection, ideaFileName, renderIdea, renderSource, replaceSection, sourceFileName } from './markdown';
import type { IdeaRow, SourceRow } from './types';
import { dateIST, fileStem, truncate } from './util';

export function sourceStem(src: Pick<SourceRow, 'vault_path' | 'title' | 'short_id' | 'format' | 'author'>): string {
  return fileStem(src.vault_path ?? sourceFileName(src));
}

export function ideaStem(idea: Pick<IdeaRow, 'vault_path' | 'title' | 'short_id'>): string {
  return fileStem(idea.vault_path ?? ideaFileName(idea));
}

/**
 * Writes (or rewrites) a source note, plus its raw text archive, in one commit.
 * When rewriting, sections you write yourself are carried over from the existing file.
 */
export async function writeSourceNote(sourceId: string): Promise<void> {
  const src = await getSource(sourceId);
  const highlights = await getHighlights(sourceId);
  const { data: cands } = await db()
    .from('ideas')
    .select('title, body, short_id')
    .eq('source_id', sourceId)
    .eq('status', 'candidate')
    .order('created_at');

  const path = src.vault_path ?? vaultPath(vault.sources, sourceFileName(src));
  let content = renderSource(src, highlights, (cands ?? []) as { title: string; body: string; short_id: string }[]);

  // Keep what you wrote
  const personal = src.format === 'book'
    ? ['Why I\'m reading it', 'Sessions', 'Summary in my words', 'Ideas from this book', 'What I disagree with', 'One month later']
    : ['What struck me'];
  const existing = src.vault_path ? await getFileText(src.vault_path) : null;
  for (const heading of personal) {
    const mine = existing ? getSection(existing, heading) : null;
    if (mine) content = replaceSection(content, heading, mine);
  }
  if (!existing && src.reaction && src.format !== 'book') content = replaceSection(content, 'What struck me', src.reaction);

  const writes: FileWrite[] = [{ path, content }];
  let archivePath = src.archive_path;
  if (src.raw_text && src.format !== 'book' && !archivePath) {
    archivePath = vaultPath(vault.archive, `${src.short_id}.txt`);
    writes.push({
      path: archivePath,
      content: [
        `Title: ${src.title ?? ''}`,
        `Author: ${src.author ?? ''}`,
        `URL: ${src.url ?? ''}`,
        `Captured: ${dateIST(src.created_at)}`,
        '',
        src.raw_text,
      ].join('\n'),
    });
    content = content.replace(/^topics:/m, `archive: ${JSON.stringify(archivePath)}\ntopics:`);
    writes[0] = { path, content };
  }

  const shas = await commitChanges(`Book: ${truncate(src.title ?? 'source', 60)}`, writes);
  await db()
    .from('sources')
    .update({ vault_path: path, vault_sha: shas[path] ?? null, archive_path: archivePath })
    .eq('id', src.id);
}

/** Creates an idea note. Never overwrites an existing file. */
export async function writeIdeaNote(ideaId: string): Promise<void> {
  const idea = await getIdea(ideaId);
  if (idea.vault_path) return;
  const src = idea.source_id ? await getSource(idea.source_id) : null;
  const path = vaultPath(vault.ideas, ideaFileName(idea));
  const writes: FileWrite[] = [{ path, content: renderIdea(idea, src ? sourceStem(src) : null) }];

  // For books, list the idea in the book note too
  if (src?.format === 'book' && src.vault_path) {
    const book = await getFileText(src.vault_path);
    if (book) {
      writes.push({ path: src.vault_path, content: appendToSection(book, 'Ideas from this book', `- [[${fileStem(path)}]]`) });
    }
  }
  const shas = await commitChanges(`Idea: ${truncate(idea.title, 60)}`, writes);
  await db().from('ideas').update({ vault_path: path, vault_sha: shas[path] ?? null }).eq('id', idea.id);
  if (src?.vault_path && shas[src.vault_path]) {
    await db().from('sources').update({ vault_sha: shas[src.vault_path] }).eq('id', src.id);
  }
}

/**
 * Edits existing vault files in one commit. Each transform receives the current text.
 * Files that don't exist are skipped. Returns new blob shas by path.
 */
export async function editVaultFiles(
  message: string,
  edits: { path: string; transform: (text: string) => string }[],
): Promise<Record<string, string>> {
  const writes: FileWrite[] = [];
  for (const edit of edits) {
    const current = await getFileText(edit.path);
    if (current === null) continue;
    const next = edit.transform(current);
    if (next !== current) writes.push({ path: edit.path, content: next });
  }
  if (!writes.length) return {};
  return commitChanges(message, writes);
}

/** Keeps stored blob shas in step after an edit, so the next sync doesn't re-read the files. */
export async function recordShas(shas: Record<string, string>): Promise<void> {
  for (const [path, sha] of Object.entries(shas)) {
    await db().from('sources').update({ vault_sha: sha }).eq('vault_path', path);
    await db().from('ideas').update({ vault_sha: sha }).eq('vault_path', path);
  }
}
