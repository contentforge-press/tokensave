# tokensave (Python)

**Cut your LLM bill 60–80% — and stop runaway spend.**

```bash
pip install git+https://github.com/contentforge-press/tokensave.git#subdirectory=python
```

---

## Hard cost ceilings

Your agent has no cost ceiling. `$78,000` is one retry loop away.

```python
from tokensave import TokenSaver

client = TokenSaver(
    api_key=os.environ["OPENAI_API_KEY"],
    max_cost_per_request=0.50,   # one call, hard limit
    max_cost_per_hour=5,         # loop guard
    max_cost_per_day=25,         # the number you can sleep on
)

res = client.create(model="gpt-4", messages=[...])
```

When a request would cross a ceiling it raises `BudgetExceededError` **before the provider is called**. The self-test asserts this (`熔断时不调用 provider`).

```python
client.budget_status
# {
#   'spentDay': 14.02, 'spentHour': 2.11,
#   'maxPerDay': 25,   'dayRemaining': 10.98,
#   'blocked': 3,      'savedByCeiling': 78.44
# }
```

`savedByCeiling` is money the ceilings stopped you from spending.

```python
def on_exceeded(err):
    alert(f"agent blocked: {err}")

client = TokenSaver(..., on_budget_exceeded=on_exceeded)
```

---

## And the 60–80% that just leaks

```python
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

| Leak | Recovery |
|---|---|
| Repeated questions (reworded) | up to −40% |
| Filler tokens ("please", duplicate sentences) | −10 to −25% |
| Wrong-sized model (`gpt-4` for "what is Python") | −30 to −60% |

### Local mode — nothing leaves your machine

```python
client = TokenSaver(api_key="sk-...", local=True)
```

Everything runs in-process. No request goes anywhere except your provider.
Same engine. Free forever. No metering.

```python
client.savings.to_dict()
# {'requests': 120, 'cacheHits': 43, 'savedUsd': 0.0182, 'savedPct': 71.3, ...}
```

---

## Honest limits

| Claim | Reality |
|---|---|
| Catch reworded questions | **Yes**, if the vocabulary matches. Normalization, not embeddings. True paraphrases slip through. |
| Route perfectly | **No** — heuristic on surface features. A short-but-hard question can be routed down. `route=False` turns it off. |
| Compress safely always | **Mostly** — regex-based, no summarization. Check `tokensSaved` before trusting it. |
| Fix a provider double-charge | **No** — that's a billing dispute. Different problem. |
| Replace your observability | **No** — we measure cost, not quality. Use Langfuse alongside. |

---

## Pricing

Ceilings are always free — they're safety, not a feature.

Savings-based: free under $200/month saved, 20% above that capped at $99/month.

---

## Test

```bash
python python/tokensave.py --selftest    # 48 assertions, no network
```

---

MIT
