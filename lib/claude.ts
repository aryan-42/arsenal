import Anthropic from '@anthropic-ai/sdk';
import { env } from './env';

let client: Anthropic | null = null;

function claude(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: env.anthropicKey });
  return client;
}

interface ToolCall {
  system: string;
  user: string;
  toolName: string;
  toolDescription: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
}

/** Forces Claude to answer through a tool so the output is structured JSON. */
export async function callTool<T>(opts: ToolCall): Promise<T> {
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
  if (res.stop_reason === 'max_tokens') throw new Error('Claude output was cut off (max_tokens reached)');
  const block = res.content.find((b) => b.type === 'tool_use');
  if (!block || block.type !== 'tool_use') throw new Error('Claude did not return structured output');
  return block.input as T;
}

export async function callText(opts: { system: string; user: string; maxTokens?: number }): Promise<string> {
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
