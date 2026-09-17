export type Format = 'video' | 'article' | 'tweet' | 'reel' | 'report' | 'book' | 'other';
export type SourceStatus = 'pending' | 'processing' | 'needs_content' | 'processed' | 'link_only' | 'failed';
export type ReadingStatus = 'reading' | 'finished' | 'abandoned';
export type IdeaStatus = 'candidate' | 'seedling' | 'evergreen' | 'dismissed' | 'deleted';
export type IdeaOrigin = 'mine' | 'from-source';
export type Relation = 'supports' | 'contradicts' | 'example-of' | 'extends' | 'same-pattern';
export type ReflectionKind = 'reaction' | 'session' | 'addendum' | 'summary' | 'verdict';
export type PromptKind = 'source' | 'idea' | 'highlight' | 'book';

export const RELATIONS: Relation[] = ['supports', 'contradicts', 'example-of', 'extends', 'same-pattern'];

export interface SourceRow {
  id: string;
  short_id: string;
  url: string | null;
  normalized_url: string | null;
  format: Format;
  title: string | null;
  author: string | null;
  raw_text: string | null;
  user_note: string | null;
  summary: string | null;
  key_points: string[];
  topics: string[];
  reaction: string | null;
  reading_status: ReadingStatus | null;
  started_at: string | null;
  finished_at: string | null;
  status: SourceStatus;
  error: string | null;
  chat_id: number;
  message_id: number;
  bot_message_id: number | null;
  vault_path: string | null;
  vault_sha: string | null;
  archive_path: string | null;
  created_at: string;
  processed_at: string | null;
}

export interface HighlightRow {
  id: string;
  short_id: string;
  source_id: string;
  text: string;
  location: string | null;
  why: string | null;
  origin: 'machine' | 'mine';
  last_surfaced_at: string | null;
  created_at: string;
}

export interface IdeaRow {
  id: string;
  short_id: string;
  source_id: string | null;
  title: string;
  body: string;
  origin: IdeaOrigin;
  status: IdeaStatus;
  topics: string[];
  vault_path: string | null;
  vault_sha: string | null;
  last_surfaced_at: string | null;
  surfaced_count: number;
  created_at: string;
  updated_at: string;
}

export interface ConnectionRow {
  id: string;
  short_id: string;
  from_idea: string;
  to_idea: string;
  relation: Relation;
  reason: string;
  status: 'suggested' | 'accepted' | 'rejected';
  created_at: string;
}

export interface SearchHit {
  kind: 'idea' | 'highlight' | 'source';
  id: string;
  short_id: string;
  source_id: string | null;
  title: string | null;
  body: string;
  created_at: string;
  score: number;
}

// Telegram (only the parts we use)
export interface TgEntity { type: string; offset: number; length: number; url?: string }
export interface TgPhoto { file_id: string; width: number; height: number; file_size?: number }
export interface TgMessage {
  message_id: number;
  date: number;
  from?: { id: number };
  chat: { id: number };
  text?: string;
  caption?: string;
  entities?: TgEntity[];
  caption_entities?: TgEntity[];
  voice?: { file_id: string; duration: number };
  audio?: { file_id: string; file_name?: string };
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  photo?: TgPhoto[];
  reply_to_message?: { message_id: number };
}
export interface TgUpdate { update_id: number; message?: TgMessage }
