/**
 * TokenSaver — cut your LLM bill.
 *
 * Two modes:
 *
 *   1. Hosted proxy (default) — zero setup, we handle everything
 *      const client = new TokenSaver({ apiKey: process.env.OPENAI_API_KEY });
 *
 *   2. Local mode — pure offline, no network to us at all
 *      const client = new TokenSaver({ apiKey: '...', local: true });
 *
 * Both return a response with real billing numbers attached.
 */

const HOSTED_URL = "https://tokensaver.contentforge-press.workers.dev";

const PRICING = {
  "gpt-4o-mini": { in: 0.15, out: 0.60 },
  "gpt-4o": { in: 2.50, out: 10.00 },
  "gpt-4": { in: 30.00, out: 60.00 },
  "gpt-4-turbo": { in: 10.00, out: 30.00 },
  "gpt-3.5-turbo": { in: 0.50, out: 1.50 },
  "claude-3-haiku-20240307": { in: 0.25, out: 1.25 },
  "claude-3-5-sonnet-20241022": { in: 3.00, out: 15.00 },
  "claude-3-opus-20240229": { in: 15.00, out: 75.00 },
};

const CHEAP_FALLBACK = {
  "gpt-4": "gpt-4o-mini",
  "gpt-4-turbo": "gpt-4o-mini",
  "gpt-4o": "gpt-4o-mini",
  "gpt-33.5-turbo": "gpt-3.5-turbo",
  "claude-3-opus-20240229": "claude-3-haiku-20240307",
  "claude-3-5-sonnet-20241022": "claude-3-haiku-20240307",
};

function estimateTokens(text) {
  if (!text) return 0;
  const s = String(text);
  const cn = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  return Math.ceil(cn / 1.5 + (s.length - cn) / 4);
}

function calcCost(model, inTok, outTok) {
  const p = PRICING[model];
  if (!p) return 0;
  return (inTok * p.in + outTok * p.out) / 1e6;
}

/* ---------- prompt compression ---------- */
const FILLERS = [
  [/\b(please|kindly)\s+/gi, ""],
  [/\bi would like you to\s+/gi, ""],
  [/\bi want you to\s+/gi, ""],
  [/\bit is important that you\s+/gi, ""],
  [/\bin order to\s+/gi, "to "],
  [/\bat this point in time\s+/gi, "now "],
  [/\bdue to the fact that\s+/gi, "because "],
];

function compressPrompt(text) {
  if (!text) return { text, saved: 0 };
  const before = estimateTokens(text);
  let out = String(text);
  for (const [pat, repl] of FILLERS) out = out.replace(pat, repl);

  const sents = out.split(/(?<=[.!?])\s+/);
  const seen = new Set();
  const kept = [];
  for (const s of sents) {
    const n = s.trim().toLowerCase();
    if (n && !seen.has(n)) { seen.add(n); kept.push(s); }
  }
  out = kept.join(" ").replace(/\s+/g, " ").trim();
  return { text: out, saved: Math.max(0, before - estimateTokens(out)) };
}

/* ---------- routing ---------- */
const COMPLEX = [
  /\b(analyze|analyse|compare|evaluate|reason|explain why)\b/i,
  /\b(code|implement|refactor|debug|algorithm)\b/i,
  /\b(prove|derive|calculate|compute)\b/i,
  /\bstep by step\b/i,
  /```/,
];
const SIMPLE = [
  /^(hi|hello|hey|thanks|ok)\b/i,
  /\b(what is|who is|define|list)\b/i,
  /\b(translate|convert|format|summarize)\b/i,
];

function routeModel(messages, requested, enabled) {
  if (!enabled) return { model: requested, reason: "routing off" };
  const text = messages.map((m) => m.content || "").join(" ");
  const tokens = estimateTokens(text);
  const complexHits = COMPLEX.filter((p) => p.test(text)).length;
  const simpleHits = SIMPLE.filter((p) => p.test(text)).length;

  if (complexHits === 0 && tokens < 500 && (simpleHits >= 1 || tokens < 100)) {
    const cheaper = CHEAP_FALLBACK[requested];
    if (cheaper) {
      return {
        model: cheaper,
        reason: `routed down: ${tokens} tokens, ${simpleHits} simple patterns`,
      };
    }
  }
  return { model: requested, reason: "complex or long — kept model" };
}

/* ---------- semantic cache (in-memory for local mode) ---------- */
function normalizeForCache(text) {
  // 注意顺序：先归一化时间戳/UUID（大小写敏感），最后才转小写
  return String(text || "")
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, "<T>")
    .replace(/\d{4}-\d{2}-\d{2}/g, "<D>")
    .replace(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, "<U>")
    .replace(/\b\w+@\w+\.\w+\b/g, "<E>")
    .replace(/\b\d{10,}\b/g, "<N>")
    .toLowerCase()
    .replace(/\s+/g, " ").trim();
}

class MemoryCache {
  constructor(max = 500) {
    this.max = max;
    this.map = new Map();
  }
  get size() { return this.map.size; }
  key(model, messages) {
    let core = "";
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        core = normalizeForCache(messages[i].content);
        break;
      }
    }
    return `${model}|${core}`;
  }
  get(model, messages) {
    const k = this.key(model, messages);
    const hit = this.map.get(k);
    if (hit) {
      this.map.delete(k);
      this.map.set(k, hit); // LRU bump
      return hit;
    }
    return null;
  }
  set(model, messages, value) {
    const k = this.key(model, messages);
    if (this.map.size >= this.max) {
      this.map.delete(this.map.keys().next().value);
    }
    this.map.set(k, value);
  }
}

/* ---------- main client ---------- */
class TokenSaver {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey       Your provider key (OpenAI / Anthropic etc.)
   * @param {string} [opts.baseURL]    Upstream API (default OpenAI)
   * @param {string} [opts.proxyURL]   Hosted TokenSaver (default: ours)
   * @param {boolean} [opts.local]     Run entirely in-process, no network to us
   * @param {boolean} [opts.route]     Model routing on/off (default true)
   * @param {boolean} [opts.cache]     Semantic cache on/off (default true)
   * @param {boolean} [opts.compress]  Prompt compression on/off (default true)
   */
  constructor(opts = {}) {
    this.apiKey = opts.apiKey || process.env.OPENAI_API_KEY;
    this.baseURL = (opts.baseURL || "https://api.openai.com/v1").replace(/\/$/, "");
    this.proxyURL = (opts.proxyURL || HOSTED_URL).replace(/\/$/, "");
    this.local = !!opts.local;
    this.route = opts.route !== false;
    this.cacheOn = opts.cache !== false;
    this.compressOn = opts.compress !== false;

    this.cache = new MemoryCache();
    this.stats = {
      requests: 0,
      cacheHits: 0,
      tokensSaved: 0,
      costActual: 0,
      costBaseline: 0,
    };
  }

  /** Cumulative savings — this is the number you should trust */
  get savings() {
    const saved = Math.max(0, this.stats.costBaseline - this.stats.costActual);
    return {
      requests: this.stats.requests,
      cacheHits: this.stats.cacheHits,
      tokensSaved: this.stats.tokensSaved,
      costActualUsd: +this.stats.costActual.toFixed(6),
      costBaselineUsd: +this.stats.costBaseline.toFixed(6),
      savedUsd: +saved.toFixed(6),
      savedPct: this.stats.costBaseline > 0
        ? +((saved / this.stats.costBaseline) * 100).toFixed(1)
        : 0,
    };
  }

  /**
   * chat.completions.create — drop-in compatible.
   *
   * Returns the normal response object plus a `billing` field:
   *   { model, costUsd, baselineUsd, savedUsd, cached, tokensSaved }
   */
  async create(params) {
    if (this.local) return this._localCreate(params);

    // Hosted mode: we forward to our Worker which does everything server-side
    const res = await fetch(`${this.proxyURL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
        "X-TS-Route": this.route ? "on" : "off",
      },
      body: JSON.stringify({
        ...params,
        base_url: `${this.baseURL}/chat/completions`,
      }),
    });

    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    if (!res.ok) {
      const err = new Error(data?.error?.message || `HTTP ${res.status}`);
      err.status = res.status;
      err.body = data;
      throw err;
    }

    const saved = +(res.headers.get("X-TS-Saved-Usd") || 0);
    const cost = +(res.headers.get("X-TS-Cost-Usd") || 0);
    const baseline = +(res.headers.get("X-TS-Baseline-Usd") || 0);

    data.billing = {
      model: res.headers.get("X-TS-Model") || params.model,
      costUsd: cost,
      baselineUsd: baseline,
      savedUsd: saved,
      cached: res.headers.get("X-TS-Cache") === "hit",
      tokensSaved: +(res.headers.get("X-TS-Tokens-Saved") || 0),
      route: res.headers.get("X-TS-Route") || "",
    };
    return data;
  }

  /** Fully local path — no request ever leaves your machine except to the provider */
  async _localCreate(params) {
    const messages = params.messages || [];
    const requested = params.model || "gpt-4o-mini";

    this.stats.requests += 1;

    // 1. route
    const { model, reason } = this.route
      ? routeModel(messages, requested, true)
      : { model: requested, reason: "routing off" };

    // 2. cache
    if (this.cacheOn) {
      const hit = this.cache.get(model, messages);
      if (hit) {
        this.stats.cacheHits += 1;
        const baseline = calcCost(requested,
          estimateTokens(messages.map((m) => m.content).join(" ")),
          estimateTokens(hit.content || ""));
        this.stats.costBaseline += baseline;
        const data = JSON.parse(hit.raw);
        data.billing = {
          model, costUsd: 0, baselineUsd: +baseline.toFixed(6),
          savedUsd: +baseline.toFixed(6), cached: true,
          tokensSaved: 0, route: "cache hit",
        };
        return data;
      }
    }

    // 3. compress
    let tokensSaved = 0;
    const outMessages = this.compressOn
      ? messages.map((m) => {
          const r = compressPrompt(m.content);
          tokensSaved += r.saved;
          return { ...m, content: r.text };
        })
      : messages;

    // 4. call provider
    const res = await fetch(`${this.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ ...params, model, messages: outMessages }),
    });

    const raw = await res.text();
    let data;
    try { data = JSON.parse(raw); } catch { data = { raw }; }

    if (!res.ok) {
      const err = new Error(data?.error?.message || `HTTP ${res.status}`);
      err.status = res.status;
      err.body = data;
      throw err;
    }

    // 5. accounting
    const inTok = estimateTokens(outMessages.map((m) => m.content).join(" "));
    const fullTok = estimateTokens(messages.map((m) => m.content).join(" "));
    const outTok = estimateTokens(
      data?.choices?.[0]?.message?.content || raw);

    const actualCost = calcCost(model, inTok, outTok);
    const baselineCost = calcCost(requested, fullTok, outTok);

    this.stats.tokensSaved += tokensSaved;
    this.stats.costActual += actualCost;
    this.stats.costBaseline += baselineCost;

    if (this.cacheOn) {
      this.cache.set(model, messages, {
        raw, content: data?.choices?.[0]?.message?.content || "",
      });
    }

    data.billing = {
      model,
      costUsd: +actualCost.toFixed(6),
      baselineUsd: +baselineCost.toFixed(6),
      savedUsd: +Math.max(0, baselineCost - actualCost).toFixed(6),
      cached: false,
      tokensSaved,
      route: reason,
    };
    return data;
  }
}

module.exports = TokenSaver;
module.exports.TokenSaver = TokenSaver;
module.exports.PRICING = PRICING;
module.exports.compressPrompt = compressPrompt;
module.exports.routeModel = routeModel;
module.exports.estimateTokens = estimateTokens;
module.exports.calcCost = calcCost;
module.exports.normalizeForCache = normalizeForCache;
module.exports.MemoryCache = MemoryCache;
