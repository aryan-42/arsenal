// Registers the Telegram webhook and the bot's command menu.
// Usage: TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... APP_URL=https://your-app.vercel.app npm run setup:webhook

const { TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, APP_URL } = process.env;
if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_WEBHOOK_SECRET || !APP_URL) {
  console.error('Set TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and APP_URL first.');
  process.exit(1);
}

const api = async (method, body) => {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
};

const url = `${APP_URL.replace(/\/$/, '')}/api/telegram`;
console.log('setWebhook ->', url);
console.log(await api('setWebhook', {
  url,
  secret_token: TELEGRAM_WEBHOOK_SECRET,
  allowed_updates: ['message'],
  drop_pending_updates: true,
}));

console.log(await api('setMyCommands', {
  commands: [
    ['ask', 'Answer from your evidence bank'],
    ['case', 'Case mode: finding, evidence, implication'],
    ['exam', 'Exam mode: concept and examples'],
    ['interview', 'Interview stories and examples'],
    ['content', 'Hooks and facts for posts'],
    ['pack', 'Evidence pack for a problem statement'],
    ['unverified', 'Stats waiting for a check'],
    ['verify', 'Mark card(s) verified'],
    ['delete', 'Delete card(s)'],
    ['focus', 'Set what you are working on'],
    ['skip', 'Keep source as link only'],
    ['retry', 'Re-run last failed source'],
    ['sync', 'Pull Obsidian edits now'],
    ['stats', 'Bank overview'],
    ['digest', 'Run the weekly digest now'],
    ['opportunities', 'Cluster startup opportunities'],
    ['help', 'How to use Arsenal'],
  ].map(([command, description]) => ({ command, description })),
}));

console.log(await api('getWebhookInfo', {}));
