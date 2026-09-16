import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from './env';
import type { CardRow, SourceRow } from './types';

let client: SupabaseClient | null = null;

export function db(): SupabaseClient {
  if (!client) {
    client = createClient(env.supabaseUrl, env.supabaseKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

function check<T>(result: { data: T; error: { message: string } | null }, what: string): T {
  if (result.error) throw new Error(`Database error (${what}): ${result.error.message}`);
  return result.data;
}

export async function getSource(id: string): Promise<SourceRow> {
  return check(await db().from('sources').select('*').eq('id', id).single(), 'get source') as SourceRow;
}

export async function updateSource(id: string, patch: Partial<SourceRow>): Promise<void> {
  check(await db().from('sources').update(patch).eq('id', id), 'update source');
}

export async function getCardsForSource(sourceId: string): Promise<CardRow[]> {
  return check(
    await db().from('cards').select('*').eq('source_id', sourceId).eq('deleted', false).order('created_at'),
    'get cards',
  ) as CardRow[];
}

export async function sourcesById(ids: string[]): Promise<Map<string, SourceRow>> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  const rows = check(
    await db().from('sources').select('id, short_id, url, format, title, author, created_at, vault_path').in('id', unique),
    'get sources',
  ) as SourceRow[];
  return new Map(rows.map((r) => [r.id, r]));
}

/** Fetch all rows of a query past Supabase's 1000-row page limit. */
export async function fetchAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  what: string,
): Promise<T[]> {
  const out: T[] = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await build(from, from + page - 1);
    if (error) throw new Error(`Database error (${what}): ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < page) break;
  }
  return out;
}

export async function getSetting<T>(key: string): Promise<T | null> {
  const { data } = await db().from('settings').select('value').eq('key', key).maybeSingle();
  return (data?.value as T) ?? null;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  check(
    await db().from('settings').upsert({ key, value, updated_at: new Date().toISOString() }),
    'set setting',
  );
}
