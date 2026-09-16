import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { cleanText, fetchWithTimeout, USER_AGENT } from '../util';
import { pdfToText } from './pdf';
import type { Fetched } from './types';

function filenameFromUrl(url: string): string | null {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
    return name.replace(/\.pdf$/i, '').replace(/[-_]+/g, ' ').trim() || null;
  } catch {
    return null;
  }
}

export function parseArticle(html: string): Fetched {
  const { document } = parseHTML(html);
  const meta = (selector: string) => document.querySelector(selector)?.getAttribute('content')?.trim() || null;
  const ogTitle = meta('meta[property="og:title"]') ?? document.querySelector('title')?.textContent?.trim() ?? null;
  const metaAuthor = meta('meta[name="author"]') ?? meta('meta[property="article:author"]');
  const siteName = meta('meta[property="og:site_name"]');

  let text: string | null = null;
  let title: string | null = null;
  let byline: string | null = null;
  try {
    const article = new Readability(document as unknown as Document).parse();
    text = cleanText(article?.textContent);
    title = article?.title?.trim() || null;
    byline = article?.byline?.trim() || null;
  } catch {
    // fall through to the body-text fallback
  }

  if (!text || text.length < 500) {
    const { document: fresh } = parseHTML(html);
    fresh.querySelectorAll('script, style, noscript, nav, header, footer, aside, form').forEach((el) => el.remove());
    const bodyText = cleanText(fresh.querySelector('article')?.textContent ?? fresh.body?.textContent);
    if (bodyText.length > (text?.length ?? 0)) text = bodyText;
  }

  const finalTitle = title || ogTitle;
  const author = byline || metaAuthor || siteName;
  if (!text || text.length < 500) {
    return {
      format: 'article',
      title: finalTitle,
      author,
      text: null,
      reason: 'Could not read the article text (paywall, login wall, or a JavaScript-only page)',
    };
  }
  return { format: 'article', title: finalTitle, author, text };
}

export async function fetchWeb(url: string): Promise<Fetched> {
  const res = await fetchWithTimeout(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    redirect: 'follow',
  });
  if (!res.ok) return { format: 'article', text: null, reason: `The site returned HTTP ${res.status}` };

  const contentType = res.headers.get('content-type') ?? '';
  const finalUrl = res.url || url;
  if (contentType.includes('application/pdf') || new URL(finalUrl).pathname.toLowerCase().endsWith('.pdf')) {
    const pdf = await pdfToText(await res.arrayBuffer());
    return {
      format: 'report',
      title: pdf.title ?? filenameFromUrl(finalUrl),
      text: pdf.text,
      reason: pdf.text ? undefined : 'The PDF has no text layer (probably scanned)',
    };
  }
  return parseArticle(await res.text());
}
