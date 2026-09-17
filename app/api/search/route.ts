import { NextResponse } from 'next/server';
import { obsidianUrl } from '@/lib/dashboard';
import { db } from '@/lib/db';
import { searchBook } from '@/lib/search';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams.get('q')?.trim() ?? '';
  if (q.length < 3) return NextResponse.json({ results: [] });
  const hits = await searchBook(q, { count: 12 });
  const ideaIds = hits.filter((h) => h.kind === 'idea').map((h) => h.id);
  const sourceIds = [...new Set(hits.map((h) => h.source_id).filter((id): id is string => Boolean(id)))];
  const [{ data: ideas }, { data: sources }] = await Promise.all([
    ideaIds.length ? db().from('ideas').select('id, vault_path, status').in('id', ideaIds) : Promise.resolve({ data: [] }),
    sourceIds.length ? db().from('sources').select('id, title, vault_path').in('id', sourceIds) : Promise.resolve({ data: [] }),
  ]);
  const ideaPath = new Map((ideas ?? []).map((i: { id: string; vault_path: string | null }) => [i.id, i.vault_path]));
  const src = new Map((sources ?? []).map((s: { id: string; title: string | null; vault_path: string | null }) => [s.id, s]));
  const vaultName = process.env.OBSIDIAN_VAULT_NAME?.trim() || null;

  return NextResponse.json({
    results: hits.map((h) => {
      const source = h.source_id ? src.get(h.source_id) : undefined;
      const path = h.kind === 'idea' ? ideaPath.get(h.id) ?? source?.vault_path ?? null : source?.vault_path ?? null;
      return {
        kind: h.kind,
        short_id: h.short_id,
        title: h.title,
        body: h.body,
        from: h.kind === 'source' ? null : source?.title ?? null,
        url: obsidianUrl(vaultName, path),
      };
    }),
  });
}
