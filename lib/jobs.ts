import { OWNER_CONTEXT, TOPICS, vault, vaultPath } from './config';
import { db, fetchAll, getSetting } from './db';
import { env } from './env';
import { commitChanges, getFileText } from './github';
import { callText } from './llm';
import { frontmatter, replaceSection } from './markdown';
import { registerPrompt } from './prompts';
import { sendMessage } from './telegram';
import type { ConnectionRow, HighlightRow, IdeaRow, SourceRow } from './types';
import { dateIST, errMsg, truncate } from './util';
import { ideaStem, sourceStem } from './vault';
import { syncVault } from './vault-sync';

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (iso: string) => Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / DAY));

// ---------------------------------------------------------------------------
// Daily: resurface one old idea or highlight
// ---------------------------------------------------------------------------

export async function resurface(): Promise<string> {
  const weekAgo = new Date(Date.now() - 7 * DAY).toISOString();
  const { data: ideaData } = await db()
    .from('ideas')
    .select('*')
    .in('status', ['seedling', 'evergreen'])
    .lt('created_at', weekAgo)
    .order('last_surfaced_at', { ascending: true, nullsFirst: true })
    .limit(5);
  const ideas = (ideaData ?? []) as IdeaRow[];

  // Finished books get their highlights back about a month later
  const monthAgo = new Date(Date.now() - 30 * DAY).toISOString();
  const { data: hlData } = await db()
    .from('highlights')
    .select('*')
    .lt('created_at', ideas.length ? monthAgo : new Date(Date.now() - 3 * DAY).toISOString())
    .order('last_surfaced_at', { ascending: true, nullsFirst: true })
    .limit(5);
  const highlights = (hlData ?? []) as HighlightRow[];

  const useIdea = ideas.length > 0 && (highlights.length === 0 || Math.random() < 0.7);
  if (useIdea) {
    const idea = ideas[Math.floor(Math.random() * Math.min(ideas.length, 3))];
    const { data: src } = idea.source_id ? await db().from('sources').select('title').eq('id', idea.source_id).maybeSingle() : { data: null };
    const text = [
      `🕰️ From your book, ${daysAgo(idea.created_at)} days ago`,
      '',
      idea.title,
      idea.body && idea.body !== idea.title ? truncate(idea.body, 700) : null,
      src?.title ? `\nFrom: ${src.title}` : null,
      '',
      'Still true? What would you add? Reply to this message.',
    ]
      .filter((l) => l !== null)
      .join('\n');
    const id = await sendMessage(env.allowedUserId, text);
    await registerPrompt(env.allowedUserId, id, 'idea', idea.id);
    await db()
      .from('ideas')
      .update({ last_surfaced_at: new Date().toISOString(), surfaced_count: idea.surfaced_count + 1 })
      .eq('id', idea.id);
    return `idea ${idea.short_id}`;
  }
  if (highlights.length) {
    const h = highlights[Math.floor(Math.random() * Math.min(highlights.length, 3))];
    const { data: src } = await db().from('sources').select('title, author').eq('id', h.source_id).maybeSingle();
    const text = [
      `🕰️ A passage you kept ${daysAgo(h.created_at)} days ago`,
      '',
      `"${h.text}"`,
      `${src?.title ?? ''}${src?.author ? `, ${src.author}` : ''}${h.location ? ` (${h.location})` : ''}`,
      h.why ? `\nYou noted: ${h.why}` : null,
      '',
      'Does it still land? Reply to add a thought.',
    ]
      .filter((l) => l !== null)
      .join('\n');
    const id = await sendMessage(env.allowedUserId, text);
    await registerPrompt(env.allowedUserId, id, 'highlight', h.id);
    await db().from('highlights').update({ last_surfaced_at: new Date().toISOString() }).eq('id', h.id);
    return `highlight ${h.short_id}`;
  }
  return 'nothing old enough to resurface yet';
}

// ---------------------------------------------------------------------------
// Weekly review (Sunday)
// ---------------------------------------------------------------------------

export async function weeklyReview(): Promise<string> {
  const since = new Date(Date.now() - 7 * DAY).toISOString();
  const { data: srcData } = await db().from('sources').select('id, short_id, title, format, reaction, topics').gte('created_at', since).in('status', ['processed', 'link_only']);
  const sources = (srcData ?? []) as SourceRow[];
  const { count: ideasWritten } = await db().from('ideas').select('id', { count: 'exact', head: true }).eq('origin', 'mine').gte('created_at', since);
  const { count: highlightCount } = await db().from('highlights').select('id', { count: 'exact', head: true }).gte('created_at', since);
  const { data: pending } = await db()
    .from('connections')
    .select('short_id, relation, reason, from_idea, to_idea')
    .eq('status', 'suggested')
    .order('created_at')
    .limit(3);
  const { data: reading } = await db().from('sources').select('title').eq('format', 'book').eq('reading_status', 'reading');

  const byFormat = Object.entries(sources.reduce<Record<string, number>>((a, s) => ({ ...a, [s.format]: (a[s.format] ?? 0) + 1 }), {}))
    .map(([f, n]) => `${n} ${f}${n === 1 ? '' : 's'}`)
    .join(', ');
  const noReaction = sources.filter((s) => !s.reaction && s.format !== 'book');
  const topics = Object.entries(sources.flatMap((s) => s.topics ?? []).reduce<Record<string, number>>((a, t) => ({ ...a, [t]: (a[t] ?? 0) + 1 }), {}))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([t]) => t);

  const lines: string[] = [
    '📓 YOUR WEEK IN THE BOOK',
    '',
    `Read or watched: ${sources.length ? byFormat : 'nothing captured'}`,
    `Kept ${highlightCount ?? 0} highlights, wrote ${ideasWritten ?? 0} ideas in your own words`,
  ];
  if (reading?.length) lines.push(`Reading: ${reading.map((r: { title: string }) => r.title).join(', ')}`);
  if (topics.length) lines.push(`On your mind: ${topics.join(', ')}`);

  if (noReaction.length) {
    lines.push('', `WAITING FOR YOUR REACTION (${noReaction.length})`);
    for (const s of noReaction.slice(0, 5)) lines.push(`• ${truncate(s.title ?? '', 80)}`);
    lines.push('Open them in Obsidian and fill "What struck me", or delete what no longer matters.');
  }
  if (pending?.length) {
    const ids = [...new Set(pending.flatMap((p: { from_idea: string; to_idea: string }) => [p.from_idea, p.to_idea]))];
    const { data: ideaData } = await db().from('ideas').select('id, title').in('id', ids);
    const title = new Map(((ideaData ?? []) as IdeaRow[]).map((i) => [i.id, i.title]));
    lines.push('', 'CONNECTIONS TO DECIDE');
    for (const p of pending as ConnectionRow[]) {
      lines.push(`• "${truncate(title.get(p.from_idea) ?? '', 50)}" ${p.relation} "${truncate(title.get(p.to_idea) ?? '', 50)}"`);
      lines.push(`   /accept ${p.short_id}   /reject ${p.short_id}`);
    }
  }
  if ((ideasWritten ?? 0) === 0 && sources.length) {
    lines.push('', 'You captured but wrote no ideas this week. Pick one source above and write the idea you want to keep: /idea …');
  }
  const text = lines.join('\n');
  await sendMessage(env.allowedUserId, text);
  return text;
}

// ---------------------------------------------------------------------------
// Monthly patterns report + topic hubs
// ---------------------------------------------------------------------------

function topicCounts(rows: { topics: string[] }[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) for (const t of r.topics ?? []) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

export async function monthlyReport(): Promise<string> {
  const now = Date.now();
  const recentSince = new Date(now - 30 * DAY).toISOString();
  const priorSince = new Date(now - 120 * DAY).toISOString();

  const recentSources = await fetchAll<SourceRow>((f, t) => db().from('sources').select('topics').gte('created_at', recentSince).range(f, t), 'recent');
  const priorSources = await fetchAll<SourceRow>((f, t) => db().from('sources').select('topics').gte('created_at', priorSince).lt('created_at', recentSince).range(f, t), 'prior');
  const allIdeas = await fetchAll<IdeaRow>((f, t) => db().from('ideas').select('*').in('status', ['seedling', 'evergreen']).range(f, t), 'ideas');
  const connections = await fetchAll<ConnectionRow>((f, t) => db().from('connections').select('*').eq('status', 'accepted').range(f, t), 'connections');

  const recent = topicCounts(recentSources);
  const prior = topicCounts(priorSources);
  const trend = [...new Set([...recent.keys(), ...prior.keys()])].map((topic) => {
    const r = recent.get(topic) ?? 0;
    const p = (prior.get(topic) ?? 0) / 3; // prior 90 days, per 30
    return { topic, recent: r, change: r - p };
  });
  const rising = trend.filter((t) => t.change >= 1).sort((a, b) => b.change - a.change).slice(0, 4);
  const fading = trend.filter((t) => t.change <= -1).sort((a, b) => a.change - b.change).slice(0, 4);

  const ideaById = new Map(allIdeas.map((i) => [i.id, i]));
  const degree = new Map<string, number>();
  for (const c of connections) for (const id of [c.from_idea, c.to_idea]) degree.set(id, (degree.get(id) ?? 0) + 1);
  const hubs = [...degree.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, n]) => ({ idea: ideaById.get(id), n })).filter((h) => h.idea);
  const tensions = connections.filter((c) => c.relation === 'contradicts').slice(-5);
  const newIdeas = allIdeas.filter((i) => i.origin === 'mine' && i.created_at >= recentSince);

  let patterns = '';
  if (newIdeas.length >= 3) {
    try {
      patterns = await callText({
        system: `${OWNER_CONTEXT}\n\nYou write a short, honest reflection (max 120 words) on patterns across the ideas someone wrote this month: recurring questions, themes that link different sources, shifts in thinking. Refer only to the ideas given. Plain prose, second person, no flattery.`,
        user: newIdeas.map((i) => `- ${i.title}: ${truncate(i.body, 200)}`).join('\n'),
        maxTokens: 400,
      });
    } catch (e) {
      patterns = '';
      console.error('monthly patterns', errMsg(e));
    }
  }

  const month = dateIST().slice(0, 7);
  const md = [
    frontmatter({ type: 'review', period: month, created: dateIST() }),
    `# ${month} review`,
    '## This month',
    `- ${recentSources.length} sources, ${newIdeas.length} ideas in your own words, ${connections.filter((c) => c.created_at >= recentSince).length} connections made`,
    patterns ? `## Patterns\n\n${patterns}` : '',
    '## Rising topics',
    rising.length ? rising.map((t) => `- ${t.topic} (${t.recent} this month)`).join('\n') : '- None clearly rising',
    '## Fading topics',
    fading.length ? fading.map((t) => `- ${t.topic}`).join('\n') : '- None clearly fading',
    '## Most connected ideas',
    hubs.length ? hubs.map((h) => `- [[${ideaStem(h.idea!)}]] (${h.n} connections)`).join('\n') : '- No accepted connections yet',
    '## Tensions in your thinking',
    tensions.length
      ? tensions
          .map((c) => `- [[${ideaStem(ideaById.get(c.from_idea) ?? ({ title: '?', short_id: '', vault_path: null } as IdeaRow))}]] vs [[${ideaStem(ideaById.get(c.to_idea) ?? ({ title: '?', short_id: '', vault_path: null } as IdeaRow))}]]: ${c.reason}`)
          .join('\n')
      : '- None found yet',
    '## My reflection',
    '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const writes = [{ path: vaultPath(vault.reviews, `${month} review.md`), content: md }];
  writes.push(...(await topicHubWrites(allIdeas)));
  let saved = 'Saved to 05 Reviews.';
  try {
    await commitChanges(`Monthly review ${month}`, writes);
  } catch (e) {
    saved = `Vault save failed: ${truncate(errMsg(e), 100)}`;
  }

  const text = [
    `🔭 ${month} IN YOUR BOOK`,
    '',
    `${recentSources.length} sources, ${newIdeas.length} ideas written`,
    rising.length ? `Rising: ${rising.map((t) => t.topic).join(', ')}` : null,
    fading.length ? `Fading: ${fading.map((t) => t.topic).join(', ')}` : null,
    tensions.length ? `Tensions found: ${tensions.length}` : null,
    patterns ? `\n${patterns}` : null,
    '',
    saved,
  ]
    .filter((l) => l !== null)
    .join('\n');
  await sendMessage(env.allowedUserId, text);
  return text;
}

/** Topic hubs appear once a topic has 5+ ideas. Only the "Ideas" section is regenerated; your overview is kept. */
async function topicHubWrites(ideas: IdeaRow[]): Promise<{ path: string; content: string }[]> {
  const writes: { path: string; content: string }[] = [];
  for (const topic of TOPICS) {
    const members = ideas.filter((i) => i.topics?.includes(topic) && i.origin === 'mine');
    if (members.length < 5) continue;
    const path = vaultPath(vault.topics, `${topic}.md`);
    const list = members
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((i) => `- [[${ideaStem(i)}]]${i.status === 'evergreen' ? ' 🌳' : ''}`)
      .join('\n');
    const existing = await getFileText(path);
    const base =
      existing ??
      [frontmatter({ type: 'topic', topic }), `# ${topic}`, '## Overview', '_Write what you currently understand about this topic._', '## Ideas', '', '## Open questions', '_Nothing yet._', ''].join('\n\n');
    writes.push({ path, content: replaceSection(base, 'Ideas', list) });
  }
  return writes;
}

// ---------------------------------------------------------------------------
// One daily cron runs everything on the right days (IST)
// ---------------------------------------------------------------------------

export async function runDaily(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const step = async (name: string, fn: () => Promise<unknown>) => {
    try {
      const r = await fn();
      out[name] = typeof r === 'string' ? truncate(r, 120) : 'ok';
    } catch (e) {
      out[name] = `failed: ${errMsg(e)}`;
      await sendMessage(env.allowedUserId, `⚠️ Daily job "${name}" failed: ${truncate(errMsg(e), 200)}`).catch(() => undefined);
    }
  };
  const ist = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  await step('sync', syncVault);
  await step('resurface', resurface);
  if (ist.getDay() === 0) await step('weekly', weeklyReview);
  if (ist.getDate() === 1) await step('monthly', monthlyReport);
  const proposals = await getSetting<Record<string, number>>('topic_proposals');
  if (proposals && Object.values(proposals).some((n) => n >= 3)) out.topics = 'proposals waiting (/topics)';
  return out;
}

export { sourceStem };
