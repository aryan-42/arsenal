import { db } from './db';
import type { PromptKind } from './types';

/** Remembers a bot message so a reply to it lands in the right note. */
export async function registerPrompt(chatId: number | string, messageId: number, kind: PromptKind, targetId: string): Promise<void> {
  if (!messageId) return;
  await db().from('prompts').upsert({ chat_id: Number(chatId), message_id: messageId, kind, target_id: targetId });
}

export async function findPrompt(chatId: number, messageId: number): Promise<{ kind: PromptKind; target_id: string } | null> {
  const { data } = await db()
    .from('prompts')
    .select('kind, target_id')
    .eq('chat_id', chatId)
    .eq('message_id', messageId)
    .maybeSingle();
  return (data as { kind: PromptKind; target_id: string }) ?? null;
}
