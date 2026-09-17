# Commonplace

A lifelong commonplace book. Everything you read and watch, the passages that struck you, the ideas you write in your own words, and the connections between them, kept as plain markdown you own for decades.

```
Telegram (links, books, photos, voice, ideas)
   → Vercel: fetch, draft highlights and candidate ideas, suggest connections
   → Supabase: search index (rebuildable)
   → GitHub → Obsidian: the book itself (plain markdown)
   → Dashboard at your Vercel URL
```

**The vault is the book.** Supabase, Vercel and the AI model are replaceable. If they all disappear, your notes, highlights, ideas, connections and archived source text remain in your vault.

**The machine drafts; you think.** It fetches, summarises, picks candidate highlights and ideas, and suggests connections. Ideas in `01 Ideas` are only ever written by you.

---

## Vault layout

| Folder | What's there | Who writes it |
|---|---|---|
| `00 Inbox` | Loose notes | You |
| `01 Ideas` | One idea per note, in your words | You (via `/idea`, plain text to the bot, or directly in Obsidian) |
| `02 Journal` | Unchanged | You |
| `03 Sources` | One note per article, video, reel, report or **book** | Machine drafts; you add "What struck me", sessions, summaries |
| `04 Topics` | Hub notes for topics with 5+ ideas | Machine lists ideas; you write the overview |
| `05 Reviews` | Monthly reviews | Machine, with space for your reflection |
| `90 Archive` | Full raw text of every source (`.txt`, hidden in Obsidian) | Machine |

Create `01 Ideas`, `04 Topics` and `05 Reviews` in your vault (each with a placeholder note so git keeps them), and copy `vault-kit/99 Templates/*` and `vault-kit/Dashboard.base` into your vault.

---

## Using it

### Things you read or watch
1. Send the link to the bot, with why you're saving it in the same message.
2. You get a summary, the highlights kept, and 0–3 candidate ideas.
3. **Reply to that message with what struck you.** It goes into the note's "What struck me".

### Books
| You send | What happens |
|---|---|
| `/reading Thinking, Fast and Slow by Daniel Kahneman` | Creates the book note and makes it your current book |
| `p.84 the passage // why it struck you` | Adds a highlight with page and why |
| A photo of the page, caption `p.84 bottom paragraph // why` | Reads the text and adds it as a highlight |
| Any other text or voice note | Added to the book's Sessions |
| `/finished` | Marks it finished and prompts you to close it properly |
| `/summary …` · `/disagree …` | Writes those sections of the book note |
| `/books` | All your books |

While a book is in progress, free text and voice notes go to that book. Links still work as normal. Send `/finished`, or switch with `/reading <other title>`.

### Your ideas
- `/idea <idea in your own words>`, or just send text or a voice note with no link and no book in progress.
- A first line on its own becomes the title.
- The bot suggests up to 4 connections to existing ideas, each labelled *supports*, *contradicts*, *example of*, *extends* or *same pattern*. `/accept <id>` writes real links into both notes; `/reject <id>` drops it.
- Ideas you write directly in Obsidian (in `01 Ideas`) join the book at the next sync and get suggestions too.

### Revisiting
| When | What |
|---|---|
| Every day, 9:00 IST | One older idea or highlight comes back. Reply to add a later thought |
| Sundays | Weekly review: what you read, what's waiting for your reaction, connections to decide |
| 1st of the month | Monthly review in `05 Reviews`: rising and fading topics, most connected ideas, tensions, patterns |
| Any time | `/ask <question>` answers only from your book, with references |

### Dashboard
Open your Vercel URL and enter `DASHBOARD_PASSWORD`. You'll see the constellation of your ideas and connections, one idea worth another look, the books in progress, your year of reading, rising topics, what's waiting for you, and a search across everything. Set `OBSIDIAN_VAULT_NAME` so clicking a star or result opens the note in Obsidian.

---

## Environment variables

Everything from `.env.example`. New for the commonplace book:

| Variable | Value |
|---|---|
| `DASHBOARD_PASSWORD` | A long password. Without it the dashboard stays locked |
| `OBSIDIAN_VAULT_NAME` | Your vault name exactly as in Obsidian's vault switcher |
| `VAULT_IDEAS_DIR` | `01 Ideas` |
| `VAULT_TOPICS_DIR` | `04 Topics` |
| `VAULT_REVIEWS_DIR` | `05 Reviews` |
| `VAULT_ARCHIVE_DIR` | `90 Archive` |
| `TOPICS` | Optional. Comma-separated starting topics |
| `VISION_MODEL` | Only for page photos when using OpenRouter or NVIDIA: a vision-capable model id |
| `VOYAGE_API_KEY` | Strongly recommended. Connections and search work by meaning, not just shared words |

`VAULT_EVIDENCE_DIR` is no longer used.

---

## Commands

```
/ask /idea /accept /reject /dismiss
/reading /books /finished /summary /disagree
/stats /review /monthly /resurface /topics /topic add
/sync /redo /retry /skip /help
```

Run `npm run setup:webhook` (with `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `APP_URL`) after deploying to refresh the bot's command menu.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Dashboard says "locked" | Set `DASHBOARD_PASSWORD` in Vercel and redeploy |
| Dashboard error about the database | Apply `supabase/migrations/0002_commonplace.sql` |
| No connection suggestions | You need a few ideas first. Add `VOYAGE_API_KEY` for much better matching |
| Page photos fail | Set `VISION_MODEL` (OpenRouter/NVIDIA), or copy text with Live Text and send it as `p.84 …` |
| Sync warning about `01 Ideas` | Folder name in the vault must match `VAULT_IDEAS_DIR` exactly |
| A text went to the book instead of becoming an idea | A book is in progress. Use `/idea …` explicitly, or `/finished` |

## Project layout

```
app/page.tsx              dashboard
components/               constellation graph, search
app/api/telegram          bot webhook
app/api/cron/daily        sync, resurfacing, weekly and monthly reviews
lib/commands.ts           Telegram router
lib/pipeline.ts           fetch → draft → save → vault
lib/extract.ts            summary, highlights, candidate ideas, topics
lib/ideas.ts, connections.ts   your ideas and the connection engine
lib/books.ts, reflections.ts   reading mode, reactions, sessions, later thoughts
lib/jobs.ts               resurfacing, weekly and monthly reviews, topic hubs
lib/vault.ts, vault-sync.ts    writing to and reading from your vault
lib/llm.ts                Claude or any OpenAI-compatible model
supabase/migrations       database schema
vault-kit/                templates and dashboard to copy into your vault
```
