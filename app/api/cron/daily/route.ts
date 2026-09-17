import { runCron } from '@/lib/cron';
import { runDaily } from '@/lib/jobs';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** Daily at 09:00 IST: vault sync, resurfacing; weekly review on Sundays; monthly report on the 1st. */
export async function GET(request: Request) {
  return runCron(request, 'daily', runDaily);
}
