import Anthropic from '@anthropic-ai/sdk';
import { env } from './env';
import { cleanText } from './util';

const PROMPT = (hint: string) =>
  `Transcribe the text in this photo of a page exactly as printed. Keep paragraph breaks. Do not summarise, correct or add anything.${
    hint ? ` The reader pointed to this part, so transcribe only that part: "${hint}".` : ''
  } Reply with the transcribed text only.`;

/** Reads text from a photo (page of a book, article, slide). */
export async function readImageText(base64: string, mediaType: string, hint = ''): Promise<string> {
  if (env.llmProvider === 'anthropic') {
    const client = new Anthropic({ apiKey: env.anthropicKey });
    const res = await client.messages.create({
      model: env.claudeModel,
      max_tokens: 2000,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType as 'image/jpeg', data: base64 } },
            { type: 'text', text: PROMPT(hint) },
          ],
        },
      ],
    });
    return cleanText(res.content.map((b) => (b.type === 'text' ? b.text : '')).join(''));
  }

  const model = process.env.VISION_MODEL?.trim();
  if (!model) {
    throw new Error('Reading photos needs VISION_MODEL (a vision-capable model id from your provider). Or copy the text with Live Text and paste it.');
  }
  const res = await fetch(`${env.llmBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.llmApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      max_tokens: 2000,
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: PROMPT(hint) },
            { type: 'image_url', image_url: { url: `data:${mediaType};base64,${base64}` } },
          ],
        },
      ],
    }),
  });
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[]; error?: { message?: string } };
  if (!res.ok || json.error) throw new Error(`Photo reading failed: ${json.error?.message ?? res.status}`);
  return cleanText((json.choices?.[0]?.message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/gi, ''));
}
