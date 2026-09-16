/**
 * Plain conversation, for the assistant that answers questions about Atelier.
 *
 * SEPARATE FROM groqStructured ON PURPOSE
 *
 * Everything else the model does here is extraction: a brief, a score, a
 * verdict — each one validated against a zod schema because a malformed answer
 * decides whether somebody gets hired or paid. This is the one call whose
 * output is prose for a person to read, so there is no schema to hold it to.
 *
 * It also must not be able to hurt the hire loop. The poller pauses LLM work
 * when it sees a rate limit, so a visitor asking questions could, through that
 * shared signal, stop the agent hiring anybody. Nothing here touches that
 * signal, and it defaults to the fallback model so a burst of curiosity spends
 * the cheaper budget first.
 */
import Groq from "groq-sdk";
import { config } from "../config.js";

const groq = new Groq({ apiKey: config.groqApiKey });

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface GroqChatOpts {
  system: string;
  messages: ChatTurn[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

export class AssistantUnavailable extends Error {}

export async function groqChat(opts: GroqChatOpts): Promise<string> {
  if (!config.groqApiKey) throw new AssistantUnavailable("No model is configured.");

  /* Fallback first: this is the one caller whose answers are a convenience, and
     the primary model's budget belongs to hiring and reviewing. */
  const models = [...new Set([opts.model ?? config.groqFallbackModel, config.groqModel].filter(Boolean))];

  let lastErr: unknown;
  for (const model of models) {
    try {
      const res = await groq.chat.completions.create({
        model,
        max_tokens: opts.maxTokens ?? 700,
        temperature: opts.temperature ?? 0.3,
        messages: [
          { role: "system", content: opts.system },
          ...opts.messages.map((m) => ({ role: m.role, content: m.content })),
        ],
      });
      const text = res.choices[0]?.message?.content?.trim();
      if (text) return text;
      lastErr = new Error(`${model} returned an empty answer`);
    } catch (err) {
      lastErr = err;
      const status = (err as { status?: number })?.status;
      // 429 here means this model is busy, not that the agent should stop
      // working. Try the next one and otherwise give up quietly.
      if (status && status !== 429 && status < 500) break;
    }
  }

  throw new AssistantUnavailable(
    lastErr instanceof Error ? lastErr.message : "The assistant could not answer just now.",
  );
}
