import { detectFormat, errMsg } from '../util';
import { fetchReel } from './reel';
import { fetchTweet } from './tweet';
import type { Fetched } from './types';
import { fetchWeb } from './web';
import { fetchYouTube } from './youtube';

export type { Fetched } from './types';
export { pdfToText } from './pdf';

export async function fetchContent(url: string): Promise<Fetched> {
  const format = detectFormat(url);
  try {
    switch (format) {
      case 'video':
        return await fetchYouTube(url);
      case 'tweet':
        return await fetchTweet(url);
      case 'reel':
        return await fetchReel(url);
      default:
        return await fetchWeb(url);
    }
  } catch (e) {
    return { format, text: null, reason: `Fetch failed: ${errMsg(e)}` };
  }
}
