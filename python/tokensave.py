"""TokenSaver Python 版。

与 Node 版行为一致：
  · 同样的压缩规则
  · 同样的路由逻辑
  · 同样的归一化
  · 同样的计费字段

零依赖（标准库 + urllib）。
已内置测试。
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

__version__ = "1.0.0"
__all__ = ["TokenSaver", "Billing", "Savings", "PRICING", "compress_prompt",
           "route_model", "estimate_tokens", "calc_cost", "normalize_for_cache"]

HOSTED_URL = "https://tokensaver.contentforge-press.workers.dev"

PRICING = {
    "gpt-4o-mini": {"in": 0.15, "out": 0.60},
    "gpt-4o": {"in": 2.50, "out": 10.00},
    "gpt-4": {"in": 30.00, "out": 60.00},
    "gpt-4-turbo": {"in": 10.00, "out": 30.00},
    "gpt-3.5-turbo": {"in": 0.50, "out": 1.50},
    "claude-3-haiku-20240307": {"in": 0.25, "out": 1.25},
    "claude-3-5-sonnet-20241022": {"in": 3.00, "out": 15.00},
    "claude-3-opus-20240229": {"in": 15.00, "out": 75.00},
}

CHEAP_FALLBACK = {
    "gpt-4": "gpt-4o-mini",
    "gpt-4-turbo": "gpt-4o-mini",
    "gpt-4o": "gpt-4o-mini",
    "claude-3-opus-20240229": "claude-3-haiku-20240307",
    "claude-3-5-sonnet-20241022": "claude-3-haiku-20240307",
}

_CN_RE = re.compile(r"[\u4e00-\u9fff]")


def estimate_tokens(text: str | None) -> int:
    """粗略估算 token 数。中文 ~1.5 字符/token，其他 ~4 字符/token。"""
    if not text:
        return 0
    s = str(text)
    cn = len(_CN_RE.findall(s))
    return int(-(-(cn / 1.5 + (len(s) - cn) / 4) // 1))  # ceil


def calc_cost(model: str, in_tok: int, out_tok: int) -> float:
    p = PRICING.get(model)
    if not p:
        return 0.0
    return (in_tok * p["in"] + out_tok * p["out"]) / 1_000_000


# ============================================================
# 归一化
# ============================================================
_TS_RE = re.compile(
    r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?")
_DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}")
_UUID_RE = re.compile(
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
_EMAIL_RE = re.compile(r"\b\w+@\w+\.\w+\b")
_LONGNUM_RE = re.compile(r"\b\d{10,}\b")
_WS_RE = re.compile(r"\s+")


def normalize_for_cache(text: str | None) -> str:
    """归一化文本用于缓存键。

    顺序重要：先处理大小写敏感的模式（时间戳/UUID），最后才转小写。
    """
    s = str(text or "")
    s = _TS_RE.sub("<T>", s)
    s = _DATE_RE.sub("<D>", s)
    s = _UUID_RE.sub("<U>", s)
    s = _EMAIL_RE.sub("<E>", s)
    s = _LONGNUM_RE.sub("<N>", s)
    s = s.lower()
    return _WS_RE.sub(" ", s).strip()


# ============================================================
# 压缩
# ============================================================
FILLERS = [
    (re.compile(r"\b(please|kindly)\s+", re.I), ""),
    (re.compile(r"\bi would like you to\s+", re.I), ""),
    (re.compile(r"\bi want you to\s+", re.I), ""),
    (re.compile(r"\bit is important that you\s+", re.I), ""),
    (re.compile(r"\bin order to\s+", re.I), "to "),
    (re.compile(r"\bat this point in time\s+", re.I), "now "),
    (re.compile(r"\bdue to the fact that\s+", re.I), "because "),
]

_SENT_SPLIT = re.compile(r"(?<=[.!?])\s+")


def compress_prompt(text: str | None) -> tuple[str, int]:
    """返回 (压缩后文本, 节省的 token 数)"""
    if not text:
        return (text or ""), 0
    before = estimate_tokens(text)
    out = str(text)
    for pat, repl in FILLERS:
        out = pat.sub(repl, out)

    sents = _SENT_SPLIT.split(out)
    seen = set()
    kept = []
    for s in sents:
        n = s.strip().lower()
        if n and n not in seen:
            seen.add(n)
            kept.append(s)
    out = _WS_RE.sub(" ", " ".join(kept)).strip()
    return out, max(0, before - estimate_tokens(out))


# ============================================================
# 路由
# ============================================================
COMPLEX_PATTERNS = [
    re.compile(r"\b(analyze|analyse|compare|evaluate|reason|explain why)\b", re.I),
    re.compile(r"\b(code|implement|refactor|debug|algorithm)\b", re.I),
    re.compile(r"\b(prove|derive|calculate|compute)\b", re.I),
    re.compile(r"\bstep by step\b", re.I),
    re.compile(r"```"),
]
SIMPLE_PATTERNS = [
    re.compile(r"^(hi|hello|hey|thanks|ok)\b", re.I),
    re.compile(r"\b(what is|who is|define|list)\b", re.I),
    re.compile(r"\b(translate|convert|format|summarize)\b", re.I),
]


def route_model(messages: list[dict], requested: str,
                enabled: bool = True) -> tuple[str, str]:
    """返回 (选中的模型, 理由)"""
    if not enabled:
        return requested, "routing off"

    text = " ".join(str(m.get("content") or "") for m in messages)
    tokens = estimate_tokens(text)
    complex_hits = sum(1 for p in COMPLEX_PATTERNS if p.search(text))
    simple_hits = sum(1 for p in SIMPLE_PATTERNS if p.search(text))

    if complex_hits == 0 and tokens < 500 and (simple_hits >= 1 or tokens < 100):
        cheaper = CHEAP_FALLBACK.get(requested)
        if cheaper:
            return cheaper, f"routed down: {tokens} tokens, {simple_hits} simple patterns"

    return requested, "complex or long — kept model"


# ============================================================
# 内存缓存
# ============================================================
class MemoryCache:
    def __init__(self, max_entries: int = 500):
        self.max = max_entries
        self.map: dict[str, Any] = {}

    def _key(self, model: str, messages: list[dict]) -> str:
        core = ""
        for m in reversed(messages):
            if m.get("role") == "user":
                core = normalize_for_cache(m.get("content"))
                break
        h = hashlib.sha256(f"{model}|{core}".encode()).hexdigest()[:24]
        return h

    def get(self, model: str, messages: list[dict]):
        k = self._key(model, messages)
        if k in self.map:
            v = self.map.pop(k)
            self.map[k] = v  # LRU 提升
            return v
        return None

    def set(self, model: str, messages: list[dict], value):
        k = self._key(model, messages)
        if len(self.map) >= self.max and k not in self.map:
            self.map.pop(next(iter(self.map)))
        self.map[k] = value

    def __len__(self):
        return len(self.map)


# ============================================================
# 数据结构
# ============================================================
@dataclass
class Billing:
    model: str
    costUsd: float
    baselineUsd: float
    savedUsd: float
    cached: bool = False
    tokensSaved: int = 0
    route: str = ""

    def to_dict(self) -> dict:
        return {
            "model": self.model,
            "costUsd": round(self.costUsd, 6),
            "baselineUsd": round(self.baselineUsd, 6),
            "savedUsd": round(self.savedUsd, 6),
            "cached": self.cached,
            "tokensSaved": self.tokensSaved,
            "route": self.route,
        }


@dataclass
class Savings:
    requests: int = 0
    cacheHits: int = 0
    tokensSaved: int = 0
    costActual: float = 0.0
    costBaseline: float = 0.0

    @property
    def savedUsd(self) -> float:
        return round(max(0.0, self.costBaseline - self.costActual), 6)

    @property
    def savedPct(self) -> float:
        if self.costBaseline <= 0:
            return 0.0
        return round(self.savedUsd / self.costBaseline * 100, 1)

    def to_dict(self) -> dict:
        return {
            "requests": self.requests,
            "cacheHits": self.cacheHits,
            "tokensSaved": self.tokensSaved,
            "costActualUsd": round(self.costActual, 6),
            "costBaselineUsd": round(self.costBaseline, 6),
            "savedUsd": self.savedUsd,
            "savedPct": self.savedPct,
        }


@dataclass
class Response:
    """包装 provider 响应 + billing"""
    raw: dict
    billing: Billing

    def __getitem__(self, k):
        return self.raw.get(k)

    def get(self, k, default=None):
        return self.raw.get(k, default)

    def __repr__(self):
        return f"<Response billing={self.billing.to_dict()}>"


# ============================================================
# 客户端
# ============================================================
class TokenSaver:
    """LLM 成本优化客户端。

    用法:
        client = TokenSaver(api_key="sk-...")
        res = client.create(model="gpt-4", messages=[{"role":"user","content":"hi"}])
        print(res.billing.savedUsd)

    本地模式（不经过我们的服务器）:
        client = TokenSaver(api_key="sk-...", local=True)
    """

    def __init__(self, api_key: str | None = None,
                 base_url: str = "https://api.openai.com/v1",
                 proxy_url: str = HOSTED_URL,
                 local: bool = False,
                 route: bool = True,
                 cache: bool = True,
                 compress: bool = True,
                 timeout: int = 120):
        self.api_key = api_key or os.environ.get("OPENAI_API_KEY", "")
        self.base_url = base_url.rstrip("/")
        self.proxy_url = proxy_url.rstrip("/")
        self.local = local
        self.route = route
        self.cache_on = cache
        self.compress_on = compress
        self.timeout = timeout

        self.cache = MemoryCache()
        self._savings = Savings()

    @property
    def savings(self) -> Savings:
        return self._savings

    def create(self, **params) -> Response:
        if self.local:
            return self._local_create(params)
        return self._hosted_create(params)

    # ---------- 托管模式 ----------
    def _hosted_create(self, params: dict) -> Response:
        body = dict(params)
        body["base_url"] = f"{self.base_url}/chat/completions"

        req = urllib.request.Request(
            f"{self.proxy_url}/v1/chat/completions",
            data=json.dumps(body).encode(),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.api_key}",
                "X-TS-Route": "on" if self.route else "off",
            },
            method="POST")

        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                raw = json.loads(r.read())
                hdrs = dict(r.headers)
        except urllib.error.HTTPError as e:
            try:
                err = json.loads(e.read())
            except Exception:
                err = {"error": {"message": f"HTTP {e.code}"}}
            raise RuntimeError(err.get("error", {}).get("message", str(err))) from None

        def h(name, default="0"):
            for k, v in hdrs.items():
                if k.lower() == name.lower():
                    return v
            return default

        billing = Billing(
            model=h("X-TS-Model", params.get("model", "")),
            costUsd=float(h("X-TS-Cost-Usd")),
            baselineUsd=float(h("X-TS-Baseline-Usd")),
            savedUsd=float(h("X-TS-Saved-Usd")),
            cached=h("X-TS-Cache") == "hit",
            tokensSaved=int(float(h("X-TS-Tokens-Saved"))),
            route=h("X-TS-Route", ""),
        )
        return Response(raw=raw, billing=billing)

    # ---------- 本地模式 ----------
    def _local_create(self, params: dict) -> Response:
        messages = list(params.get("messages") or [])
        requested = params.get("model") or "gpt-4o-mini"

        self._savings.requests += 1

        model, reason = route_model(messages, requested, self.route)

        # 缓存
        if self.cache_on:
            hit = self.cache.get(model, messages)
            if hit:
                self._savings.cacheHits += 1
                full = " ".join(str(m.get("content") or "") for m in messages)
                baseline = calc_cost(requested, estimate_tokens(full),
                                     estimate_tokens(hit.get("content") or ""))
                self._savings.costBaseline += baseline
                return Response(raw=hit.get("raw") or {}, billing=Billing(
                    model=model, costUsd=0.0, baselineUsd=baseline,
                    savedUsd=baseline, cached=True,
                    tokensSaved=0, route="cache hit"))

        # 压缩
        tokens_saved = 0
        out_messages = []
        for m in messages:
            content = m.get("content")
            if self.compress_on and isinstance(content, str):
                new, saved = compress_prompt(content)
                tokens_saved += saved
                out_messages.append({**m, "content": new})
            else:
                out_messages.append(m)

        # 调 provider
        payload = dict(params)
        payload["model"] = model
        payload["messages"] = out_messages

        req = urllib.request.Request(
            f"{self.base_url}/chat/completions",
            data=json.dumps(payload).encode(),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.api_key}",
            },
            method="POST")

        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                raw_text = r.read().decode("utf-8")
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "ignore")
            try:
                msg = json.loads(body).get("error", {}).get("message", body[:200])
            except Exception:
                msg = body[:200]
            raise RuntimeError(msg) from None

        raw = json.loads(raw_text)

        # 记账
        out_text = ""
        try:
            out_text = raw["choices"][0]["message"]["content"] or ""
        except (KeyError, IndexError, TypeError):
            out_text = raw_text

        idx = " ".join(str(m.get("content") or "") for m in out_messages)
        fdx = " ".join(str(m.get("content") or "") for m in messages)
        actual = calc_cost(model, estimate_tokens(idx), estimate_tokens(out_text))
        baseline = calc_cost(requested, estimate_tokens(fdx), estimate_tokens(out_text))

        self._savings.tokensSaved += tokens_saved
        self._savings.costActual += actual
        self._savings.costBaseline += baseline

        if self.cache_on:
            self.cache.set(model, messages, {"raw": raw, "content": out_text})

        return Response(raw=raw, billing=Billing(
            model=model, costUsd=actual, baselineUsd=baseline,
            savedUsd=max(0.0, baseline - actual), cached=False,
            tokensSaved=tokens_saved, route=reason))


# ============================================================
# 自测
# ============================================================
def _selftest() -> int:
    P = F = 0

    def t(name, cond, detail=""):
        nonlocal P, F
        if cond:
            P += 1
            print(f"  PASS  {name}")
        else:
            F += 1
            print(f"  FAIL  {name}  {detail}")

    print("=" * 70)
    print("tokensave (Python) 自测")
    print("=" * 70)

    print("\n[1] token / 成本")
    t("空字符串=0", estimate_tokens("") == 0)
    t("英文>0", estimate_tokens("hello world") > 0)
    t("中文>0", estimate_tokens("你好世界") > 0)
    t("gpt-4 百万=$30", abs(calc_cost("gpt-4", 1_000_000, 0) - 30) < 0.001)
    t("未知=0", calc_cost("nope", 1000, 1000) == 0)

    print("\n[2] 归一化")
    t("大小写", normalize_for_cache("What Is Python?") ==
      normalize_for_cache("what is python?"))
    t("时间戳", normalize_for_cache("at 2026-01-15T10:00:00") ==
      normalize_for_cache("at 2026-09-20T08:30:00"))
    t("邮箱", normalize_for_cache("a@b.com") == normalize_for_cache("z@y.org"))
    t("不同问题", normalize_for_cache("python") != normalize_for_cache("rust"))

    print("\n[3] 压缩")
    txt, saved = compress_prompt(
        "Please kindly explain. I would like you to be brief.")
    t("去填充词", "please" not in txt.lower() and "would like" not in txt.lower())
    t("保留语义", "explain" in txt.lower())
    t("记录节省", saved > 0, str(saved))
    dup, _ = compress_prompt("Same. Same. Same.")
    t("去重复", dup.lower().count("same") == 1, dup)

    print("\n[4] 路由")
    m, why = route_model([{"role": "user", "content": "What is Python?"}], "gpt-4", True)
    t("简单降级", m == "gpt-4o-mini", m)
    m2, _ = route_model([{"role": "user", "content":
                          "Analyze and compare these two algorithms step by step. ```py```"}],
                        "gpt-4", True)
    t("复杂保持", m2 == "gpt-4", m2)
    m3, _ = route_model([{"role": "user", "content": "What is Python?"}], "gpt-4", False)
    t("关闭时保持", m3 == "gpt-4", m3)

    print("\n[5] 缓存")
    c = MemoryCache(3)
    c.set("m", [{"role": "user", "content": "What is Python?"}], {"raw": {}, "content": "x"})
    t("命中", c.get("m", [{"role": "user", "content": "what is python?"}]) is not None)
    t("不命中", c.get("m", [{"role": "user", "content": "What is Go?"}]) is None)
    for i in range(5):
        c.set("m", [{"role": "user", "content": f"q{i}"}], {"raw": {}})
    t("LRU 限制", len(c) <= 3, str(len(c)))

    print("\n[6] 端到端（mock provider）")
    import io
    orig = urllib.request.urlopen
    calls = {"n": 0}

    class FakeResp:
        def __init__(self, payload):
            self._p = json.dumps(payload).encode()
        def read(self):
            return self._p
        def __enter__(self):
            return self
        def __exit__(self, *a):
            return False

    def fake_urlopen(req, timeout=None):
        calls["n"] += 1
        body = json.loads(req.data.decode())
        return FakeResp({
            "id": "chatcmpl-fake",
            "model": body.get("model"),
            "choices": [{"message": {"role": "assistant",
                                     "content": "A programming language."}}],
        })

    urllib.request.urlopen = fake_urlopen
    try:
        client = TokenSaver(api_key="sk-test", local=True)
        r1 = client.create(model="gpt-4", messages=[
            {"role": "user", "content": "What is Python?"}])
        t("请求成功", r1.get("id") == "chatcmpl-fake")
        t("有 billing", r1.billing is not None)
        t("降级了", r1.billing.model == "gpt-4o-mini", r1.billing.model)
        t("有节省", r1.billing.savedUsd > 0, str(r1.billing.savedUsd))
        first = calls["n"]

        r2 = client.create(model="gpt-4", messages=[
            {"role": "user", "content": "what is python?"}])
        t("第二次命中缓存", r2.billing.cached is True)
        t("缓存不花钱", r2.billing.costUsd == 0)
        t("缓存不再调 provider", calls["n"] == first, f"{calls['n']} vs {first}")

        sv = client.savings
        t("savings 请求数", sv.requests == 2, str(sv.requests))
        t("savings 命中数", sv.cacheHits == 1, str(sv.cacheHits))
        t("savings 基准>实际", sv.costBaseline > sv.costActual)

        plain = TokenSaver(api_key="sk-test", local=True,
                           route=False, cache=False, compress=False)
        r3 = plain.create(model="gpt-4o-mini", messages=[
            {"role": "user", "content": "What is Python?"}])
        t("全关保持原模型", r3.billing.model == "gpt-4o-mini")
        t("全关无节省", r3.billing.savedUsd == 0, str(r3.billing.savedUsd))
    finally:
        urllib.request.urlopen = orig

    print("\n" + "=" * 70)
    print(f"结果: {P} 通过, {F} 失败")
    print("=" * 70)
    return 0 if F == 0 else 1


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    if "--selftest" in sys.argv:
        sys.exit(_selftest())
    print(f"tokensave {__version__} — import TokenSaver to use")
