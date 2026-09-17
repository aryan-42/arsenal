'use client';

import { useEffect, useRef, useState } from 'react';

interface Result {
  kind: 'idea' | 'highlight' | 'source';
  short_id: string;
  title: string | null;
  body: string;
  from: string | null;
  url: string | null;
}

const KIND_LABEL = { idea: 'Idea', highlight: 'Highlight', source: 'Source' };

export default function Search() {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Result[] | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (q.trim().length < 3) {
      setResults(null);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setState('loading');
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: controller.signal });
        if (!res.ok) throw new Error(String(res.status));
        setResults((await res.json()).results as Result[]);
        setState('idle');
      } catch (e) {
        if ((e as Error).name !== 'AbortError') setState('error');
      }
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [q]);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as globalThis.Node)) setResults(null);
    };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, []);

  return (
    <div className="search" ref={boxRef}>
      <label htmlFor="book-search" style={{ position: 'absolute', left: -9999 }}>
        Search your book
      </label>
      <input
        id="book-search"
        type="search"
        placeholder="Search ideas, highlights and sources"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && setResults(null)}
        autoComplete="off"
      />
      {(results || state === 'error') && (
        <div className="results" role="listbox">
          {state === 'error' && <div className="r snip">Search failed. Check that the database migration was applied.</div>}
          {results && !results.length && <div className="r snip">Nothing in your book matches that yet.</div>}
          {results?.map((r) => {
            const inner = (
              <>
                <span className={`k ${r.kind}`}>
                  {KIND_LABEL[r.kind]}
                  {r.from ? `, from ${r.from}` : ''}
                </span>
                <span className="title">{r.kind === 'highlight' ? `“${r.body.slice(0, 160)}”` : r.title}</span>
                {r.kind !== 'highlight' && r.body ? <span className="snip">{r.body.slice(0, 140)}</span> : null}
              </>
            );
            return r.url ? (
              <a key={r.short_id} href={r.url}>
                {inner}
              </a>
            ) : (
              <div key={r.short_id} className="r">
                {inner}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
