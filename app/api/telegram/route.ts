import { after, NextResponse } from 'next/server';
import { handleUpdate } from '@/lib/commands';
import { env } from '@/lib/env';
import type { TgUpdate } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(request: Request) {
  if (request.headers.get('x-telegram-bot-api-secret-token') !== env.webhookSecret) {
    return new NextResponse('Unauthorized', { status: 401 });
  }
  const update = (await request.json()) as TgUpdate;
  // Reply to Telegram immediately; do the slow work after the response.
  after(async () => {
    await handleUpdate(update);
  });
  return NextResponse.json({ ok: true });
}
