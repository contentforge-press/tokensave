# tokensave

**Cut your LLM bill 60–80%. Stop runaway spend.**

Your agent has no cost ceiling. `$78,000` is one retry loop away.
Ceilings block the request before the provider is called. Savings shave the rest.

```bash
npm install tokensave                    # Node 18+
pip install git+https://github.com/contentforge-press/tokensave.git#subdirectory=python
```

---

## The 3am incident, rewritten

Same agent, same bug, same retry loop. Only the last line changes.

<table>
<tr><td valign="top">

**without tokensave**

```
03:12:04 POST chat/completions 400
03:12:04 retrying (1/∞)
04:47:33 retrying (1,204/∞)
06:58:10 invoice: $78,412.08
09:00:00 someone opens the dashboard
```

</td><td valign="top">

**with tokensave**

```
03:12:04 POST chat/completions 400
03:12:04 retrying (1/∞)
03:13:41 BudgetExceededError: hourly $5
03:13:41 request blocked — no provider call
06:58:10 invoice: $4.87
09:00:00 someone sleeps in
```

</td></tr>
</table>

---

## Quick start

### Node

```js
import TokenSaver from "tokensave";

const client = new TokenSaver({
  apiKey: process.env.OPENAI_API_KEY,
  maxCostPerRequest: 0.50,
  maxCostPerHour: 5,
  maxCostPerDay: 25,
});

const res = await client.create({
  model: "gpt-4",
  messages: [{ role: "user", content: "What is Python?" }],
});

console.log(res.billing);
// {
//   model: "gpt-4o-mini",   // routed down automatically
//   costUsd: 0.0000212,
//   baselineUsd: 0.00243,
//   savedUsd: 0.0024088,
//   route: "routed down: 3 tokens, 1 simple patterns"
// }
```

### Python

```python
from tokensave import TokenSaver

client = TokenSaver(
    api_key=os.environ["OPENAI_API_KEY"],
    max_cost_per_day=25,
)

res = client.create(model="gpt-4", messages=[...])
print(res.billing.to_dict())
```

---

## Three ceilings

| Limit | Stops | Typical |
|---|---|---|
| `maxCostPerRequest` | One poisoned prompt / oversized context | $0.50 |
| `maxCostPerHour` | Retry storms, infinite loops, runaway agents | $5 |
| `maxCostPerDay` | The number you actually signed off on | $25 |

```js
client.budgetStatus
// { spentDay: 14.02, dayRemaining: 10.98, blocked: 3, savedByCeiling: 78.44 }
```

`savedByCeiling` is money the ceilings stopped you from spending.
Tests assert the request never reaches the provider (`calls === 0`).

---

## Three optimizations

| Leak | What it is | Recovery |
|---|---|---|
| **Repeated questions** | Same question, reworded | up to −40% |
| **Filler tokens** | "please", duplicate sentences | −10 to −25% |
| **Wrong-sized model** | `gpt-4` answering "what is Python" | −30 to −60% |

Every response carries a receipt: `savedUsd`, `baselineUsd`, `costUsd`, `route`.
**You verify the claim yourself. No dashboard, no trust required.**

### Local mode — nothing leaves your machine

```js
const client = new TokenSaver({ apiKey: "...", local: true });
```

Runs entirely in-process. Same engine. Free forever. No metering.

```js
client.savings
// { requests: 120, cacheHits: 43, savedUsd: 0.0182, savedPct: 71.3, ... }
```

---

## Honest limits

| Claim | Reality |
|---|---|
| Catch reworded questions | **Yes**, if vocabulary matches. Normalization, not embeddings. True paraphrases slip through. |
| Route perfectly | **No** — heuristic. A short-but-hard question can be routed down. `route: false` disables. |
| Compress safely always | **Mostly** — regex-based, no summarization. Check `tokensSaved`. |
| Fix a provider double-charge | **No** — billing dispute, different problem. |
| Replace observability | **No** — we measure cost, not quality. Use Langfuse alongside. |

---

## Pricing

**Ceilings are always free** — they're safety, not a feature.

Savings: free under $200/month saved, 20% above capped at $99/month.

| You save | You pay | You keep |
|---|---|---|
| $150 | $0 | $150 |
| $500 | $99 (capped) | $401 |
| $2,000 | $99 (capped) | $1,901 |

---

## Tests

```bash
node products/tokensaver-npm/test.js      # 66 assertions
python python/tokensave.py --selftest     # 48 assertions
```

Both cover: cost math, normalization, compression, routing (including
"don't route complex work down"), cache LRU, budget ceilings (per-request /
hourly / daily), and a full round trip proving a cache hit does not re-call
the provider and a blocked request never reaches it.

---

## Why this exists

Every piece already existed as an open-source library. GPTCache for caching.
LLMLingua for compression. LiteLLM for routing. Cost-ceiling patterns in a
dozen blog posts.

The waste and the risk persisted anyway — because assembling them into
something you'd run in production took longer than most teams had.

That gap is the product. Not new technology. **The distance between "this is
possible" and "this is running for me."** We closed it to one import.

---

MIT
