import type { Format, TgEntity } from './types';

const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export function shortId(length = 6): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join('');
}

export const SHORT_ID_PATTERN = /\[([a-hj-km-np-z2-9]{6})\]/g;

export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

const GLOBAL_TRACKING = [/^utm_/i, /^fbclid$/i, /^gclid$/i, /^igsh$/i, /^igshid$/i, /^mc_cid$/i, /^mc_eid$/i, /^ref_src$/i, /^ref_url$/i];

function cleanHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^(www\.|m\.|mobile\.)/, '');
}

export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    u.hash = '';
    const host = cleanHost(u.hostname);
    if (host === 'youtu.be') {
      const id = u.pathname.slice(1).split('/')[0];
      if (id) return `https://youtube.com/watch?v=${id}`;
    }
    if (host === 'youtube.com') {
      const m = u.pathname.match(/^\/(shorts|live|embed)\/([\w-]{11})/);
      if (m) return `https://youtube.com/watch?v=${m[2]}`;
      const v = u.searchParams.get('v');
      if (v) return `https://youtube.com/watch?v=${v}`;
    }
    u.hostname = host === 'twitter.com' ? 'x.com' : host;
    const hostSpecific = u.hostname === 'x.com' ? [/^s$/, /^t$/] : [];
    for (const key of [...u.searchParams.keys()]) {
      if ([...GLOBAL_TRACKING, ...hostSpecific].some((r) => r.test(key))) u.searchParams.delete(key);
    }
    let s = u.toString();
    if (s.endsWith('/') && u.pathname !== '/') s = s.slice(0, -1);
    return s;
  } catch {
    return raw.trim();
  }
}

export function detectFormat(url: string): Format {
  try {
    const u = new URL(url);
    const host = cleanHost(u.hostname);
    if (host === 'youtu.be' || host.endsWith('youtube.com')) return 'video';
    if ((host === 'x.com' || host === 'twitter.com') && /\/status(es)?\/\d+/.test(u.pathname)) return 'tweet';
    if (host.endsWith('instagram.com') && /^\/(reel|reels|p|tv)\//.test(u.pathname)) return 'reel';
    if (u.pathname.toLowerCase().endsWith('.pdf')) return 'report';
    return 'article';
  } catch {
    return 'other';
  }
}

export interface FoundUrl { raw: string; url: string }

export function extractUrls(text: string, entities: TgEntity[] = []): FoundUrl[] {
  const found: FoundUrl[] = [];
  for (const e of entities) {
    if (e.type === 'url') {
      const raw = text.slice(e.offset, e.offset + e.length);
      found.push({ raw, url: /^https?:\/\//i.test(raw) ? raw : `https://${raw}` });
    } else if (e.type === 'text_link' && e.url) {
      found.push({ raw: '', url: e.url });
    }
  }
  if (!found.length) {
    for (const m of text.match(/https?:\/\/[^\s<>"']+/gi) ?? []) {
      const raw = m.replace(/[),.;!?]+$/, '');
      found.push({ raw, url: raw });
    }
  }
  const seen = new Set<string>();
  return found
    .filter((f) => {
      const key = normalizeUrl(f.url);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 5);
}

export function stripUrls(text: string, urls: FoundUrl[]): string {
  let t = text;
  for (const u of urls) if (u.raw) t = t.split(u.raw).join(' ');
  return t.replace(/https?:\/\/\S+/gi, ' ').replace(/\s+/g, ' ').trim();
}

export function cleanText(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function sanitizeFilename(s: string, max = 80): string {
  const cleaned = s
    .replace(/[\\/:*?"<>|#^[\]{}]/g, ' ')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  const cut = cleaned.length > max ? cleaned.slice(0, max).trim() : cleaned;
  return cut || 'Untitled';
}

export function fileStem(path: string): string {
  const name = path.split('/').pop() ?? path;
  return name.replace(/\.md$/i, '');
}

export function truncate(s: string | null | undefined, n: number): string {
  if (!s) return '';
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
}

export function dateIST(d: Date | string = new Date()): string {
  return new Date(d).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function chunkText(text: string, max = 4000): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    const pieces = line.length > max ? line.match(new RegExp(`[\\s\\S]{1,${max}}`, 'g')) ?? [] : [line];
    for (const piece of pieces) {
      if ((current ? current.length + 1 : 0) + piece.length > max) {
        if (current) chunks.push(current);
        current = piece;
      } else {
        current = current ? `${current}\n${piece}` : piece;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks.length ? chunks : [''];
}

export async function fetchWithTimeout(url: string, init: RequestInit = {}, ms = 20_000): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(ms), cache: 'no-store' });
}

/** Markdown-ish text -> readable plain text for Telegram. */
export function toPlain(md: string): string {
  return md
    .replace(/^#{1,6}\s+(.*)$/gm, (_, h: string) => `▸ ${h.toUpperCase()}`)
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/^\s*[-*]\s+/gm, '• ');
}
