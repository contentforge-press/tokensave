const T = require("./index.js");

let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}  ${detail || ""}`); }
}
function eq(name, a, b) {
  t(name, JSON.stringify(a) === JSON.stringify(b),
    `got=${JSON.stringify(a)} want=${JSON.stringify(b)}`);
}

console.log("=".repeat(70));
console.log("tokensaver 自测");
console.log("=".repeat(70));

/* ---------- 1. token / cost ---------- */
console.log("\n[1] token 估算与成本");
t("空字符串 = 0", T.estimateTokens("") === 0);
t("英文 > 0", T.estimateTokens("hello world") > 0);
t("中文 > 0", T.estimateTokens("你好世界") > 0);
t("中文比同长度英文占更多 token",
  T.estimateTokens("你好世界你好世界") > T.estimateTokens("aaaaaaaa"));
t("gpt-4 百万输入 = $30",
  Math.abs(T.calcCost("gpt-4", 1000000, 0) - 30) < 0.001,
  String(T.calcCost("gpt-4", 1000000, 0)));
t("gpt-4o-mini 比 gpt-4 便宜 > 100 倍",
  T.calcCost("gpt-4", 1000, 1000) / T.calcCost("gpt-4o-mini", 1000, 1000) > 100);
t("未知模型成本 = 0", T.calcCost("unknown-model", 1000, 1000) === 0);

/* ---------- 2. 归一化 ---------- */
console.log("\n[2] 缓存归一化");
eq("大小写不敏感",
  T.normalizeForCache("What Is Python?"),
  T.normalizeForCache("what is python?"));
eq("时间戳被归一",
  T.normalizeForCache("data at 2026-01-15T10:00:00"),
  T.normalizeForCache("data at 2026-09-20T08:30:00"));
eq("邮箱被归一",
  T.normalizeForCache("user a@b.com"),
  T.normalizeForCache("user zzz@yyy.org"));
eq("UUID 被归一",
  T.normalizeForCache("id 550e8400-e29b-41d4-a716-446655440000"),
  T.normalizeForCache("id 11111111-2222-3333-4444-555555555555"));
t("不同问题不归一",
  T.normalizeForCache("What is Python?") !== T.normalizeForCache("What is Rust?"));

/* ---------- 3. 压缩 ---------- */
console.log("\n[3] Prompt 压缩");
const c1 = T.compressPrompt(
  "Please kindly explain this. I would like you to be brief. Please be brief.");
t("去掉填充词", !/please|i would like/i.test(c1.text), c1.text);
t("记录节省 token", c1.saved > 0, String(c1.saved));
t("语义保留（explain 还在）", /explain/i.test(c1.text), c1.text);

const c2 = T.compressPrompt("Same sentence. Same sentence. Same sentence.");
t("去重复句子", c2.text.toLowerCase().split("same sentence").length === 2, c2.text);

const c3 = T.compressPrompt("");
t("空输入安全", c3.text === "" && c3.saved === 0);

/* ---------- 4. 路由 ---------- */
console.log("\n[4] 模型路由");
const simple = T.routeModel([{ role: "user", content: "What is Python?" }], "gpt-4", true);
t("简单问题降级", simple.model === "gpt-4o-mini", simple.model);

const complex = T.routeModel(
  [{ role: "user", content: "Analyze and compare these two algorithms step by step, then prove the time complexity. ```python```" }],
  "gpt-4", true);
t("复杂问题保持", complex.model === "gpt-4", complex.model);

const longMsg = T.routeModel(
  [{ role: "user", content: "x".repeat(3000) }], "gpt-4", true);
t("长上下文保持", longMsg.model === "gpt-4", longMsg.model);

const off = T.routeModel([{ role: "user", content: "What is Python?" }], "gpt-4", false);
t("关闭路由时保持", off.model === "gpt-4", off.model);

const claudeRoute = T.routeModel(
  [{ role: "user", content: "What is Rust?" }], "claude-3-opus-20240229", true);
t("Claude 也能降级", claudeRoute.model === "claude-3-haiku-20240307", claudeRoute.model);

/* ---------- 5. 缓存 ---------- */
console.log("\n[5] 语义缓存");
const cache = new T.MemoryCache(3);
cache.set("m1", [{ role: "user", content: "What is Python?" }], { raw: "A" });
t("命中同一问题",
  cache.get("m1", [{ role: "user", content: "What is Python?" }]) !== null);
t("变体命中（大小写）",
  cache.get("m1", [{ role: "user", content: "what is python?" }]) !== null);
t("不同问题不命中",
  cache.get("m1", [{ role: "user", content: "What is Go?" }]) === null);
t("不同模型不命中",
  cache.get("m2", [{ role: "user", content: "What is Python?" }]) === null);

// LRU
for (let i = 0; i < 5; i++) {
  cache.set("m1", [{ role: "user", content: `q${i}` }], { raw: String(i) });
}
t("LRU 容量限制", cache.map.size <= 3, String(cache.map.size));
t("最新的还在",
  cache.get("m1", [{ role: "user", content: "q4" }]) !== null);

/* ---------- 6. 本地模式端到端（fake fetch） ---------- */
console.log("\n[6] 本地模式端到端");
const realFetch = global.fetch;
let calls = 0;
global.fetch = async (url, init) => {
  calls++;
  const body = JSON.parse(init.body);
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify({
      id: "chatcmpl-test",
      model: body.model,
      choices: [{ message: { role: "assistant", content: "A programming language." } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
  };
};

(async () => {
  const client = new T({ apiKey: "sk-test", local: true });

  const r1 = await client.create({
    model: "gpt-4",
    messages: [{ role: "user", content: "What is Python?" }],
  });
  t("请求成功", r1.id === "chatcmpl-test");
  t("有 billing 字段", !!r1.billing);
  t("billing 记录了基准成本", r1.billing.baselineUsd > 0, String(r1.billing.baselineUsd));
  t("billing 记录了实际成本", r1.billing.costUsd >= 0);
  t("billing 有路由原因", typeof r1.billing.route === "string" && r1.billing.route.length > 0);
  t("简单问题被降级", r1.billing.model === "gpt-4o-mini", r1.billing.model);
  t("确实节省了", r1.billing.savedUsd > 0, String(r1.billing.savedUsd));
  const firstCalls = calls;

  // 第二次相同问题 → 命中缓存
  const r2 = await client.create({
    model: "gpt-4",
    messages: [{ role: "user", content: "what is python?" }],
  });
  t("第二次命中缓存", r2.billing.cached === true);
  t("缓存命中不花钱", r2.billing.costUsd === 0);
  t("缓存命中不再调用 provider", calls === firstCalls, `${calls} vs ${firstCalls}`);

  const sv = client.savings;
  t("savings 累计请求数", sv.requests === 2, String(sv.requests));
  t("savings 累计缓存命中", sv.cacheHits === 1, String(sv.cacheHits));
  t("savings 有节省百分比", sv.savedPct > 0, String(sv.savedPct));
  t("savings 基准 > 实际",
    sv.costBaselineUsd > sv.costActualUsd,
    `${sv.costBaselineUsd} vs ${sv.costActualUsd}`);

  // 关闭所有优化 → 应该没有节省
  const plain = new T({
    apiKey: "sk-test", local: true,
    route: false, cache: false, compress: false,
  });
  const r3 = await plain.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "What is Python?" }],
  });
  t("全关时保持原模型", r3.billing.model === "gpt-4o-mini");
  t("全关时无节省", r3.billing.savedUsd === 0, String(r3.billing.savedUsd));

  // 错误处理
  global.fetch = async () => ({
    ok: false, status: 429,
    headers: { get: () => null },
    text: async () => JSON.stringify({ error: { message: "rate limited" } }),
  });
  try {
    await client.create({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] });
    t("错误应该抛出", false);
  } catch (e) {
    t("错误正确抛出", e.status === 429 && /rate limited/.test(e.message), e.message);
  }

  global.fetch = realFetch;

  console.log("\n" + "=".repeat(70));
  console.log(`结果: ${pass} 通过, ${fail} 失败`);
  console.log("=".repeat(70));
  process.exit(fail === 0 ? 0 : 1);
})();
