# tokensave

**Cut your LLM bill 60–80%.** A drop-in client that removes the part of every request that was never doing any work.

```bash
pip install tokensave
```

```python
from tokensave import TokenSaver

client = TokenSaver(api_key="sk-...")

res = client.create(
    model="gpt-4",
    messages=[{"role": "user", "content": "What is Python?"}],
)

print(res.billing.to_dict())
```

```python
{
  "model": "gpt-4o-mini",     # routed down automatically
  "costUsd": 0.0000212,       # what you paid
  "baselineUsd": 0.00243,     # what you would have paid
  "savedUsd": 0.0024088,      # what you kept
  "cached": False,
  "tokensSaved": 4,
  "route": "routed down: 3 tokens, 1 simple patterns"
}
```

---

## The problem nobody was measuring

Three things leak money on nearly every LLM call:

| Leak | What it looks like | Recovery |
|---|---|---|
| **Repeated questions** | The same question reworded, billed again in full | up to −40% |
| **Filler tokens** | "please", "I would like you to", duplicated sentences | −10 to −25% |
| **Wrong-sized model** | `gpt-4` answering "what is Python" | −30 to −60% |

None of this was hidden. It was **unmeasured** — because measuring it meant assembling three separate libraries and wiring them into a proxy that could actually run in production.

That assembly is the product. Not new technology — **the time between "this is possible" and "this is running for me."**

---

## Two modes

### Hosted — zero setup

```python
client = TokenSaver(api_key="sk-...")
```

Requests go through our proxy. We cache, compress, route, and attach receipts.

You pay only on **proven** savings: free under $200/month saved, 20% above that capped at $99/month. The cap means the better it works, the better your deal gets.

### Local — nothing leaves your machine

```python
client = TokenSaver(api_key="sk-...", local=True)
```

Everything runs in-process. No request goes anywhere except your provider. Same engine. Free forever. No metering.

```python
client.savings.to_dict()
# {'requests': 120, 'cacheHits': 43, 'savedUsd': 0.0182, 'savedPct': 71.3, ...}
```

---

## What each optimization actually does

### 1. Semantic cache

Questions are normalized before hashing: timestamps, UUIDs, emails and long numbers become placeholders, case is folded, whitespace collapsed. Two requests differing only in those details hit the same entry.

**Real limitation:** normalization, not embeddings. It catches reworded repeats with the same vocabulary, not true paraphrases. Fast and free; not omniscient.

### 2. Prompt compression

Strips filler (`please`, `kindly`, `I would like you to`, `in order to` → `to`) and drops duplicated sentences. Meaning survives; tokens don't.

**Real limitation:** regex-based. It does not summarize. Aggressive prompts may lose nuance — check `tokensSaved` before trusting it blindly.

### 3. Model routing

Scores complexity from surface features (length, code blocks, reasoning verbs). Simple requests map to a cheap model from the same family:

```
gpt-4              → gpt-4o-mini
gpt-4o             → gpt-4o-mini
claude-3-opus      → claude-3-haiku
claude-3.5-sonnet  → claude-3-haiku
```

**Real limitation:** a heuristic. A short-but-hard question can be routed down. Disable with `route=False` when precision matters more than cost.

---

## Verifying the savings yourself

Every response carries billing data. No dashboard, no trust required:

```python
res.billing.savedUsd      # money you didn't spend
res.billing.baselineUsd   # money you would have spent
res.billing.costUsd       # money you did spend
res.billing.route         # why this model was chosen

client.savings.savedPct   # cumulative, across the client's lifetime
```

---

## Pricing

| You save | You pay | You keep |
|---|---|---|
| $150 | $0 | $150 |
| $500 | $99 (capped) | $401 |
| $2,000 | $99 (capped) | $1,901 |
| $10,000 | $99 (capped) | $9,901 |

The cap is deliberate. If it works well for you, it should cost you less, not more.

---

## Install

```bash
pip install tokensave
python -m tokensave --selftest    # 31 assertions, no network needed
```

## License

MIT
