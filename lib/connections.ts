import { OWNER_CONTEXT } from './config';
import { db } from './db';
import { callTool } from './llm';
import { formatConnection } from './markdown';
import { appendToSection, getSection, replaceSection } from './markdown';
import { searchBook } from './search';
import { RELATIONS, type ConnectionRow, type IdeaRow, type Relation } from './types';
import { errMsg, shortId, truncate } from './util';
import { editVaultFiles, ideaStem, recordShas } from './vault';

const REVERSE: Record<Relation, Relation | 'has-example' | 'extended-by'> = {
  supports: 'supports',
  contradicts: 'contradicts',
  'same-pattern': 'same-pattern',
  'example-of': 'has-example',
  extends: 'extended-by',
};

function reverseLine(relation: Relation, targetStem: string, reason: string): string {
  const r = REVERSE[relation];
  if (r === 'has-example') return `- Has an example in [[${targetStem}]]${reason ? `: ${reason}` : ''}`;
  if (r === 'extended-by') return `- Is extended by [[${targetStem}]]${reason ? `: ${reason}` : ''}`;
  return formatConnection(r, targetStem, reason);
}

interface Suggestion {
  id: string;
  relation: Relation;
  reason: string;
}

const SYSTEM = `You find genuine connections between ideas in a lifelong commonplace book.

${OWNER_CONTEXT}

You get one NEW idea and several EXISTING ideas. Return only connections a thoughtful reader would find meaningful.

Relations:
- supports: makes the same point from a different angle or with different evidence
- contradicts: in real tension; both cannot be fully right as stated (the most valuable kind; look for it)
- example-of: the NEW idea is a concrete case of the EXISTING, more general idea
- extends: the NEW idea builds on, refines or qualifies the EXISTING idea
- same-pattern: the same underlying mechanism in a different domain

Rules:
- Surface-level topic overlap is not a connection. "Both are about leadership" is not enough.
- The reason is one specific sentence naming what links them.
- Return at most 4 connections, strongest first. Returning none is fine.`;

/** Finds likely related ideas and asks the model to label real relationships. Stores them as suggestions. */
export async function suggestConnections(ideaId: string): Promise<(ConnectionRow & { other: IdeaRow })[]> {
  const { data: ideaData } = await db().from('ideas').select('*').eq('id', ideaId).single();
  const idea = ideaData as IdeaRow;
  const hits = await searchBook(`${idea.title}\n${idea.body}`, { kinds: ['idea'], count: 12 });
  const ids = hits.map((h) => h.id).filter((id) => id !== idea.id);
  if (!ids.length) return [];

  const { data: others } = await db()
    .from('ideas')
    .select('*')
    .in('id', ids)
    .in('status', ['seedling', 'evergreen']);
  const pool = ((others ?? []) as IdeaRow[]).sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)).slice(0, 8);
  if (!pool.length) return [];

  const { data: existing } = await db()
    .from('connections')
    .select('from_idea, to_idea')
    .or(`from_idea.eq.${idea.id},to_idea.eq.${idea.id}`);
  const linked = new Set((existing ?? []).flatMap((c: { from_idea: string; to_idea: string }) => [c.from_idea, c.to_idea]));
  const candidates = pool.filter((o) => !linked.has(o.id));
  if (!candidates.length) return [];

  let result: { connections?: Suggestion[] };
  try {
    result = await callTool<{ connections?: Suggestion[] }>({
      system: SYSTEM,
      user: `NEW IDEA\nTitle: ${idea.title}\n${idea.body}\n\nEXISTING IDEAS\n${candidates
        .map((c) => `[${c.short_id}] ${c.title}\n${truncate(c.body, 500)}`)
        .join('\n\n')}`,
      toolName: 'save_connections',
      toolDescription: 'Save the meaningful connections between the new idea and existing ideas.',
      schema: {
        type: 'object',
        properties: {
          connections: {
            type: 'array',
            maxItems: 4,
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'The existing idea id in square brackets, without brackets' },
                relation: { type: 'string', enum: RELATIONS },
                reason: { type: 'string' },
              },
              required: ['id', 'relation', 'reason'],
            },
          },
        },
        required: ['connections'],
      },
      maxTokens: 1500,
    });
  } catch (e) {
    console.error('suggestConnections', errMsg(e));
    return [];
  }

  const byShort = new Map(candidates.map((c) => [c.short_id, c]));
  const saved: (ConnectionRow & { other: IdeaRow })[] = [];
  for (const s of (result.connections ?? []).slice(0, 4)) {
    const other = byShort.get(String(s.id).replace(/[[\]]/g, '').trim());
    if (!other || !RELATIONS.includes(s.relation)) continue;
    const { data, error } = await db()
      .from('connections')
      .insert({
        short_id: shortId(),
        from_idea: idea.id,
        to_idea: other.id,
        relation: s.relation,
        reason: String(s.reason ?? '').trim(),
        status: 'suggested',
      })
      .select('*')
      .single();
    if (!error && data) saved.push({ ...(data as ConnectionRow), other });
  }

  if (saved.length && idea.vault_path) {
    const lines = saved.map(
      (c) => `${formatConnection(c.relation, ideaStem(c.other), c.reason)} _(suggested: /accept ${c.short_id})_`,
    );
    try {
      const shas = await editVaultFiles(`Connections for: ${truncate(idea.title, 50)}`, [
        {
          path: idea.vault_path,
          transform: (t) => {
            const current = getSection(t, 'Possible connections');
            return replaceSection(t, 'Possible connections', [current, ...lines].filter(Boolean).join('\n'));
          },
        },
      ]);
      await recordShas(shas);
    } catch (e) {
      console.error('write suggestions', errMsg(e));
    }
  }
  return saved;
}

function removeSuggestionLine(text: string, connectionShortId: string): string {
  const current = getSection(text, 'Possible connections');
  if (current === null) return text;
  const kept = current
    .split('\n')
    .filter((l) => !l.includes(connectionShortId))
    .join('\n')
    .trim();
  if (kept) return replaceSection(text, 'Possible connections', kept);
  // Drop the whole section when empty
  return text.replace(/\n## Possible connections\n[\s\S]*?(?=\n## |\s*$)/, '\n');
}

export async function decideConnections(shortIds: string[], accept: boolean): Promise<string> {
  const { data } = await db().from('connections').select('*').in('short_id', shortIds);
  const rows = (data ?? []) as ConnectionRow[];
  if (!rows.length) return 'No matching connections.';

  const ideaIds = [...new Set(rows.flatMap((r) => [r.from_idea, r.to_idea]))];
  const { data: ideasData } = await db().from('ideas').select('*').in('id', ideaIds);
  const ideas = new Map(((ideasData ?? []) as IdeaRow[]).map((i) => [i.id, i]));

  const edits = new Map<string, ((t: string) => string)[]>();
  const addEdit = (path: string | null, fn: (t: string) => string) => {
    if (!path) return;
    edits.set(path, [...(edits.get(path) ?? []), fn]);
  };

  for (const row of rows) {
    const from = ideas.get(row.from_idea);
    const to = ideas.get(row.to_idea);
    if (!from || !to) continue;
    await db()
      .from('connections')
      .update({ status: accept ? 'accepted' : 'rejected', decided_at: new Date().toISOString() })
      .eq('id', row.id);
    addEdit(from.vault_path, (t) => removeSuggestionLine(t, row.short_id));
    if (accept) {
      addEdit(from.vault_path, (t) => appendToSection(t, 'Connections', formatConnection(row.relation, ideaStem(to), row.reason)));
      addEdit(to.vault_path, (t) => appendToSection(t, 'Connections', reverseLine(row.relation, ideaStem(from), row.reason)));
    }
  }

  try {
    const shas = await editVaultFiles(`${accept ? 'Accept' : 'Reject'} ${rows.length} connection(s)`, [
      ...edits.entries(),
    ].map(([path, fns]) => ({ path, transform: (t: string) => fns.reduce((acc, fn) => fn(acc), t) })));
    await recordShas(shas);
  } catch (e) {
    return `${accept ? '🔗 Accepted' : '✖️ Rejected'} ${rows.length}, but updating the vault failed: ${truncate(errMsg(e), 120)}`;
  }
  const missing = shortIds.filter((id) => !rows.some((r) => r.short_id === id));
  return `${accept ? '🔗 Accepted' : '✖️ Rejected'}: ${rows.map((r) => r.short_id).join(', ')}${missing.length ? `\nNot found: ${missing.join(', ')}` : ''}`;
}
