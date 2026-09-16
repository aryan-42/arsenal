import { env } from './env';
import { errMsg } from './util';

export const EMBEDDING_DIM = 1024;

export function embeddingsEnabled(): boolean {
  return Boolean(env.voyageKey);
}

async function voyage(input: string[], inputType: 'document' | 'query'): Promise<number[][]> {
  const res = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.voyageKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ input, model: env.voyageModel, input_type: inputType, output_dimension: EMBEDDING_DIM }),
  });
  if (!res.ok) throw new Error(`Voyage embeddings failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { data: { embedding: number[]; index: number }[] };
  return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

/** Never throws: returns nulls when embeddings are disabled or fail (search falls back to keywords). */
export async function embedDocuments(texts: string[]): Promise<(number[] | null)[]> {
  if (!embeddingsEnabled() || !texts.length) return texts.map(() => null);
  try {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 64) out.push(...(await voyage(texts.slice(i, i + 64), 'document')));
    return out;
  } catch (e) {
    console.error('embedDocuments', errMsg(e));
    return texts.map(() => null);
  }
}

export async function embedQuery(text: string): Promise<number[] | null> {
  if (!embeddingsEnabled()) return null;
  try {
    return (await voyage([text], 'query'))[0] ?? null;
  } catch (e) {
    console.error('embedQuery', errMsg(e));
    return null;
  }
}
