import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, sessionToken } from './lib/auth';

export async function middleware(request: NextRequest) {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) {
    return new NextResponse('Dashboard is locked. Set DASHBOARD_PASSWORD in Vercel and redeploy.', { status: 503 });
  }
  const cookie = request.cookies.get(SESSION_COOKIE)?.value;
  if (cookie && cookie === (await sessionToken(password))) return NextResponse.next();
  if (request.nextUrl.pathname.startsWith('/api/')) return new NextResponse('Unauthorized', { status: 401 });
  const url = request.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  return NextResponse.redirect(url);
}

export const config = {
  // Everything except the login page, the bot webhook, cron jobs and static assets
  matcher: ['/((?!login|api/telegram|api/cron|_next/static|_next/image|favicon.ico).*)'],
};
