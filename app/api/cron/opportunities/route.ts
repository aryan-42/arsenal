import { runCron } from '@/lib/cron';
import { runOpportunityClustering } from '@/lib/jobs';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(request: Request) {
  return runCron(request, 'opportunity clustering', runOpportunityClustering);
}
