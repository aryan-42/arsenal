import { env } from './env';

export async function transcribeVoice(buffer: ArrayBuffer, filename = 'voice.ogg'): Promise<string> {
  if (!env.groqKey) {
    throw new Error('Voice notes need GROQ_API_KEY. Send your note as text instead.');
  }
  const form = new FormData();
  form.append('file', new Blob([buffer]), filename);
  form.append('model', 'whisper-large-v3-turbo');
  form.append('response_format', 'json');
  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.groqKey}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Voice transcription failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { text?: string };
  const text = json.text?.trim();
  if (!text) throw new Error('Voice note was empty or unclear');
  return text;
}
