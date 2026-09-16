import { runCron } from '@/lib/cron';
import { runDigest } from '@/lib/jobs';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(request: Request) {
  return runCron(request, 'weekly digest', runDigest);
}
