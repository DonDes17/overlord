// $ per 1M tokens, per model. Used for the "equivalent API cost" shown in Insights, an estimate: a
// subscription may not bill it, and cache writes are priced at the 5-minute TTL rate.
//
// Source: Anthropic's published model pricing (claude-api reference, cached 2026-10-06). Cache writes cost
// 1.25x input; cache reads are 0.1x input except on Opus 5.5 ($0.20), Fable 5.1 / Mythos 5.1 ($0.25) and
// Fable 5 / Mythos 5 ($1). A model that is not listed is not priced: callers must say so, never guess.
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const price = (input: number, output: number, cacheRead = input * 0.1): ModelPrice => ({
  input,
  output,
  cacheRead,
  cacheWrite: input * 1.25,
});

const PRICES: [RegExp, ModelPrice][] = [
  [/^claude-(fable|mythos)-5-1$/, price(10, 50, 0.25)],
  [/^claude-(fable|mythos)-5$/, price(10, 50, 1)],
  [/^claude-opus-5-5$/, price(4, 20, 0.2)],
  [/^claude-opus-(5|4-8|4-7|4-6)$/, price(5, 25)],
  // Opus 4 / 4.1: the rate this file used before it was priced per model.
  [/^claude-opus-4(-1)?$/, price(15, 75)],
  [/^claude-sonnet-5(-5)?$/, price(2, 10)],
  [/^claude-sonnet-4-6$/, price(3, 15)],
  [/^claude-haiku-5-5$/, price(0.1, 0.5)],
  [/^claude-haiku-4-5$/, price(1, 5)],
];

// Haiku 5.5 bills prompts above 100K tokens at $0.50 / $2.50 (cache multipliers assumed unchanged).
const HAIKU_5_5_LONG_PROMPT: ModelPrice = price(0.5, 2.5);
const LONG_PROMPT_TOKENS = 100_000;

// "claude-opus-4-8[1m]", "claude-haiku-4-5-20251001", "anthropic.claude-sonnet-4-6-v1:0" -> "claude-<name>"
export function normalizeModel(id: string): string {
  const at = id.indexOf("claude-");
  return (at >= 0 ? id.slice(at) : id)
    .toLowerCase()
    .replace(/\[.*\]$/, "")
    .replace(/-v\d+:\d+$/, "")
    .replace(/@\d+$/, "")
    .replace(/-\d{8}$/, "");
}

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** Cost in dollars of one message, or null when the model has no known price. */
export function usageCost(model: string, usage: Usage): number | null {
  const normalized = normalizeModel(model);
  const found = PRICES.find(([pattern]) => pattern.test(normalized));
  if (!found) return null;

  const input = usage.input_tokens || 0;
  const read = usage.cache_read_input_tokens || 0;
  const write = usage.cache_creation_input_tokens || 0;
  const output = usage.output_tokens || 0;

  const rate = normalized === "claude-haiku-5-5" && input + read + write > LONG_PROMPT_TOKENS ? HAIKU_5_5_LONG_PROMPT : found[1];
  return (input * rate.input + read * rate.cacheRead + write * rate.cacheWrite + output * rate.output) / 1e6;
}
