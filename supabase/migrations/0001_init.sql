-- Arsenal: personal evidence system
-- Run once in Supabase: SQL Editor -> New query -> paste -> Run

create extension if not exists vector with schema extensions;

-- ---------------------------------------------------------------------------
-- Sources: everything you capture, with full raw text (never lost)
-- ---------------------------------------------------------------------------
create table if not exists sources (
  id uuid primary key default gen_random_uuid(),
  short_id text not null unique,
  url text,
  normalized_url text,
  format text not null default 'other'
    check (format in ('video', 'article', 'tweet', 'reel', 'report', 'other')),
  title text,
  author text,
  raw_text text,
  user_note text,
  summary text,
  key_points text[] not null default '{}',
  domains text[] not null default '{}',
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'needs_content', 'processed', 'link_only', 'failed')),
  error text,
  chat_id bigint not null,
  message_id bigint not null,
  bot_message_id bigint,
  vault_path text,
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (chat_id, message_id, normalized_url)
);

create index if not exists sources_normalized_url_idx on sources (normalized_url);
create index if not exists sources_chat_created_idx on sources (chat_id, created_at desc);
create index if not exists sources_bot_message_idx on sources (chat_id, bot_message_id);

-- ---------------------------------------------------------------------------
-- Cards: typed, atomic evidence extracted from sources
-- ---------------------------------------------------------------------------
create table if not exists cards (
  id uuid primary key default gen_random_uuid(),
  short_id text not null unique,
  source_id uuid not null references sources (id) on delete cascade,
  kind text not null
    check (kind in ('stat', 'claim', 'case', 'framework', 'story', 'opportunity')),
  title text not null,
  body text not null default '',
  fields jsonb not null default '{}',
  implication text,
  domains text[] not null default '{}',
  use_for text[] not null default '{}',
  verified boolean not null default false,
  incomplete boolean not null default false,
  deleted boolean not null default false,
  search_text text not null default '',
  fts tsvector generated always as (to_tsvector('english', search_text)) stored,
  embedding extensions.vector(1024),
  vault_path text,
  vault_sha text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists cards_fts_idx on cards using gin (fts);
create index if not exists cards_embedding_idx on cards using hnsw (embedding extensions.vector_cosine_ops);
create index if not exists cards_source_idx on cards (source_id);
create index if not exists cards_kind_idx on cards (kind) where not deleted;
create index if not exists cards_unverified_idx on cards (created_at) where not deleted and not verified;

-- ---------------------------------------------------------------------------
-- Settings: small key/value store (e.g. current focus)
-- ---------------------------------------------------------------------------
create table if not exists settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- Lock everything down: only the server (secret/service key) can read or write.
alter table sources enable row level security;
alter table cards enable row level security;
alter table settings enable row level security;

-- ---------------------------------------------------------------------------
-- Hybrid search: keyword (full-text) + semantic (vector), fused with
-- reciprocal rank fusion. Works keyword-only when no embedding is passed.
-- ---------------------------------------------------------------------------
create or replace function search_cards(
  query_text text,
  query_embedding extensions.vector(1024) default null,
  match_count int default 25,
  kinds text[] default null
)
returns table (
  id uuid,
  short_id text,
  source_id uuid,
  kind text,
  title text,
  body text,
  fields jsonb,
  implication text,
  domains text[],
  use_for text[],
  verified boolean,
  incomplete boolean,
  vault_path text,
  created_at timestamptz,
  score double precision
)
language sql
stable
set search_path = public, extensions
as $$
  with kw as (
    select c.id,
           row_number() over (
             order by ts_rank_cd(c.fts, websearch_to_tsquery('english', query_text)) desc
           ) as r
    from cards c
    where not c.deleted
      and coalesce(query_text, '') <> ''
      and c.fts @@ websearch_to_tsquery('english', query_text)
      and (kinds is null or c.kind = any (kinds))
    order by r
    limit match_count * 2
  ),
  sem as (
    select c.id,
           row_number() over (order by c.embedding <=> query_embedding) as r
    from cards c
    where not c.deleted
      and query_embedding is not null
      and c.embedding is not null
      and (kinds is null or c.kind = any (kinds))
    order by c.embedding <=> query_embedding
    limit match_count * 2
  ),
  fused as (
    select coalesce(kw.id, sem.id) as id,
           coalesce(1.0 / (60 + kw.r), 0) + coalesce(1.0 / (60 + sem.r), 0) as score
    from kw
    full outer join sem on kw.id = sem.id
  )
  select c.id, c.short_id, c.source_id, c.kind, c.title, c.body, c.fields,
         c.implication, c.domains, c.use_for, c.verified, c.incomplete,
         c.vault_path, c.created_at, f.score::double precision
  from fused f
  join cards c on c.id = f.id
  order by f.score desc
  limit match_count;
$$;

-- Only the server key may call search
revoke execute on function search_cards(text, extensions.vector, int, text[]) from public, anon, authenticated;
