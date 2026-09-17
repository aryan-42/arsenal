/** Session token = HMAC of a fixed message keyed by DASHBOARD_PASSWORD. Works in edge and node runtimes. */
export async function sessionToken(password: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(password), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode('commonplace-dashboard-v1'));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
}

export const SESSION_COOKIE = 'book_session';
