'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE, sessionToken } from '@/lib/auth';

export async function signIn(_prev: { error: string | null }, formData: FormData): Promise<{ error: string | null }> {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) return { error: 'Set DASHBOARD_PASSWORD in Vercel, then redeploy.' };
  if (String(formData.get('password') ?? '') !== password) return { error: 'That password is not right.' };
  (await cookies()).set(SESSION_COOKIE, await sessionToken(password), {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  });
  redirect('/');
}
