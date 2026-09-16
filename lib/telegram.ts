import { env } from './env';
import { chunkText } from './util';

async function call<T>(method: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`https://api.telegram.org/bot${env.telegramToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  const json = (await res.json()) as { ok: boolean; result: T; description?: string };
  if (!json.ok) throw new Error(`Telegram ${method} failed: ${json.description ?? res.status}`);
  return json.result;
}

/** Sends plain text (split into chunks). Returns the id of the first message. */
export async function sendMessage(chatId: number | string, text: string, replyTo?: number): Promise<number> {
  let firstId = 0;
  const chunks = chunkText(text.trim() || '(empty)', 4000);
  for (let i = 0; i < chunks.length; i++) {
    const result = await call<{ message_id: number }>('sendMessage', {
      chat_id: chatId,
      text: chunks[i],
      link_preview_options: { is_disabled: true },
      ...(i === 0 && replyTo
        ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } }
        : {}),
    });
    if (i === 0) firstId = result.message_id;
  }
  return firstId;
}

export async function typing(chatId: number | string): Promise<void> {
  try {
    await call('sendChatAction', { chat_id: chatId, action: 'typing' });
  } catch {
    // non-critical
  }
}

export async function downloadFile(fileId: string): Promise<{ buffer: ArrayBuffer; path: string }> {
  const file = await call<{ file_path: string }>('getFile', { file_id: fileId });
  const res = await fetch(`https://api.telegram.org/file/bot${env.telegramToken}/${file.file_path}`);
  if (!res.ok) throw new Error(`Could not download file from Telegram (HTTP ${res.status})`);
  return { buffer: await res.arrayBuffer(), path: file.file_path };
}
