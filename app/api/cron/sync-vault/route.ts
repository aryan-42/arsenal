import { runCron } from '@/lib/cron';
import { syncVault } from '@/lib/vault-sync';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(request: Request) {
  return runCron(request, 'vault sync', syncVault);
}
