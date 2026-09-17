'use client';

import { useActionState } from 'react';
import { signIn } from './actions';

export default function Login() {
  const [state, action, pending] = useActionState(signIn, { error: null });
  return (
    <main className="gate">
      <form action={action}>
        <h1>Commonplace</h1>
        <p>Enter your password to open your book.</p>
        <input name="password" type="password" autoComplete="current-password" aria-label="Password" required autoFocus />
        <button type="submit" disabled={pending}>
          {pending ? 'Opening…' : 'Open my book'}
        </button>
        {state.error && <p className="err" role="alert">{state.error}</p>}
      </form>
    </main>
  );
}
