-- Arsenal v2: commonplace book
-- Replaces evidence cards with highlights, ideas, connections and reflections.

drop function if exists search_cards(text, extensions.vector, int, text[]);
drop table if exists cards;

-- ---------------------------------------------------------------------------
-- Sources: everything read, watched or listened to (articles, videos, books…)
-- ---------------------------------------------------------------------------
alter table sources drop constraint if exists sources_format_check;
alter table sources add constraint sources_format_check
  check (format in ('video', 'article', 'tweet', 'reel', 'report', 'book', 'other'));

alter table sources drop column if exists domains;
alter table sources add column if not exists topics text[] not null default '{}';
alter table sources add column if not exists reaction text;
alter table sources add column if not exists reading_status text
  check (reading_status in ('reading', 'finished', 'abandoned'));
alter table sources add column if not exists started_at timestamptz;
alter table sources add column if not exists finished_at timestamptz;
alter table sources add column if not exists archive_path text;
alter table sources add column if not exists vault_sha text;
alter table sources add column if not exists search_text text not null default '';
alter table sources add column if not exists fts tsvector
  generated always as (to_tsvector('english', search_text)) stored;
alter table sources add column if not exists embedding extensions.vector(1024);

create index if not exists sources_fts_idx on sources using gin (fts);
create index if not exists sources_reading_idx on sources (reading_status) where reading_status is not null;

-- ---------------------------------------------------------------------------
-- Highlights: passages kept from a source (machine-suggested or your own)
-- ---------------------------------------------------------------------------
create table if not exists highlights (
  id uuid primary key default gen_random_uuid(),
  short_id text not null unique,
  source_id uuid not null references sources (id) on delete cascade,
  text text not null,
  location text,
  why text,
  origin text not null default 'machine' check (origin in ('machine', 'mine')),
  search_text text not null default '',
  fts tsvector generated always as (to_tsvector('english', search_text)) stored,
  embedding extensions.vector(1024),
  last_surfaced_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists highlights_source_idx on highlights (source_id);
create index if not exists highlights_fts_idx on highlights using gin (fts);
create index if not exists highlights_embedding_idx on highlights using hnsw (embedding extensions.vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- Ideas: candidates drafted from sources, and ideas you wrote yourself
-- ---------------------------------------------------------------------------
create table if not exists ideas (
  id uuid primary key default gen_random_uuid(),
  short_id text not null unique,
  source_id uuid references sources (id) on delete set null,
  title text not null,
  body text not null default '',
  origin text not null check (origin in ('mine', 'from-source')),
  status text not null default 'seedling'
    check (status in ('candidate', 'seedling', 'evergreen', 'dismissed', 'deleted')),
  topics text[] not null default '{}',
  vault_path text,
  vault_sha text,
  search_text text not null default '',
  fts tsvector generated always as (to_tsvector('english', search_text)) stored,
  embedding extensions.vector(1024),
  last_surfaced_at timestamptz,
  surfaced_count int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ideas_source_idx on ideas (source_id);
create index if not exists ideas_status_idx on ideas (status);
create index if not exists ideas_fts_idx on ideas using gin (fts);
create index if not exists ideas_embedding_idx on ideas using hnsw (embedding extensions.vector_cosine_ops);
create unique index if not exists ideas_vault_path_idx on ideas (vault_path) where vault_path is not null;

-- ---------------------------------------------------------------------------
-- Connections between ideas, with the kind of relationship
-- ---------------------------------------------------------------------------
create table if not exists connections (
  id uuid primary key default gen_random_uuid(),
  short_id text not null unique,
  from_idea uuid not null references ideas (id) on delete cascade,
  to_idea uuid not null references ideas (id) on delete cascade,
  relation text not null
    check (relation in ('supports', 'contradicts', 'example-of', 'extends', 'same-pattern')),
  reason text not null default '',
  status text not null default 'suggested' check (status in ('suggested', 'accepted', 'rejected')),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  unique (from_idea, to_idea),
  check (from_idea <> to_idea)
);
create index if not exists connections_status_idx on connections (status);

-- ---------------------------------------------------------------------------
-- Reflections: your reactions, reading sessions, later addenda, book summaries
-- ---------------------------------------------------------------------------
create table if not exists reflections (
  id uuid primary key default gen_random_uuid(),
  source_id uuid references sources (id) on delete cascade,
  idea_id uuid references ideas (id) on delete cascade,
  kind text not null check (kind in ('reaction', 'session', 'addendum', 'summary', 'verdict')),
  text text not null,
  created_at timestamptz not null default now()
);
create index if not exists reflections_created_idx on reflections (created_at desc);

-- ---------------------------------------------------------------------------
-- Prompts: bot messages you can reply to (routes replies to the right note)
-- ---------------------------------------------------------------------------
create table if not exists prompts (
  chat_id bigint not null,
  message_id bigint not null,
  kind text not null check (kind in ('source', 'idea', 'highlight', 'book')),
  target_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (chat_id, message_id)
);

alter table highlights enable row level security;
alter table ideas enable row level security;
alter table connections enable row level security;
alter table reflections enable row level security;
alter table prompts enable row level security;

-- ---------------------------------------------------------------------------
-- Search the whole book: ideas, highlights and sources, keyword + semantic
-- ---------------------------------------------------------------------------
create or replace function search_book(
  query_text text,
  query_embedding extensions.vector(1024) default null,
  match_count int default 20,
  kinds text[] default null
)
returns table (
  kind text,
  id uuid,
  short_id text,
  source_id uuid,
  title text,
  body text,
  created_at timestamptz,
  score double precision
)
language sql
stable
set search_path = public, extensions
as $$
  with q as (select websearch_to_tsquery('english', coalesce(query_text, '')) as tsq),
  idea_kw as (
    select i.id, row_number() over (order by ts_rank_cd(i.fts, q.tsq) desc) as r
    from ideas i, q
    where coalesce(query_text, '') <> '' and i.fts @@ q.tsq
      and i.status not in ('dismissed', 'deleted')
      and (kinds is null or 'idea' = any (kinds))
    limit match_count * 2
  ),
  idea_sem as (
    select i.id, row_number() over (order by i.embedding <=> query_embedding) as r
    from ideas i
    where query_embedding is not null and i.embedding is not null
      and i.status not in ('dismissed', 'deleted')
      and (kinds is null or 'idea' = any (kinds))
    order by i.embedding <=> query_embedding
    limit match_count * 2
  ),
  hl_kw as (
    select h.id, row_number() over (order by ts_rank_cd(h.fts, q.tsq) desc) as r
    from highlights h, q
    where coalesce(query_text, '') <> '' and h.fts @@ q.tsq
      and (kinds is null or 'highlight' = any (kinds))
    limit match_count * 2
  ),
  hl_sem as (
    select h.id, row_number() over (order by h.embedding <=> query_embedding) as r
    from highlights h
    where query_embedding is not null and h.embedding is not null
      and (kinds is null or 'highlight' = any (kinds))
    order by h.embedding <=> query_embedding
    limit match_count * 2
  ),
  src_kw as (
    select s.id, row_number() over (order by ts_rank_cd(s.fts, q.tsq) desc) as r
    from sources s, q
    where coalesce(query_text, '') <> '' and s.fts @@ q.tsq
      and (kinds is null or 'source' = any (kinds))
    limit match_count * 2
  ),
  src_sem as (
    select s.id, row_number() over (order by s.embedding <=> query_embedding) as r
    from sources s
    where query_embedding is not null and s.embedding is not null
      and (kinds is null or 'source' = any (kinds))
    order by s.embedding <=> query_embedding
    limit match_count * 2
  ),
  fused as (
    select 'idea' as kind, coalesce(a.id, b.id) as id,
           1.15 * (coalesce(1.0 / (60 + a.r), 0) + coalesce(1.0 / (60 + b.r), 0)) as score
    from idea_kw a full outer join idea_sem b on a.id = b.id
    union all
    select 'highlight', coalesce(a.id, b.id),
           coalesce(1.0 / (60 + a.r), 0) + coalesce(1.0 / (60 + b.r), 0)
    from hl_kw a full outer join hl_sem b on a.id = b.id
    union all
    select 'source', coalesce(a.id, b.id),
           0.9 * (coalesce(1.0 / (60 + a.r), 0) + coalesce(1.0 / (60 + b.r), 0))
    from src_kw a full outer join src_sem b on a.id = b.id
  )
  select f.kind, f.id,
         coalesce(i.short_id, h.short_id, s.short_id),
         coalesce(i.source_id, h.source_id, s.id),
         coalesce(i.title, s.title, left(h.text, 80)),
         coalesce(i.body, h.text, s.summary, ''),
         coalesce(i.created_at, h.created_at, s.created_at),
         f.score::double precision
  from fused f
  left join ideas i on f.kind = 'idea' and i.id = f.id
  left join highlights h on f.kind = 'highlight' and h.id = f.id
  left join sources s on f.kind = 'source' and s.id = f.id
  order by f.score desc
  limit match_count;
$$;

revoke execute on function search_book(text, extensions.vector, int, text[]) from public, anon, authenticated;
