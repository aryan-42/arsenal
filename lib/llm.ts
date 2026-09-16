import Anthropic from '@anthropic-ai/sdk';
import { env } from './env';
import { errMsg, sleep } from './util';

/**
 * One interface for every model provider.
 * - LLM_PROVIDER=anthropic (default): Claude via the Anthropic API
 * - LLM_PROVIDER=openrouter | nvidia | openai: any OpenAI-compatible chat API
 */

export interface ToolCall {
  system: string;
  user: string;
  toolName: string;
  toolDescription: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
}

export interface TextCall {
  system: string;
  user: string;
  maxTokens?: number;
}

export async function callTool<T>(opts: ToolCall): Promise<T> {
  return env.llmProvider === 'anthropic' ? anthropicTool<T>(opts) : openaiTool<T>(opts);
}

export async function callText(opts: TextCall): Promise<string> {
  return env.llmProvider === 'anthropic' ? anthropicText(opts) : openaiText(opts);
}

export function describeModel(): string {
  return env.llmProvider === 'anthropic'
    ? `anthropic / ${env.claudeModel}`
    : `${env.llmProviderName} / ${env.llmModels.join(' → ')}`;
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

let anthropic: Anthropic | null = null;

function claude(): Anthropic {
  if (!anthropic) anthropic = new Anthropic({ apiKey: env.anthropicKey });
  return anthropic;
}

async function anthropicTool<T>(opts: ToolCall): Promise<T> {
  const res = await claude().messages.create({
    model: env.claudeModel,
    max_tokens: opts.maxTokens ?? 8000,
    system: opts.system,
    messages: [{ role: 'user', content: opts.user }],
    tools: [
      {
        name: opts.toolName,
        description: opts.toolDescription,
        input_schema: opts.schema as Anthropic.Messages.Tool.InputSchema,
      },
    ],
    tool_choice: { type: 'tool', name: opts.toolName },
  });
  if (res.stop_reason === 'max_tokens') throw new Error('Model output was cut off (max_tokens reached)');
  const block = res.content.find((b) => b.type === 'tool_use');
  if (!block || block.type !== 'tool_use') throw new Error('Model did not return structured output');
  return block.input as T;
}

async function anthropicText(opts: TextCall): Promise<string> {
  const res = await claude().messages.create({
    model: env.claudeModel,
    max_tokens: opts.maxTokens ?? 3000,
    system: opts.system,
    messages: [{ role: 'user', content: opts.user }],
  });
  return res.content
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('')
    .trim();
}

// ---------------------------------------------------------------------------
// OpenAI-compatible (OpenRouter, NVIDIA NIM, OpenAI, Groq, …)
// ---------------------------------------------------------------------------

export class LlmError extends Error {
  constructor(
    public status: number,
    message: string,
    public retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Strips reasoning blocks and code fences, then parses the first JSON object in the text. */
export function parseJsonLoose(text: string | null | undefined): unknown {
  if (!text) return null;
  let t = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  try {
    return JSON.parse(t);
  } catch {
    // try the outermost braces
  }
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(t.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

function stripReasoning(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

interface ChatResponse {
  choices?: {
    finish_reason?: string;
    message?: {
      content?: string | null;
      tool_calls?: { function?: { name?: string; arguments?: string | Record<string, unknown> } }[];
    };
  }[];
  error?: { message?: string; code?: number | string };
}

async function chat(model: string, body: Record<string, unknown>): Promise<ChatResponse> {
  let res: Response;
  try {
    res = await fetch(`${env.llmBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.llmApiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/aryan-42/arsenal', // OpenRouter attribution (ignored elsewhere)
        'X-Title': 'Arsenal',
      },
      body: JSON.stringify({ model, ...body }),
      signal: AbortSignal.timeout(150_000),
      cache: 'no-store',
    });
  } catch (e) {
    throw new LlmError(408, `${model}: request failed or timed out (${errMsg(e)})`);
  }
  const raw = await res.text();
  let json: ChatResponse | null = null;
  try {
    json = JSON.parse(raw) as ChatResponse;
  } catch {
    json = null;
  }
  if (!res.ok || json?.error || !json) {
    const status = !res.ok ? res.status : Number(json?.error?.code) || 502;
    const message = json?.error?.message ?? raw.slice(0, 200);
    const retryAfter = Number(res.headers.get('retry-after')) || undefined;
    throw new LlmError(status, `${model}: ${message}`, retryAfter);
  }
  return json;
}

/** Tries each configured model in order; retries rate limits and server errors briefly. */
async function withModels<T>(run: (model: string) => Promise<T>): Promise<T> {
  const errors: string[] = [];
  for (const model of env.llmModels) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await run(model);
      } catch (e) {
        const status = e instanceof LlmError ? e.status : 500;
        errors.push(errMsg(e));
        if (!RETRYABLE.has(status)) break; // bad request / not found / auth: try the next model
        if (attempt === 0) {
          const wait = e instanceof LlmError && e.retryAfterSeconds ? e.retryAfterSeconds * 1000 : 3000;
          await sleep(Math.min(wait, 10_000));
        }
      }
    }
  }
  throw new Error(`All models failed. ${errors.slice(-3).join(' | ')}`);
}

async function openaiTool<T>(opts: ToolCall): Promise<T> {
  const maxTokens = Math.min(opts.maxTokens ?? 8000, env.llmMaxOutputTokens);
  return withModels(async (model) => {
    // 1. Native tool calling
    try {
      const res = await chat(model, {
        messages: [
          { role: 'system', content: opts.system },
          { role: 'user', content: opts.user },
        ],
        tools: [
          {
            type: 'function',
            function: { name: opts.toolName, description: opts.toolDescription, parameters: opts.schema },
          },
        ],
        tool_choice: { type: 'function', function: { name: opts.toolName } },
        max_tokens: maxTokens,
        temperature: 0.2,
      });
      const choice = res.choices?.[0];
      const calls = choice?.message?.tool_calls ?? [];
      const call = calls.find((c) => c.function?.name === opts.toolName) ?? calls[0];
      const args = call?.function?.arguments;
      const parsed = typeof args === 'string' ? parseJsonLoose(args) : args;
      if (parsed && typeof parsed === 'object') return parsed as T;
      const fromText = parseJsonLoose(choice?.message?.content);
      if (fromText && typeof fromText === 'object') return fromText as T;
      if (choice?.finish_reason === 'length') {
        throw new LlmError(400, `${model}: output was cut off. Raise LLM_MAX_OUTPUT_TOKENS or use a bigger model.`);
      }
    } catch (e) {
      // Rate limits and outages go to the retry logic; anything else falls back to JSON-in-prompt
      if (e instanceof LlmError && RETRYABLE.has(e.status)) throw e;
    }

    // 2. Fallback for models without tool support: ask for raw JSON
    const res = await chat(model, {
      messages: [
        {
          role: 'system',
          content: `${opts.system}

OUTPUT FORMAT
Respond with ONLY one JSON object (no prose, no code fences) for "${opts.toolName}" (${opts.toolDescription}), matching this JSON Schema:
${JSON.stringify(opts.schema)}`,
        },
        { role: 'user', content: opts.user },
      ],
      max_tokens: maxTokens,
      temperature: 0.2,
    });
    const parsed = parseJsonLoose(res.choices?.[0]?.message?.content);
    if (!parsed || typeof parsed !== 'object') {
      throw new LlmError(502, `${model}: did not return valid JSON`);
    }
    return parsed as T;
  });
}

async function openaiText(opts: TextCall): Promise<string> {
  const maxTokens = Math.min(opts.maxTokens ?? 3000, env.llmMaxOutputTokens);
  return withModels(async (model) => {
    const res = await chat(model, {
      messages: [
        { role: 'system', content: opts.system },
        { role: 'user', content: opts.user },
      ],
      max_tokens: maxTokens,
      temperature: 0.3,
    });
    const text = stripReasoning(res.choices?.[0]?.message?.content ?? '');
    if (!text) throw new LlmError(502, `${model}: empty response`);
    return text;
  });
}
