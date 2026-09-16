import { parseHTML } from 'linkedom';
import { fetchWithTimeout, truncate } from '../util';
import type { Fetched } from './types';

export async function fetchTweet(url: string): Promise<Fetched> {
  const id = url.match(/status(?:es)?\/(\d+)/)?.[1];

  try {
    const res = await fetchWithTimeout(
      `https://publish.twitter.com/oembed?url=${encodeURIComponent(url)}&omit_script=true&dnt=true`,
    );
    if (res.ok) {
      const json = (await res.json()) as { html?: string; author_name?: string };
      if (json.html) {
        const { document } = parseHTML(`<div>${json.html}</div>`);
        const text = document.querySelector('blockquote p')?.textContent?.trim();
        if (text) {
          return { format: 'tweet', title: `${json.author_name ?? 'Tweet'}: ${truncate(text, 70)}`, author: json.author_name, text };
        }
      }
    }
  } catch {
    // try the fallback
  }

  if (id) {
    try {
      const res = await fetchWithTimeout(`https://api.fxtwitter.com/status/${id}`);
      if (res.ok) {
        const json = (await res.json()) as { tweet?: { text?: string; author?: { name?: string } } };
        const text = json.tweet?.text?.trim();
        if (text) {
          const author = json.tweet?.author?.name ?? null;
          return { format: 'tweet', title: `${author ?? 'Tweet'}: ${truncate(text, 70)}`, author, text };
        }
      }
    } catch {
      // give up below
    }
  }
  return { format: 'tweet', text: null, reason: 'X did not return the tweet text' };
}
