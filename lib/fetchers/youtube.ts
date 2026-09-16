import { env } from '../env';
import { cleanText, fetchWithTimeout, USER_AGENT } from '../util';
import type { Fetched } from './types';

export function youtubeVideoId(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^(www\.|m\.)/, '');
    if (host === 'youtu.be') return u.pathname.slice(1).split('/')[0] || null;
    if (host.endsWith('youtube.com')) {
      const v = u.searchParams.get('v');
      if (v) return v;
      const m = u.pathname.match(/^\/(shorts|live|embed)\/([\w-]{11})/);
      if (m) return m[2];
    }
  } catch {
    // invalid url
  }
  return null;
}

/** Extracts a JSON object that follows `marker` in an HTML page, respecting strings. */
export function extractJsonAfter(html: string, marker: string): unknown {
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) return null;
  const start = html.indexOf('{', markerIndex);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

interface CaptionTrack {
  baseUrl?: string;
  languageCode?: string;
  kind?: string;
}

async function oembed(url: string): Promise<{ title: string | null; author: string | null }> {
  try {
    const res = await fetchWithTimeout(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`);
    if (!res.ok) return { title: null, author: null };
    const json = (await res.json()) as { title?: string; author_name?: string };
    return { title: json.title ?? null, author: json.author_name ?? null };
  } catch {
    return { title: null, author: null };
  }
}

async function watchPageTranscript(id: string): Promise<string | null> {
  const res = await fetchWithTimeout(`https://www.youtube.com/watch?v=${id}&hl=en`, {
    headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en-US,en;q=0.9', Cookie: 'CONSENT=YES+1' },
  });
  if (!res.ok) return null;
  const player = extractJsonAfter(await res.text(), 'ytInitialPlayerResponse') as {
    captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[] } };
  } | null;
  const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  const pick =
    tracks.find((t) => t.languageCode?.startsWith('en') && t.kind !== 'asr') ??
    tracks.find((t) => t.languageCode?.startsWith('en')) ??
    tracks.find((t) => t.languageCode?.startsWith('hi')) ??
    tracks[0];
  if (!pick?.baseUrl) return null;

  const captionRes = await fetchWithTimeout(`${pick.baseUrl}&fmt=json3`, { headers: { 'User-Agent': USER_AGENT } });
  const body = captionRes.ok ? await captionRes.text() : '';
  if (!body) return null;
  const json = JSON.parse(body) as { events?: { segs?: { utf8?: string }[] }[] };
  const text = (json.events ?? [])
    .flatMap((e) => (e.segs ?? []).map((s) => s.utf8 ?? ''))
    .join('')
    .replace(/\s*\n\s*/g, ' ');
  return cleanText(text) || null;
}

async function supadataTranscript(url: string): Promise<string | null> {
  if (!env.supadataKey) return null;
  const res = await fetchWithTimeout(
    `https://api.supadata.ai/v1/transcript?url=${encodeURIComponent(url)}&text=true`,
    { headers: { 'x-api-key': env.supadataKey } },
    60_000,
  );
  if (!res.ok) return null;
  const json = (await res.json()) as { content?: unknown };
  return typeof json.content === 'string' ? cleanText(json.content) : null;
}

export async function fetchYouTube(url: string): Promise<Fetched> {
  const id = youtubeVideoId(url);
  if (!id) return { format: 'video', text: null, reason: 'Could not read the YouTube video id' };
  const canonical = `https://www.youtube.com/watch?v=${id}`;
  const { title, author } = await oembed(canonical);

  let text: string | null = null;
  try {
    text = await watchPageTranscript(id);
  } catch {
    text = null;
  }
  if (!text || text.length < 200) {
    try {
      text = await supadataTranscript(canonical);
    } catch {
      text = null;
    }
  }
  if (!text || text.length < 200) {
    return {
      format: 'video',
      title,
      author,
      text: null,
      reason: env.supadataKey
        ? 'No transcript available for this video'
        : 'YouTube blocked the transcript fetch (adding SUPADATA_API_KEY usually fixes this)',
    };
  }
  return { format: 'video', title, author, text };
}
