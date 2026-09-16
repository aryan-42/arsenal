import { callTool } from './claude';
import { vault, vaultPath } from './config';
import { db, fetchAll, getSetting, sourcesById } from './db';
import { env } from './env';
import { commitChanges } from './github';
import { frontmatter } from './markdown';
import { searchCards } from './search';
import { sendMessage } from './telegram';
import type { CardRow, SourceRow } from './types';
import { dateIST, errMsg, fileStem, truncate } from './util';
import { syncVault } from './vault-sync';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export async function runDigest(): Promise<string> {
  let syncNote = '';
  try {
    const sync = await syncVault();
    if (sync.warning) syncNote = `\n⚠️ Vault sync: ${sync.warning}`;
  } catch (e) {
    syncNote = `\n⚠️ Vault sync failed: ${truncate(errMsg(e), 120)}`;
  }

  const since = new Date(Date.now() - WEEK_MS).toISOString();
  const { data: weekSources } = await db().from('sources').select('format, status').gte('created_at', since);
  const { data: weekCards } = await db().from('cards').select('kind').gte('created_at', since).eq('deleted', false);
  const { count: unverified } = await db()
    .from('cards')
    .select('id', { count: 'exact', head: true })
    .eq('deleted', false)
    .eq('verified', false)
    .eq('kind', 'stat');
  const { data: oldest } = await db()
    .from('cards')
    .select('short_id, title, fields')
    .eq('deleted', false)
    .eq('verified', false)
    .eq('kind', 'stat')
    .order('created_at')
    .limit(5);
  const { count: stuck } = await db()
    .from('sources')
    .select('id', { count: 'exact', head: true })
    .in('status', ['needs_content', 'failed']);

  const tally = (rows: { [k: string]: string }[] | null, key: string) =>
    Object.entries((rows ?? []).reduce<Record<string, number>>((acc, r) => ({ ...acc, [r[key]]: (acc[r[key]] ?? 0) + 1 }), {}))
      .map(([k, n]) => `${n} ${k}`)
      .join(', ') || 'none';

  const lines: (string | null)[] = [
    '🗓️ WEEKLY DIGEST',
    '',
    `Captured: ${weekSources?.length ?? 0} sources (${tally(weekSources as { format: string }[] | null, 'format')})`,
    `New cards: ${weekCards?.length ?? 0} (${tally(weekCards as { kind: string }[] | null, 'kind')})`,
    `Unverified stats in bank: ${unverified ?? 0}`,
    stuck ? `Sources waiting on you: ${stuck} (needs content or failed)` : null,
  ];

  if (oldest?.length) {
    lines.push('', 'VERIFY FIRST (oldest)');
    for (const c of oldest as { short_id: string; title: string; fields: { value?: string; unit?: string } }[]) {
      lines.push(`[${c.short_id}] ${truncate(c.title, 90)}`);
    }
    lines.push('Verify with: /verify id id');
  }

  const focus = await getSetting<{ text: string }>('focus');
  const resurfaced = focus?.text
    ? (await searchCards(focus.text, { count: 12 })).filter((c) => new Date(c.created_at).getTime() < Date.now() - WEEK_MS).slice(0, 5)
    : [];
  if (resurfaced.length) {
    const sources = await sourcesById(resurfaced.map((c) => c.source_id));
    lines.push('', `RESURFACED FOR YOUR FOCUS: ${truncate(focus!.text, 60)}`);
    for (const c of resurfaced) {
      lines.push(`[${c.short_id}] ${truncate(c.title, 80)} (${truncate(sources.get(c.source_id)?.title ?? '', 40)})`);
    }
  } else if (!focus?.text) {
    lines.push('', 'Tip: set /focus <what you are working on> to get relevant old cards resurfaced here.');
  }

  const text = lines.filter((l): l is string => l !== null).join('\n') + syncNote;
  await sendMessage(env.allowedUserId, text);
  return text;
}

interface ClusterOutput {
  clusters: { name: string; synthesis: string; card_ids: string[]; open_question: string }[];
}

export async function runOpportunityClustering(): Promise<string> {
  const since = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString();
  const cards = await fetchAll<CardRow>(
    (from, to) =>
      db().from('cards').select('*').eq('kind', 'opportunity').eq('deleted', false).gte('created_at', since).order('created_at').range(from, to),
    'opportunity cards',
  );
  if (cards.length < 3) {
    const msg = `💡 Monthly opportunities: only ${cards.length} opportunity card(s) in the last 6 months. Not enough to cluster yet.`;
    await sendMessage(env.allowedUserId, msg);
    return msg;
  }

  const sources = await sourcesById(cards.map((c) => c.source_id));
  const list = cards
    .slice(-200)
    .map((c) => {
      const f = c.fields;
      return `[${c.short_id}] ${c.title}\nProblem: ${f.problem ?? c.body}\nWho: ${f.who_has_it ?? '-'}\nWorkaround: ${f.current_workaround ?? '-'}\nWhy now: ${f.why_now ?? '-'}\nSource: ${sources.get(c.source_id)?.title ?? '-'}`;
    })
    .join('\n\n');

  const out = await callTool<ClusterOutput>({
    system: `Group startup-opportunity evidence cards into problem spaces. A cluster must share the same underlying problem, not just a sector. Only use the cards given. Leave out cards that fit nowhere. Write a 2-3 sentence synthesis per cluster and one open question that would validate or kill it.`,
    user: list,
    toolName: 'save_clusters',
    toolDescription: 'Save the problem-space clusters.',
    schema: {
      type: 'object',
      properties: {
        clusters: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              synthesis: { type: 'string' },
              card_ids: { type: 'array', items: { type: 'string' } },
              open_question: { type: 'string' },
            },
            required: ['name', 'synthesis', 'card_ids', 'open_question'],
          },
        },
      },
      required: ['clusters'],
    },
    maxTokens: 4000,
  });

  const byShort = new Map(cards.map((c) => [c.short_id, c]));
  const enriched = out.clusters
    .map((cl) => {
      const members = cl.card_ids.map((id) => byShort.get(id)).filter((c): c is CardRow => Boolean(c));
      const distinctSources = new Set(members.map((m) => m.source_id)).size;
      return { ...cl, members, distinctSources };
    })
    .filter((cl) => cl.members.length)
    .sort((a, b) => b.distinctSources - a.distinctSources);

  const month = dateIST().slice(0, 7);
  const md = [
    frontmatter({ type: 'opportunity-clusters', created: dateIST() }),
    `# Opportunity clusters ${month}`,
    '_Problems seen in 3+ independent sources are validation signals. Turn strong ones into a thesis note in 01 Notes._',
    ...enriched.map((cl) =>
      [
        `## ${cl.distinctSources >= 3 ? '🔥 ' : ''}${cl.name} (${cl.distinctSources} source${cl.distinctSources === 1 ? '' : 's'})`,
        cl.synthesis,
        `**Open question:** ${cl.open_question}`,
        cl.members.map((m) => `- ${m.vault_path ? `[[${fileStem(m.vault_path)}]]` : `${m.title} (${m.short_id})`} (${(sources.get(m.source_id) as SourceRow | undefined)?.title ?? ''})`).join('\n'),
      ].join('\n\n'),
    ),
  ].join('\n\n');

  const path = vaultPath(vault.inbox, `Opportunity clusters ${month}.md`);
  let saved = `Saved: ${path}`;
  try {
    await commitChanges(`Arsenal: opportunity clusters ${month}`, [{ path, content: md }]);
  } catch (e) {
    saved = `Vault save failed: ${truncate(errMsg(e), 100)}`;
  }

  const msg = [
    `💡 MONTHLY OPPORTUNITY CLUSTERS (${cards.length} cards)`,
    '',
    ...enriched.slice(0, 8).map((cl) => `${cl.distinctSources >= 3 ? '🔥' : '•'} ${cl.name}: ${cl.distinctSources} source(s)\n   ${truncate(cl.open_question, 140)}`),
    '',
    saved,
  ].join('\n');
  await sendMessage(env.allowedUserId, msg);
  return msg;
}
