import { vault } from './config';
import { db, fetchAll } from './db';
import type { ConnectionRow, IdeaRow, SourceRow } from './types';
import { dateIST } from './util';

const DAY = 24 * 60 * 60 * 1000;

export interface GraphNode {
  id: string;
  kind: 'idea' | 'source';
  label: string;
  topic: string | null;
  status?: string;
  format?: string;
  path: string | null;
  degree: number;
}

export interface GraphLink {
  source: string;
  target: string;
  kind: 'accepted' | 'suggested' | 'from';
  relation?: string;
}

export interface DashboardData {
  generatedAt: string;
  vaultName: string | null;
  counts: { sources: number; books: number; highlights: number; ideas: number; connections: number; days: number };
  graph: { nodes: GraphNode[]; links: GraphLink[] };
  heatmap: { date: string; count: number }[];
  topics: { topic: string; recent: number; prior: number }[];
  reading: { id: string; title: string; author: string | null; highlights: number; lastActivity: string | null; startedAt: string | null }[];
  waiting: {
    reactions: { title: string; path: string | null; createdAt: string }[];
    connections: { id: string; from: string; to: string; relation: string; reason: string }[];
    candidates: number;
  };
  resurfaced: { title: string; body: string; createdAt: string; path: string | null; source: string | null } | null;
  recent: { kind: 'source' | 'idea' | 'highlight' | 'reflection'; text: string; detail: string | null; at: string }[];
}

export async function getDashboardData(): Promise<DashboardData> {
  const yearAgo = new Date(Date.now() - 365 * DAY).toISOString();
  const recentSince = new Date(Date.now() - 30 * DAY).toISOString();
  const priorSince = new Date(Date.now() - 120 * DAY).toISOString();

  const [sources, ideas, connections, highlightDates, reflectionRows] = await Promise.all([
    fetchAll<SourceRow>(
      (f, t) =>
        db()
          .from('sources')
          .select('id, title, author, format, topics, reaction, status, reading_status, started_at, vault_path, created_at')
          .in('status', ['processed', 'link_only'])
          .order('created_at', { ascending: false })
          .range(f, t),
      'dash sources',
    ),
    fetchAll<IdeaRow>(
      (f, t) =>
        db()
          .from('ideas')
          .select('id, title, body, origin, status, topics, source_id, vault_path, created_at, last_surfaced_at')
          .in('status', ['seedling', 'evergreen', 'candidate'])
          .order('created_at', { ascending: false })
          .range(f, t),
      'dash ideas',
    ),
    fetchAll<ConnectionRow>(
      (f, t) => db().from('connections').select('id, short_id, from_idea, to_idea, relation, reason, status, created_at').in('status', ['accepted', 'suggested']).range(f, t),
      'dash connections',
    ),
    fetchAll<{ source_id: string; created_at: string }>(
      (f, t) => db().from('highlights').select('source_id, created_at').gte('created_at', yearAgo).range(f, t),
      'dash highlights',
    ),
    fetchAll<{ text: string; kind: string; source_id: string | null; idea_id: string | null; created_at: string }>(
      (f, t) => db().from('reflections').select('text, kind, source_id, idea_id, created_at').gte('created_at', yearAgo).order('created_at', { ascending: false }).range(f, t),
      'dash reflections',
    ),
  ]);
  const { count: highlightTotal } = await db().from('highlights').select('id', { count: 'exact', head: true });

  const mine = ideas.filter((i) => i.origin === 'mine' && i.status !== 'candidate');
  const sourceById = new Map(sources.map((s) => [s.id, s]));

  // ----- Graph: your ideas as stars, the sources they came from as smaller points -----
  const graphIdeas = mine.slice(0, 400);
  const ideaIds = new Set(graphIdeas.map((i) => i.id));
  const degree = new Map<string, number>();
  const links: GraphLink[] = [];
  for (const c of connections) {
    if (!ideaIds.has(c.from_idea) || !ideaIds.has(c.to_idea)) continue;
    links.push({ source: c.from_idea, target: c.to_idea, kind: c.status === 'accepted' ? 'accepted' : 'suggested', relation: c.relation });
    if (c.status === 'accepted') for (const id of [c.from_idea, c.to_idea]) degree.set(id, (degree.get(id) ?? 0) + 1);
  }
  const sourceNodes = new Map<string, GraphNode>();
  for (const idea of graphIdeas) {
    const src = idea.source_id ? sourceById.get(idea.source_id) : undefined;
    if (!src) continue;
    if (!sourceNodes.has(src.id)) {
      sourceNodes.set(src.id, {
        id: src.id,
        kind: 'source',
        label: src.title ?? 'Untitled',
        topic: src.topics?.[0] ?? null,
        format: src.format,
        path: src.vault_path,
        degree: 0,
      });
    }
    links.push({ source: src.id, target: idea.id, kind: 'from' });
  }
  const nodes: GraphNode[] = [
    ...graphIdeas.map((i) => ({
      id: i.id,
      kind: 'idea' as const,
      label: i.title,
      topic: i.topics?.[0] ?? null,
      status: i.status,
      path: i.vault_path,
      degree: degree.get(i.id) ?? 0,
    })),
    ...sourceNodes.values(),
  ];

  // ----- Heatmap: everything you added, per day (IST) -----
  const perDay = new Map<string, number>();
  const bump = (iso: string) => {
    if (iso < yearAgo) return;
    const d = dateIST(iso);
    perDay.set(d, (perDay.get(d) ?? 0) + 1);
  };
  sources.forEach((s) => bump(s.created_at));
  mine.forEach((i) => bump(i.created_at));
  highlightDates.forEach((h) => bump(h.created_at));
  reflectionRows.forEach((r) => bump(r.created_at));
  const heatmap: { date: string; count: number }[] = [];
  for (let i = 364; i >= 0; i--) {
    const d = dateIST(new Date(Date.now() - i * DAY));
    heatmap.push({ date: d, count: perDay.get(d) ?? 0 });
  }

  // ----- Topics: last 30 days vs the 90 before -----
  const topicMap = new Map<string, { recent: number; prior: number }>();
  const addTopics = (topics: string[] | null, at: string) => {
    for (const t of topics ?? []) {
      const e = topicMap.get(t) ?? { recent: 0, prior: 0 };
      if (at >= recentSince) e.recent++;
      else if (at >= priorSince) e.prior++;
      topicMap.set(t, e);
    }
  };
  sources.forEach((s) => addTopics(s.topics, s.created_at));
  mine.forEach((i) => addTopics(i.topics, i.created_at));
  const topics = [...topicMap.entries()]
    .map(([topic, v]) => ({ topic, ...v }))
    .filter((t) => t.recent + t.prior > 0)
    .sort((a, b) => b.recent - a.recent || b.prior - a.prior)
    .slice(0, 10);

  // ----- Reading now -----
  const books = sources.filter((s) => s.format === 'book' && s.reading_status === 'reading');
  const reading = books.map((b) => {
    const hl = highlightDates.filter((h) => h.source_id === b.id);
    const refl = reflectionRows.filter((r) => r.source_id === b.id);
    const last = [...hl.map((h) => h.created_at), ...refl.map((r) => r.created_at)].sort().pop() ?? null;
    return { id: b.id, title: b.title ?? 'Untitled', author: b.author, highlights: hl.length, lastActivity: last, startedAt: b.started_at };
  });

  // ----- Waiting for you -----
  const ideaById = new Map(ideas.map((i) => [i.id, i]));
  const waiting = {
    reactions: sources
      .filter((s) => s.format !== 'book' && !s.reaction && s.status === 'processed' && s.created_at >= recentSince)
      .slice(0, 6)
      .map((s) => ({ title: s.title ?? 'Untitled', path: s.vault_path, createdAt: s.created_at })),
    connections: connections
      .filter((c) => c.status === 'suggested')
      .slice(0, 4)
      .map((c) => ({
        id: c.short_id,
        from: ideaById.get(c.from_idea)?.title ?? '?',
        to: ideaById.get(c.to_idea)?.title ?? '?',
        relation: c.relation,
        reason: c.reason,
      })),
    candidates: ideas.filter((i) => i.status === 'candidate').length,
  };

  // ----- One old idea to look at again (display only) -----
  const old = mine
    .filter((i) => Date.now() - new Date(i.created_at).getTime() > 7 * DAY)
    .sort((a, b) => (a.last_surfaced_at ?? a.created_at).localeCompare(b.last_surfaced_at ?? b.created_at));
  const pick = old[0];
  const resurfaced = pick
    ? {
        title: pick.title,
        body: pick.body,
        createdAt: pick.created_at,
        path: pick.vault_path,
        source: pick.source_id ? sourceById.get(pick.source_id)?.title ?? null : null,
      }
    : null;

  // ----- Recent activity -----
  const recent = [
    ...sources.slice(0, 12).map((s) => ({ kind: 'source' as const, text: s.title ?? 'Untitled', detail: s.format, at: s.created_at })),
    ...mine.slice(0, 12).map((i) => ({ kind: 'idea' as const, text: i.title, detail: null, at: i.created_at })),
    ...reflectionRows.slice(0, 12).map((r) => ({
      kind: 'reflection' as const,
      text: r.text,
      detail: r.source_id ? sourceById.get(r.source_id)?.title ?? null : r.idea_id ? ideaById.get(r.idea_id)?.title ?? null : null,
      at: r.created_at,
    })),
  ]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 14);

  const first = [...sources.map((s) => s.created_at), ...mine.map((i) => i.created_at)].sort()[0];

  return {
    generatedAt: new Date().toISOString(),
    vaultName: process.env.OBSIDIAN_VAULT_NAME?.trim() || null,
    counts: {
      sources: sources.filter((s) => s.format !== 'book').length,
      books: sources.filter((s) => s.format === 'book').length,
      highlights: highlightTotal ?? 0,
      ideas: mine.length,
      connections: connections.filter((c) => c.status === 'accepted').length,
      days: first ? Math.max(1, Math.ceil((Date.now() - new Date(first).getTime()) / DAY)) : 0,
    },
    graph: { nodes, links },
    heatmap,
    topics,
    reading,
    waiting,
    resurfaced,
    recent,
  };
}

export function obsidianUrl(vaultName: string | null, path: string | null): string | null {
  if (!vaultName || !path) return null;
  const root = vault.root ? `${vault.root}/` : '';
  const rel = path.startsWith(root) ? path.slice(root.length) : path;
  return `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(rel.replace(/\.md$/, ''))}`;
}
