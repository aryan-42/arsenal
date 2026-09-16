export type Format = 'video' | 'article' | 'tweet' | 'reel' | 'report' | 'other';
export type CardKind = 'stat' | 'claim' | 'case' | 'framework' | 'story' | 'opportunity';
export type UseFor = 'case' | 'exam' | 'interview' | 'content' | 'founder';
export type SourceStatus = 'pending' | 'processing' | 'needs_content' | 'processed' | 'link_only' | 'failed';

export const CARD_KINDS: CardKind[] = ['stat', 'claim', 'case', 'framework', 'story', 'opportunity'];
export const USE_FOR: UseFor[] = ['case', 'exam', 'interview', 'content', 'founder'];

export interface CardFields {
  metric?: string;
  value?: string;
  unit?: string;
  year?: string;
  geography?: string;
  definition?: string;
  origin?: string;
  statement?: string;
  epistemic?: string;
  attributed_to?: string;
  company?: string;
  action?: string;
  result?: string;
  context?: string;
  concept?: string;
  when_to_use?: string;
  limits?: string;
  narrative?: string;
  lesson?: string;
  problem?: string;
  who_has_it?: string;
  current_workaround?: string;
  why_now?: string;
  product_angle?: string;
}

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
  domains: string[];
  status: SourceStatus;
  error: string | null;
  chat_id: number;
  message_id: number;
  bot_message_id: number | null;
  vault_path: string | null;
  created_at: string;
  processed_at: string | null;
}

export interface CardRow {
  id: string;
  short_id: string;
  source_id: string;
  kind: CardKind;
  title: string;
  body: string;
  fields: CardFields;
  implication: string | null;
  domains: string[];
  use_for: UseFor[];
  verified: boolean;
  incomplete: boolean;
  deleted: boolean;
  vault_path: string | null;
  vault_sha: string | null;
  created_at: string;
}

export interface SearchResult {
  id: string;
  short_id: string;
  source_id: string;
  kind: CardKind;
  title: string;
  body: string;
  fields: CardFields;
  implication: string | null;
  domains: string[];
  use_for: UseFor[];
  verified: boolean;
  incomplete: boolean;
  vault_path: string | null;
  created_at: string;
  score: number;
}

// Telegram (only the parts we use)
export interface TgEntity { type: string; offset: number; length: number; url?: string }
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
  reply_to_message?: { message_id: number };
}
export interface TgUpdate { update_id: number; message?: TgMessage }
