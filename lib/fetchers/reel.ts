import { parseHTML } from 'linkedom';
import { fetchWithTimeout, truncate } from '../util';
import type { Fetched } from './types';

export async function fetchReel(url: string): Promise<Fetched> {
  try {
    const res = await fetchWithTimeout(url, {
      headers: { 'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)' },
    });
    if (res.ok) {
      const { document } = parseHTML(await res.text());
      const meta = (p: string) => document.querySelector(`meta[property="${p}"]`)?.getAttribute('content')?.trim() || null;
      const description = meta('og:description');
      const ogTitle = meta('og:title');
      if (description) {
        const quoted = description.match(/:\s*[“"]([\s\S]+)[”"]\s*\.?\s*$/);
        const caption = (quoted?.[1] ?? description).trim();
        if (caption.length > 20) {
          const author = ogTitle?.split(/ on Instagram/i)[0]?.trim() || null;
          return { format: 'reel', title: `Reel: ${truncate(caption, 60)}`, author, text: `Reel caption: ${caption}` };
        }
      }
    }
  } catch {
    // Instagram often blocks this; fall through
  }
  return { format: 'reel', text: null, reason: 'Instagram does not expose reel content' };
}
