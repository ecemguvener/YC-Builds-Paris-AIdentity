import { policies } from '../store/repositories.js';

/**
 * Natural-language → structured purchase request.
 *
 * Turns a free-text instruction like
 *   "buy me still water from amazon"   (no price!)
 *   "Buy £15 of OpenAI credits"
 * into the exact arguments of requestPurchase():
 *   { merchant_name, merchant_url, amount, currency, purpose, item, price_estimated }
 *
 * Provider precedence (whichever key is present):
 *   1. OPENAI_API_KEY      → OpenAI (function-calling for structured extraction)
 *   2. ANTHROPIC_API_KEY   → Claude (forced tool-call)
 *   3. neither             → built-in heuristic parser (offline demo)
 *
 * Two things make product prompts work even without an explicit amount:
 *   - the price is ESTIMATED (mock data) and flagged with price_estimated
 *   - a REAL merchant link is attached (e.g. an Amazon search URL for the item)
 *
 * The LLM only fills in the form — the policy engine still decides approve/reject.
 */

const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';

const CURRENCY_SYMBOLS = { '£': 'GBP', $: 'USD', '€': 'EUR', '¥': 'JPY' };
const CURRENCY_WORDS = {
  pounds: 'GBP', pound: 'GBP', quid: 'GBP', gbp: 'GBP', sterling: 'GBP',
  dollars: 'USD', dollar: 'USD', usd: 'USD', bucks: 'USD',
  euros: 'EUR', euro: 'EUR', eur: 'EUR',
  yen: 'JPY', jpy: 'JPY',
};

// Canonical brand names (proper casing) used to recognise merchants in free
// text case-insensitively. Longest names are matched first ("Google Cloud"
// before "Google").
const CANONICAL_MERCHANTS = [
  'Amazon', 'OpenAI', 'Google Cloud', 'Google', 'Spotify', 'GitHub',
  'Apple', 'Microsoft', 'Netflix',
];

// Real homepages for known merchants. Amazon is handled separately (search link).
const MERCHANT_HOMEPAGES = {
  openai: 'https://openai.com',
  'google cloud': 'https://cloud.google.com',
  google: 'https://www.google.com',
  spotify: 'https://www.spotify.com',
  github: 'https://github.com',
  apple: 'https://www.apple.com',
  microsoft: 'https://www.microsoft.com',
  netflix: 'https://www.netflix.com',
};

// Mock price estimates (major units, GBP-ish) keyed by item keyword.
const PRICE_HINTS = [
  [/\b(still |sparkling )?water\b/i, 4.99],
  [/\bcoffee|latte|espresso\b/i, 3.5],
  [/\b(api )?credits?\b/i, 20],
  [/\bgift ?card\b/i, 25],
  [/\bbook|paperback|hardback\b/i, 12.99],
  [/\bcable|charger|adapter\b/i, 9.99],
  [/\bpen|notebook|stationery|stapler\b/i, 4.5],
  [/\bsubscription|plan|membership\b/i, 9.99],
  [/\bcompute|server|instance|hosting\b/i, 30],
];
const DEFAULT_PRICE = 9.99;

function estimatePrice(item) {
  if (item) {
    for (const [re, price] of PRICE_HINTS) if (re.test(item)) return price;
  }
  return DEFAULT_PRICE;
}

/** Build a real, working link for the merchant (Amazon → product search). */
function buildMerchantUrl(merchantName, item, fallbackUrl) {
  const key = (merchantName || '').trim().toLowerCase();
  if (/amazon/.test(key)) {
    const q = encodeURIComponent((item || merchantName || '').trim() || 'shopping');
    return `https://www.amazon.co.uk/s?k=${q}`;
  }
  if (MERCHANT_HOMEPAGES[key]) return MERCHANT_HOMEPAGES[key];
  // partial match (e.g. "Google Cloud Platform")
  for (const [name, url] of Object.entries(MERCHANT_HOMEPAGES)) {
    if (key.includes(name)) return url;
  }
  return fallbackUrl || undefined;
}

function knownMerchants(agentId) {
  const policy = policies.getByAgent(agentId);
  if (!policy) return [];
  return [...new Set([...(policy.allowed_merchants || []), ...(policy.blocked_merchants || [])])];
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Find a known merchant named anywhere in the text (case-insensitive). */
function findKnownMerchant(text, agentId) {
  const candidates = [...new Set([...knownMerchants(agentId), ...CANONICAL_MERCHANTS])].sort(
    (a, b) => b.length - a.length,
  );
  for (const c of candidates) {
    if (new RegExp(`\\b${esc(c)}\\b`, 'i').test(text)) return c; // canonical casing
  }
  return null;
}

// JSON schema shared by both LLM providers.
const SCHEMA = {
  type: 'object',
  properties: {
    merchant_name: {
      type: 'string',
      description:
        "Merchant/vendor to pay (e.g. 'Amazon', 'OpenAI'). If the text loosely matches a known merchant, use that exact name.",
    },
    item: {
      type: 'string',
      description: "The product or service being bought, e.g. 'still water'. Omit if not applicable.",
    },
    merchant_url: {
      type: 'string',
      description:
        'A real URL for the purchase. For Amazon use https://www.amazon.co.uk/s?k=<url-encoded item>. For known brands use their homepage.',
    },
    amount: {
      type: 'number',
      description:
        'Amount in major currency units. If the user gave no price, ESTIMATE a realistic current retail price and set price_estimated=true.',
    },
    price_estimated: {
      type: 'boolean',
      description: 'true if you estimated the amount because the user did not state a price.',
    },
    currency: {
      type: 'string',
      description: 'ISO 4217 code inferred from any symbol/word; default GBP.',
    },
    purpose: { type: 'string', description: 'Short description of the purchase.' },
  },
  required: ['merchant_name', 'amount', 'currency', 'purpose'],
  additionalProperties: false,
};

function systemPrompt(agentId) {
  const merchants = knownMerchants(agentId);
  return (
    'You convert a natural-language spending instruction into a single structured purchase request. ' +
    'Infer currency from any symbol ($,£,€) or words ("dollars","quid"); default to GBP. ' +
    'If the user names a product but no price (e.g. "buy me still water from amazon"), estimate a realistic current retail price in that currency and set price_estimated=true. ' +
    'Always provide a real merchant_url: for Amazon use https://www.amazon.co.uk/s?k=<url-encoded item>; for known brands use their homepage. ' +
    'Keep purpose short. ' +
    (merchants.length ? `Known merchants for this agent (prefer an exact match): ${merchants.join(', ')}.` : '')
  );
}

// ── OpenAI path ──────────────────────────────────────────────────────────────
async function parseWithOpenAI(text, agentId) {
  const { default: OpenAI } = await import('openai');
  const client = new OpenAI(); // reads OPENAI_API_KEY from env

  const res = await client.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [
      { role: 'system', content: systemPrompt(agentId) },
      { role: 'user', content: text },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'submit_purchase_request',
          description: 'Record the structured purchase the user wants to make.',
          parameters: SCHEMA,
        },
      },
    ],
    tool_choice: { type: 'function', function: { name: 'submit_purchase_request' } },
  });

  const call = res.choices?.[0]?.message?.tool_calls?.[0];
  if (!call) throw new Error('OpenAI did not return a structured purchase request');
  return finalize(JSON.parse(call.function.arguments), 'openai', text);
}

// ── Claude path ──────────────────────────────────────────────────────────────
async function parseWithClaude(text, agentId) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env

  const response = await client.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 1024,
    system: systemPrompt(agentId),
    tools: [
      {
        name: 'submit_purchase_request',
        description: 'Record the structured purchase the user wants to make. Call this exactly once.',
        input_schema: SCHEMA,
      },
    ],
    tool_choice: { type: 'tool', name: 'submit_purchase_request' },
    messages: [{ role: 'user', content: text }],
  });

  const toolUse = response.content.find((b) => b.type === 'tool_use');
  if (!toolUse) throw new Error('Claude did not return a structured purchase request');
  return finalize(toolUse.input, 'claude', text);
}

// ── Heuristic fallback ───────────────────────────────────────────────────────
function parseHeuristic(text, agentId) {
  let currency = 'GBP';
  let amount;
  let price_estimated = false;

  const sym = text.match(/([£$€¥])\s*([0-9]+(?:\.[0-9]{1,2})?)/);
  if (sym) {
    currency = CURRENCY_SYMBOLS[sym[1]];
    amount = parseFloat(sym[2]);
  } else {
    const numWord = text.match(/([0-9]+(?:\.[0-9]{1,2})?)\s*([A-Za-z]+)/);
    if (numWord && CURRENCY_WORDS[numWord[2].toLowerCase()]) {
      amount = parseFloat(numWord[1]);
      currency = CURRENCY_WORDS[numWord[2].toLowerCase()];
    } else {
      const wordNum = text.match(/\b([A-Za-z]+)\s*([0-9]+(?:\.[0-9]{1,2})?)/);
      if (wordNum && CURRENCY_WORDS[wordNum[1].toLowerCase()]) {
        currency = CURRENCY_WORDS[wordNum[1].toLowerCase()];
        amount = parseFloat(wordNum[2]);
      } else {
        const bare = text.match(/([0-9]+(?:\.[0-9]{1,2})?)/);
        if (bare) amount = parseFloat(bare[1]);
      }
    }
  }

  // Merchant: known brand anywhere → single token after a preposition → brand token.
  let merchant_name = findKnownMerchant(text, agentId);
  if (!merchant_name) {
    const prep = text.match(/\b(?:from|at|to|on|with|via|of|for)\s+([A-Za-z][\w&.\-]+)/i);
    if (prep) {
      const tok = prep[1];
      merchant_name =
        CANONICAL_MERCHANTS.find((c) => c.toLowerCase() === tok.toLowerCase()) ||
        tok.charAt(0).toUpperCase() + tok.slice(1);
    }
  }
  if (!merchant_name) {
    // First brand-like token (CamelCase like "OpenAI" or a capitalised word),
    // skipping common command/filler words.
    const STOP = /^(Buy|Pay|Top|Get|Purchase|Order|Spend|Grab|Pick|The|For|And|Some|Still|Sparkling)$/;
    for (const m of text.matchAll(/\b([A-Z][a-z]*[A-Z][A-Za-z]*|[A-Z][A-Za-z]{2,})\b/g)) {
      if (!STOP.test(m[1])) {
        merchant_name = m[1];
        break;
      }
    }
  }
  if (!merchant_name) merchant_name = 'Unknown merchant';

  // Item: the thing after "buy/get/order …", trimmed of merchant + price.
  let item;
  const itemMatch = text.match(
    /\b(?:buy|get|order|purchase|grab|pick up)\s+(?:me\s+)?(?:some\s+|a\s+|an\s+|the\s+)?(.+?)(?:\s+(?:from|at|on|for|via)\b|[.,!?]|$)/i,
  );
  if (itemMatch) {
    item = itemMatch[1].replace(/[£$€¥]\s*[0-9]+(?:\.[0-9]{1,2})?/g, '').trim();
    if (!item) item = undefined;
  }

  if (amount == null || Number.isNaN(amount)) {
    amount = estimatePrice(item || text);
    price_estimated = true;
  }

  return finalize(
    { merchant_name, item, amount, currency, price_estimated, purpose: item ? `Buy ${item}` : text.trim() },
    'heuristic',
    text,
  );
}

/** Post-process any provider's raw fields into the final, validated shape. */
function finalize(input, parsedBy, originalText) {
  const merchant_name = String(input.merchant_name || '').trim() || 'Unknown merchant';
  const item = input.item ? String(input.item).trim() : undefined;
  let amount = typeof input.amount === 'number' ? input.amount : Number(input.amount);
  let price_estimated = !!input.price_estimated;

  if (amount == null || Number.isNaN(amount) || amount <= 0) {
    amount = estimatePrice(item || originalText);
    price_estimated = true;
  }

  return {
    merchant_name,
    item,
    merchant_url: buildMerchantUrl(merchant_name, item, input.merchant_url),
    amount,
    currency: String(input.currency || 'GBP').toUpperCase().trim(),
    purpose: String(input.purpose || (item ? `Buy ${item}` : originalText) || '').trim(),
    price_estimated,
    parsed_by: parsedBy,
  };
}

/**
 * Parse free text into purchase-request fields.
 * @param {{text:string, agentId:string}} args
 */
export async function parsePurchaseFromText({ text, agentId }) {
  if (!text || !text.trim()) {
    throw Object.assign(new Error('Empty instruction'), { code: 'invalid_request' });
  }

  const tryLLM = process.env.OPENAI_API_KEY
    ? () => parseWithOpenAI(text, agentId)
    : process.env.ANTHROPIC_API_KEY
      ? () => parseWithClaude(text, agentId)
      : null;

  if (tryLLM) {
    try {
      return await tryLLM();
    } catch (err) {
      // Key/network issues shouldn't break the demo — fall back, but say why.
      // eslint-disable-next-line no-console
      console.warn('[parsePurchase] LLM parse failed, using heuristic:', err.message);
    }
  }
  return parseHeuristic(text, agentId);
}
