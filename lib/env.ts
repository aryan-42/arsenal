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
  /** anthropic (default), or openrouter / nvidia / openai for any OpenAI-compatible API */
  get llmProviderName() { return (optional('LLM_PROVIDER') ?? 'anthropic').toLowerCase(); },
  get llmProvider(): 'anthropic' | 'openai' {
    return this.llmProviderName === 'anthropic' ? 'anthropic' : 'openai';
  },
  get anthropicKey() { return required('ANTHROPIC_API_KEY'); },
  get claudeModel() { return optional('CLAUDE_MODEL') ?? 'claude-sonnet-5'; },
  get llmBaseUrl() {
    const preset: Record<string, string> = {
      openrouter: 'https://openrouter.ai/api/v1',
      nvidia: 'https://integrate.api.nvidia.com/v1',
      openai: 'https://api.openai.com/v1',
    };
    const url = optional('LLM_BASE_URL') ?? preset[this.llmProviderName];
    if (!url) throw new Error('Missing environment variable: LLM_BASE_URL');
    return url.replace(/\/+$/, '');
  },
  get llmApiKey() { return required('LLM_API_KEY'); },
  /** LLM_MODEL first, then LLM_FALLBACK_MODELS (comma-separated), tried in order */
  get llmModels(): string[] {
    const list = [optional('LLM_MODEL'), ...(optional('LLM_FALLBACK_MODELS')?.split(',') ?? [])]
      .map((m) => m?.trim())
      .filter((m): m is string => Boolean(m));
    if (!list.length) throw new Error('Missing environment variable: LLM_MODEL');
    return list;
  },
  get llmMaxOutputTokens() { return Number(optional('LLM_MAX_OUTPUT_TOKENS') ?? 8000); },
  get githubToken() { return required('GITHUB_TOKEN'); },
  get githubRepo() { return required('GITHUB_REPO'); },
  get githubBranch() { return optional('GITHUB_BRANCH') ?? 'main'; },
  get cronSecret() { return required('CRON_SECRET'); },
  get voyageKey() { return optional('VOYAGE_API_KEY'); },
  get voyageModel() { return optional('VOYAGE_MODEL') ?? 'voyage-3.5-lite'; },
  get groqKey() { return optional('GROQ_API_KEY'); },
  get supadataKey() { return optional('SUPADATA_API_KEY'); },
};
