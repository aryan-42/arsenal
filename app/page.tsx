import Constellation from '@/components/Constellation';
import { topicColor } from '@/lib/colors';
import Search from '@/components/Search';
import { TOPICS } from '@/lib/config';
import { getDashboardData, obsidianUrl, type DashboardData } from '@/lib/dashboard';
import { errMsg } from '@/lib/util';

export const dynamic = 'force-dynamic';

const nf = new Intl.NumberFormat('en-IN');

function ago(iso: string | null): string {
  if (!iso) return 'no activity yet';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return months < 12 ? `${months} month${months === 1 ? '' : 's'} ago` : `${Math.floor(months / 12)} year${months >= 24 ? 's' : ''} ago`;
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
}

function Ledger({ c }: { c: DashboardData['counts'] }) {
  if (!c.sources && !c.ideas && !c.books) {
    return <p className="ledger">Your book is empty. Send a link, a book, or an idea to your Telegram bot to begin.</p>;
  }
  return (
    <p className="ledger">
      <strong>{nf.format(c.sources)}</strong> things read and watched, <strong>{nf.format(c.books)}</strong>{' '}
      {c.books === 1 ? 'book' : 'books'}, <strong>{nf.format(c.highlights)}</strong> passages kept and{' '}
      <strong>{nf.format(c.ideas)}</strong> ideas in your own words, connected <strong>{nf.format(c.connections)}</strong>{' '}
      {c.connections === 1 ? 'time' : 'times'} over {nf.format(c.days)} {c.days === 1 ? 'day' : 'days'}.
    </p>
  );
}

function Year({ cells }: { cells: DashboardData['heatmap'] }) {
  const size = 11;
  const gap = 3;
  const first = new Date(`${cells[0].date}T00:00:00+05:30`);
  const offset = (first.getDay() + 6) % 7; // weeks start Monday
  const weeks = Math.ceil((cells.length + offset) / 7);
  const shade = (n: number) =>
    n === 0 ? 'rgba(169,176,214,0.08)' : n === 1 ? 'rgba(242,212,146,0.28)' : n <= 3 ? 'rgba(242,212,146,0.5)' : n <= 6 ? 'rgba(242,212,146,0.75)' : '#f2d492';
  const total = cells.reduce((a, c) => a + c.count, 0);
  const activeDays = cells.filter((c) => c.count > 0).length;
  const months: { x: number; label: string }[] = [];
  cells.forEach((c, i) => {
    if (c.date.endsWith('-01')) {
      const col = Math.floor((i + offset) / 7);
      months.push({ x: col * (size + gap), label: new Date(`${c.date}T00:00:00+05:30`).toLocaleDateString('en-IN', { month: 'short' }) });
    }
  });

  return (
    <section className="panel wide" aria-labelledby="year-h">
      <h2 id="year-h">Your year of reading</h2>
      <p className="sub">
        {nf.format(total)} additions on {activeDays} of the last 365 days
      </p>
      <div className="year">
        <svg viewBox={`0 0 ${weeks * (size + gap)} ${7 * (size + gap) + 18}`} role="img" aria-label={`${total} additions over the past year`}>
          {months.map((m) => (
            <text key={m.x} x={m.x} y={10} fill="#a9b0d6" fontSize="11" fontFamily="Sora, sans-serif">
              {m.label}
            </text>
          ))}
          {cells.map((c, i) => {
            const col = Math.floor((i + offset) / 7);
            const row = (i + offset) % 7;
            return (
              <rect key={c.date} x={col * (size + gap)} y={18 + row * (size + gap)} width={size} height={size} rx={3} fill={shade(c.count)}>
                <title>{`${shortDate(`${c.date}T12:00:00+05:30`)}: ${c.count} ${c.count === 1 ? 'addition' : 'additions'}`}</title>
              </rect>
            );
          })}
        </svg>
      </div>
      <div className="year-foot">
        <span>Sources, highlights, ideas and reflections, by day</span>
        <span className="scale" aria-hidden="true">
          Less
          {[0, 1, 2, 5, 8].map((n) => (
            <i key={n} style={{ background: shade(n) }} />
          ))}
          More
        </span>
      </div>
    </section>
  );
}

export default async function Page() {
  let data: DashboardData;
  try {
    data = await getDashboardData();
  } catch (e) {
    return (
      <main className="shell">
        <h1 className="brand">Commonplace</h1>
        <section className="panel wide">
          <h2>The dashboard couldn&apos;t load your book</h2>
          <p className="empty">{errMsg(e)}</p>
          <p className="empty" style={{ marginTop: 10 }}>
            Check that SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set in Vercel and that the latest database migration has been applied.
          </p>
        </section>
      </main>
    );
  }

  const { counts, graph, topics, reading, waiting, resurfaced, recent, vaultName } = data;
  const maxTopic = Math.max(1, ...topics.map((t) => Math.max(t.recent, t.prior / 3)));
  const resurfacedUrl = resurfaced ? obsidianUrl(vaultName, resurfaced.path) : null;

  return (
    <main className="shell">
      <header className="masthead">
        <div>
          <h1 className="brand">Commonplace</h1>
          <Ledger c={counts} />
        </div>
        <Search />
      </header>

      <div className="grid-top">
        <Constellation nodes={graph.nodes} links={graph.links} topicOrder={TOPICS} vaultName={vaultName} />

        <div className="stack">
          <section className="panel memory" aria-labelledby="memory-h">
            <h2 id="memory-h">Worth another look</h2>
            {resurfaced ? (
              <>
                <blockquote>{resurfaced.title}</blockquote>
                {resurfaced.body && resurfaced.body !== resurfaced.title ? <p>{resurfaced.body.slice(0, 280)}</p> : null}
                <div className="meta">
                  Written {ago(resurfaced.createdAt)}
                  {resurfaced.source ? `, from ${resurfaced.source}` : ''}
                  {resurfacedUrl ? (
                    <>
                      . <a href={resurfacedUrl}>Open in Obsidian</a>
                    </>
                  ) : null}
                </div>
              </>
            ) : (
              <p className="empty">Ideas you write come back here after a week, so you can see whether they still hold.</p>
            )}
          </section>

          <section className="panel" aria-labelledby="reading-h">
            <h2 id="reading-h">Reading now</h2>
            {reading.length ? (
              reading.map((b) => (
                <div className="book" key={b.id}>
                  <i className="spine" aria-hidden="true" />
                  <div>
                    <h3>{b.title}</h3>
                    <span>
                      {b.author ? `${b.author}. ` : ''}
                      {b.highlights} {b.highlights === 1 ? 'passage' : 'passages'} kept, last {ago(b.lastActivity ?? b.startedAt)}
                    </span>
                  </div>
                </div>
              ))
            ) : (
              <p className="empty">
                No book in progress. Send <code className="cmd">/reading Title by Author</code> to start one.
              </p>
            )}
          </section>
        </div>
      </div>

      <Year cells={data.heatmap} />

      <div className="grid-bottom">
        <section className="panel" aria-labelledby="topics-h">
          <h2 id="topics-h">What&apos;s on your mind</h2>
          <p className="sub">Last 30 days, against your usual pace</p>
          {topics.length ? (
            topics.map((t) => {
              const delta = t.recent - t.prior / 3;
              const cls = delta >= 1 ? 'up' : delta <= -1 ? 'down' : '';
              const label = delta >= 1 ? 'rising' : delta <= -1 ? 'quieter' : 'steady';
              return (
                <div className="topic" key={t.topic}>
                  <span className="topic-name">{t.topic.replace(/-/g, ' ')}</span>
                  <span className={`topic-delta ${cls}`}>
                    {t.recent}, {label}
                  </span>
                  <span className="bar" aria-hidden="true">
                    <i style={{ width: `${(t.recent / maxTopic) * 100}%`, background: topicColor(t.topic, TOPICS) }} />
                  </span>
                </div>
              );
            })
          ) : (
            <p className="empty">Topics appear once you&apos;ve saved a few sources.</p>
          )}
        </section>

        <section className="panel" aria-labelledby="waiting-h">
          <h2 id="waiting-h">Waiting for you</h2>
          <div className="waiting">
            <div>
              <h3>Sources without your reaction</h3>
              {waiting.reactions.length ? (
                <ul>
                  {waiting.reactions.map((r) => {
                    const url = obsidianUrl(vaultName, r.path);
                    return (
                      <li key={`${r.title}${r.createdAt}`}>
                        {url ? <a href={url}>{r.title}</a> : r.title}
                        <small>Saved {ago(r.createdAt)}</small>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="empty">You&apos;ve reacted to everything from the last month.</p>
              )}
            </div>
            <div>
              <h3>Connections to decide</h3>
              {waiting.connections.length ? (
                <ul>
                  {waiting.connections.map((c) => (
                    <li key={c.id} className="pair">
                      <span>{c.from}</span>
                      <span className={`rel ${c.relation}`}>{c.relation.replace('-', ' ')}</span>
                      <span>{c.to}</span>
                      <small>
                        <code className="cmd">/accept {c.id}</code> or <code className="cmd">/reject {c.id}</code>
                      </small>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="empty">No suggestions waiting.</p>
              )}
            </div>
            <div>
              <h3>Candidate ideas from sources</h3>
              <div className="count">{nf.format(waiting.candidates)}</div>
              <p className="empty" style={{ marginTop: 8 }}>
                Drafted from what you read. Keep the ones that matter by writing them in your own words with <code className="cmd">/idea</code>.
              </p>
            </div>
          </div>
        </section>
      </div>

      <section className="panel wide" aria-labelledby="recent-h">
        <h2 id="recent-h">Recently</h2>
        {recent.length ? (
          <ol className="timeline">
            {recent.map((r, i) => (
              <li key={`${r.at}${i}`}>
                <time dateTime={r.at}>{shortDate(r.at)}</time>
                <span className={`glyph ${r.kind}`} aria-hidden="true">
                  {r.kind === 'idea' ? '✦' : r.kind === 'source' ? '◇' : '·'}
                </span>
                <span className="t">
                  {r.kind === 'reflection' ? `“${r.text.slice(0, 180)}”` : r.text}
                  <small>
                    {r.kind === 'idea' ? 'Idea' : r.kind === 'source' ? `Saved ${r.detail ?? ''}`.trim() : `Reflection${r.detail ? ` on ${r.detail}` : ''}`}
                  </small>
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="empty">Nothing yet. Your first capture will appear here.</p>
        )}
      </section>
    </main>
  );
}
