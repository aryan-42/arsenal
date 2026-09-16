# Arsenal

Your personal evidence bank. Send anything to a Telegram bot. Claude turns it into typed, cited evidence cards in your Obsidian vault. Ask questions later and get answers built only from your own cards.

```
Telegram (link + note)
   → Vercel (this app)
   → fetch content: YouTube transcript · article · PDF · tweet · reel caption
   → Supabase: full raw text archived, cards + search index
   → Claude: 0–6 typed cards (stat, claim, case, framework, story, opportunity)
   → GitHub → Obsidian Git → your vault
```

---

## What you need

| Service | Why | Cost |
|---|---|---|
| Telegram | Capture and ask from phone or laptop | Free |
| GitHub | Stores the vault; the app writes notes into it | Free (private repo) |
| Supabase | Database and search | Free tier is enough to start |
| Vercel | Runs the app and scheduled jobs | Hobby tier |
| Anthropic API **or** a free OpenRouter / NVIDIA key | Extraction and answers | Claude is pay per use; OpenRouter and NVIDIA have free tiers (see "Using a free model") |
| Voyage AI (optional, recommended) | Semantic search ("meaning" not just keywords) | Has a free allowance |
| Groq (optional) | Voice notes → text | Has a free tier |
| Supadata (optional) | Backup for YouTube transcripts when YouTube blocks Vercel | Has a free tier |

Check each provider's pricing page for current limits; they change.

Total setup time: about 60–90 minutes.

---

## Step 1: Put your vault on GitHub (20 min)

**Important:** a git repository must not live inside iCloud Drive, Google Drive or Dropbox. Syncing `.git` folders through them corrupts the repository.

1. **Move the vault to a local folder** (skip if it isn't in iCloud): quit Obsidian, move the vault folder to e.g. `~/Documents/Vault`, reopen Obsidian → *Open folder as vault*.
2. **Add the Arsenal files** from `vault-kit/`:
   - Copy `Dashboard.base` to the vault root.
   - Copy everything in `vault-kit/99 Templates/` into your `99 Templates` folder.
   - Copy `vault.gitignore` to the vault root and rename it to `.gitignore`.
   - Create an empty folder `04 Evidence` with one placeholder note inside it (for example `README.md` saying "Arsenal cards"). Git doesn't store empty folders.
3. **Create a private GitHub repo** named e.g. `vault`. Leave "Add a README" **ticked** so the `main` branch exists.
4. **Push the vault.** In Terminal:
   ```bash
   cd ~/Documents/Vault
   git init -b main
   git remote add origin https://github.com/<you>/vault.git
   git pull origin main --allow-unrelated-histories
   git add -A && git commit -m "Vault"
   git push -u origin main
   ```
   If git asks for a password, use a GitHub personal access token, or install GitHub Desktop and sign in.
5. **Install Obsidian Git**: Obsidian → Settings → Community plugins → Browse → "Git" (by Vinzent) → Install → Enable. In its settings:
   - Auto commit-and-sync interval: `10` minutes
   - Auto pull interval: `10` minutes
   - Pull on startup: on

Your phone doesn't need the vault. You capture and ask through Telegram, and read the vault on your Mac.

## Step 2: Create the Telegram bot (5 min)

1. In Telegram, open **@BotFather** → `/newbot` → pick a name and a username ending in `bot`. Copy the **token**.
2. Open **@userinfobot** → it replies with your numeric **user id**. Copy it.

## Step 3: Set up Supabase (10 min)

1. supabase.com → New project. Pick the **Mumbai (ap-south-1)** region. Save the database password somewhere safe.
2. Open **SQL Editor** → New query → paste all of `supabase/migrations/0001_init.sql` → **Run**. You should see "Success".
3. **Project Settings → API**: copy the **Project URL** and the **secret key** (starts `sb_secret_`; on older projects it's the `service_role` key). Never put this key in client code or share it.

## Step 4: API keys (10 min)

1. **Anthropic**: console.anthropic.com → API keys → create. Also set a **spend limit** under Billing.
2. **GitHub token**: github.com → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate:
   - Repository access: **Only select repositories** → your vault repo
   - Permissions → Repository → **Contents: Read and write**
3. **Optional:** Voyage AI key (dashboard.voyageai.com), Groq key (console.groq.com), Supadata key (supadata.ai).
4. Generate two random secrets in Terminal, one for the webhook and one for cron:
   ```bash
   openssl rand -hex 32
   openssl rand -hex 32
   ```

## Step 5: Deploy to Vercel (15 min)

1. Create a **second** private GitHub repo named `arsenal` and push this code to it:
   ```bash
   cd arsenal
   git init -b main && git add -A && git commit -m "Arsenal"
   git remote add origin https://github.com/<you>/arsenal.git
   git push -u origin main
   ```
2. vercel.com → **Add New → Project** → import `arsenal`. Framework: Next.js (auto-detected).
3. Before deploying, open **Environment Variables** and add everything from `.env.example`:

   | Variable | Value |
   |---|---|
   | `TELEGRAM_BOT_TOKEN` | from BotFather |
   | `TELEGRAM_WEBHOOK_SECRET` | random secret #1 |
   | `TELEGRAM_ALLOWED_USER_ID` | your numeric id |
   | `SUPABASE_URL` | Project URL |
   | `SUPABASE_SERVICE_ROLE_KEY` | secret key |
   | `ANTHROPIC_API_KEY` | your key |
   | `CLAUDE_MODEL` | `claude-sonnet-5` |
   | `GITHUB_TOKEN` | fine-grained token |
   | `GITHUB_REPO` | `<you>/vault` |
   | `GITHUB_BRANCH` | `main` |
   | `CRON_SECRET` | random secret #2 |
   | `VAULT_ROOT` | empty if the vault is the repo root |
   | `VAULT_INBOX_DIR` | `00 Inbox` |
   | `VAULT_SOURCES_DIR` | `03 Sources` |
   | `VAULT_EVIDENCE_DIR` | `04 Evidence` |
   | `VOYAGE_API_KEY`, `GROQ_API_KEY`, `SUPADATA_API_KEY` | optional |

4. **Deploy.** Copy the production URL (e.g. `https://arsenal-yourname.vercel.app`).
5. Check **Settings → Functions**: Fluid Compute should be on, so functions can run up to 300 seconds. If your plan caps functions lower, long YouTube videos may time out; use `/retry`.

## Step 6: Connect Telegram to the app (2 min)

On your Mac, in the `arsenal` folder:

```bash
TELEGRAM_BOT_TOKEN=<token> \
TELEGRAM_WEBHOOK_SECRET=<secret #1> \
APP_URL=https://arsenal-yourname.vercel.app \
npm run setup:webhook
```

The output should include `"ok": true` and show the webhook URL. The command menu appears in your bot.

## Step 7: Test (5 min)

1. Open your bot → `/start`.
2. Send an article link with a note: `https://… useful for the ABG case`
3. Within about a minute you should get `✅ Title` plus a list of cards.
4. In Obsidian, pull (Command palette → *Obsidian Git: Pull*). New files appear in `03 Sources` and `04 Evidence`.
5. `/stats`, then `/ask what did I just save?`

If nothing happens, see Troubleshooting.

---

## Daily use

| You want to… | Do this |
|---|---|
| Save a link | Send it. Add *why* in the same message |
| Add why afterwards | Voice or text message within 10 minutes, or reply to the bot's message |
| Save a reel | Send the link **and a voice note on what it says** (reels are mostly unreadable) |
| Save a report | Send the PDF file (≤20 MB) or its link |
| Capture your own idea | Just type it (when you haven't captured anything in the last 10 min) |
| A paywalled article failed | Paste the article text as your next message, or `/skip` |
| Get case evidence | `/case what drives attrition in gig delivery in India?` |
| Revise for an exam | `/exam 360-degree feedback limitations` |
| Prep an interview | `/interview examples of HR tech improving retention` |
| Make a post | `/content AI replacing entry-level jobs` |
| Start a new case or exam | `/pack <paste the whole problem statement>` → pack saved in `00 Inbox` |
| Tell it what you're working on | `/focus ABG digital HR case; FINM endsem` |

### Sunday (15 min)

The digest arrives Sunday morning, around 9:00 IST.

1. Open `Dashboard.base` → **Unverified stats** view.
2. For each stat: open the source, check the number, then set `verified` to true in the card's properties, or delete the card file if it's wrong. You can also use `/verify id` and `/delete id` from Telegram.
3. Obsidian Git pushes your changes; the nightly sync (or `/sync`) updates the database.

**Rule:** only verified stats go into decks.

### Monthly

On the 1st, you get opportunity clusters in Telegram and a note in `00 Inbox`. Clusters marked 🔥 have 3+ independent sources. Write strong ones up with the `Thesis` template in `01 Notes`.

---

## How edits flow

| Where you act | What syncs |
|---|---|
| Obsidian: set `verified: true/false` | → database (nightly or `/sync`) |
| Obsidian: delete a card file | → card marked deleted (restored if the file comes back) |
| Obsidian: rename or move a card within `04 Evidence` | → path updated (matched by `card_id`) |
| Obsidian: edit a card's text or fields | Stays in the vault only. Search uses the original extraction |
| Telegram: `/verify`, `/delete` | → database and vault file |
| Adding a note to a source | Re-extracts that source and replaces its cards. Do this soon after capture, before you write in the cards |

Card files are never overwritten once written, so your "My note" sections are safe.

---

## Using a free model (OpenRouter or NVIDIA)

Arsenal runs on Claude by default, but it also works with any OpenAI-compatible API. Set these in Vercel instead of `ANTHROPIC_API_KEY`:

**OpenRouter** (openrouter.ai/keys, no card needed)
```
LLM_PROVIDER=openrouter
LLM_API_KEY=sk-or-...
LLM_MODEL=<model id ending in :free>
LLM_FALLBACK_MODELS=<second :free id>,<third :free id>
```

**NVIDIA NIM** (build.nvidia.com → any model → Get API Key)
```
LLM_PROVIDER=nvidia
LLM_API_KEY=nvapi-...
LLM_MODEL=<model id from the model page, e.g. publisher/model-name>
```

Choosing models:
- Copy the **exact** id from the model page. Free lineups change often, so check before relying on one.
- Prefer models that list **tool/function calling** and a context window of 64k+ tokens. Arsenal falls back to plain JSON output for models without tool support, but tool-calling models are more reliable.
- Add 2–3 fallback models. When one is rate-limited or removed, the next is used automatically.
- If a model rejects long inputs or outputs, lower `MAX_SOURCE_CHARS` (e.g. `30000`) or `LLM_MAX_OUTPUT_TOKENS` (e.g. `4096`).

How much Arsenal uses: roughly 1 request per capture (2 if you add a note afterwards), 1 per `/ask`-style question, 2 per `/pack`, and 1 each for the weekly digest and monthly clusters. A heavy day (15 captures, 10 questions, 1 pack) is about 30–40 requests.

Trade-offs to know:
- **Daily caps.** Free tiers cap requests per minute and per day, and the caps differ by provider and account status. Failed or retried requests can count too. Check each provider's current limits page.
- **Extraction quality.** Smaller or free models misread numbers and invent structure more often. The `verified: false` rule matters even more; verify every stat before using it.
- **Privacy.** Some free endpoints may log or train on prompts. Don't send confidential case material or anything under NDA through a free model. Check the provider's data policy and privacy settings.
- **Switching is one env change.** You can start free and move to Claude later by setting `LLM_PROVIDER=anthropic` and redeploying. Existing cards are unaffected.

`/stats` in Telegram shows which provider and models are active.

---

## Troubleshooting

**Bot doesn't reply**
- Run `curl https://api.telegram.org/bot<token>/getWebhookInfo` and look at `last_error_message`.
- Vercel → project → **Logs** shows errors from `/api/telegram`.
- A 401 error means `TELEGRAM_WEBHOOK_SECRET` in Vercel doesn't match the one used in Step 6.
- "This is a private bot" means `TELEGRAM_ALLOWED_USER_ID` is wrong.

**YouTube: "blocked the transcript fetch"**
YouTube often blocks cloud servers. Add `SUPADATA_API_KEY` and redeploy, or paste the transcript (YouTube → "…" → *Show transcript* → copy) as your next message.

**Tweets fail**
X restricts access. Paste the tweet text as your next message, or `/skip` and keep your note.

**"Saved, but the vault write failed"**
Usually a token or repo name issue. Check `GITHUB_REPO` (`owner/name`), that the token has *Contents: Read and write* on that repo, and that the `main` branch exists. Then send `/sync`.

**Sync warning: "No files found in 04 Evidence/"**
`VAULT_EVIDENCE_DIR` or `VAULT_ROOT` doesn't match your repo's folder names exactly (including spaces and capitals). Deletions are skipped as a safety measure until it's fixed.

**Dashboard.base shows an error**
Bases syntax evolves between Obsidian versions. Delete the broken view and recreate it through the Bases UI: filter on folder `04 Evidence`, then add `kind` and `verified` filters.

**Extraction errors mentioning the model**
Check `CLAUDE_MODEL` against the model names in the Anthropic docs.

---

## Limits to know

- **Stats can be misread.** Every stat starts `verified: false` for this reason.
- **Reels and tweets are thin sources.** Your note carries most of the value.
- **Very long content** (over about 80,000 characters, e.g. a 2+ hour transcript) is truncated before extraction. The full text is still archived in Supabase.
- **One user.** The bot ignores everyone except `TELEGRAM_ALLOWED_USER_ID`.
- **Supabase free projects pause after a week without activity.** The nightly sync cron keeps it active.

## Project layout

```
app/api/telegram          webhook: every message and command
app/api/cron/*            nightly vault sync, Sunday digest, monthly clusters
lib/commands.ts           Telegram router
lib/pipeline.ts           fetch → extract → save → vault
lib/extract.ts            extraction prompt and card schema
lib/llm.ts                model providers: Anthropic or any OpenAI-compatible API
lib/ask.ts, lib/pack.ts   answering modes and evidence packs
lib/search.ts             hybrid keyword + semantic search
lib/vault-*.ts            write to and sync from the GitHub vault
lib/fetchers/*            YouTube, web/PDF, tweet, reel
supabase/migrations       database schema
vault-kit/                files to copy into your Obsidian vault
```

To change how cards are extracted (for example to add a new use), edit the prompt in `lib/extract.ts` or set `OWNER_CONTEXT` in Vercel.
