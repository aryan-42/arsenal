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
    ['ask', 'Ask your book a question'],
    ['idea', 'Write an idea in your own words'],
    ['reading', 'Start or switch the book you are reading'],
    ['books', 'Your books'],
    ['finished', 'Finish the current book'],
    ['summary', 'Summary of a book in your words'],
    ['disagree', 'What a book gets wrong'],
    ['accept', 'Accept a suggested connection'],
    ['reject', 'Reject a suggested connection'],
    ['dismiss', 'Drop a candidate idea'],
    ['stats', 'Your book at a glance'],
    ['review', 'Weekly review now'],
    ['resurface', 'Bring back an old idea'],
    ['topics', 'Topics and proposals'],
    ['sync', 'Sync with your vault now'],
    ['redo', 'Re-read last capture(s)'],
    ['retry', 'Retry last failed capture'],
    ['skip', 'Keep a source as link only'],
    ['help', 'How to use your book'],
  ].map(([command, description]) => ({ command, description })),
}));

console.log(await api('getWebhookInfo', {}));
