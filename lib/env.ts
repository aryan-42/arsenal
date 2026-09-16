function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

// Getters so a missing variable only fails the code path that needs it.
export const env = {
  get telegramToken() { return required('TELEGRAM_BOT_TOKEN'); },
  get webhookSecret() { return required('TELEGRAM_WEBHOOK_SECRET'); },
  get allowedUserId() { return required('TELEGRAM_ALLOWED_USER_ID'); },
  get supabaseUrl() { return required('SUPABASE_URL'); },
  get supabaseKey() { return required('SUPABASE_SERVICE_ROLE_KEY'); },
  get anthropicKey() { return required('ANTHROPIC_API_KEY'); },
  get claudeModel() { return optional('CLAUDE_MODEL') ?? 'claude-sonnet-5'; },
  get githubToken() { return required('GITHUB_TOKEN'); },
  get githubRepo() { return required('GITHUB_REPO'); },
  get githubBranch() { return optional('GITHUB_BRANCH') ?? 'main'; },
  get cronSecret() { return required('CRON_SECRET'); },
  get voyageKey() { return optional('VOYAGE_API_KEY'); },
  get voyageModel() { return optional('VOYAGE_MODEL') ?? 'voyage-3.5-lite'; },
  get groqKey() { return optional('GROQ_API_KEY'); },
  get supadataKey() { return optional('SUPADATA_API_KEY'); },
};
