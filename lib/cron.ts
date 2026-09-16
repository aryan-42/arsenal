import { NextResponse } from 'next/server';
import { env } from './env';
import { sendMessage } from './telegram';
import { errMsg, truncate } from './util';

export async function runCron(request: Request, name: string, job: () => Promise<unknown>) {
  if (request.headers.get('authorization') !== `Bearer ${env.cronSecret}`) {
    return new NextResponse('Unauthorized', { status: 401 });
  }
  try {
    return NextResponse.json({ ok: true, result: await job() });
  } catch (e) {
    try {
      await sendMessage(env.allowedUserId, `⚠️ Scheduled job "${name}" failed: ${truncate(errMsg(e), 300)}`);
    } catch {
      // ignore
    }
    return NextResponse.json({ ok: false, error: errMsg(e) }, { status: 500 });
  }
}
