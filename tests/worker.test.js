import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker from "../_worker.js";

// env.ASSETS はリポジトリのファイルを返す。外部への fetch は記録して偽の応答を返す。
function setup({ gemini } = {}) {
  const calls = [];
  const env = {
    TASKS_REPO: "o/tasks",
    GITHUB_TOKEN: "t",
    GEMINI_API_KEY: "k",
    ASSETS: {
      fetch: async (req) => {
        const path = new URL(req.url).pathname;
        try { return new Response(await readFile(new URL(`..${path}`, import.meta.url))); } catch { return new Response("nf", { status: 404 }); }
      },
    },
  };
  globalThis.fetch = async (req, init) => {
    const url = typeof req === "string" ? req : req.url;
    const body = init?.body ?? (req.method && req.method !== "GET" && req.method !== "DELETE" ? await req.text() : undefined);
    calls.push({ url, method: init?.method || req.method, body, auth: req.headers?.get?.("Authorization") });
    if (url.includes("generativelanguage")) {
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(gemini ?? { ok: true }) }] } }] }), { headers: { "Content-Type": "application/json" } });
    }
    return new Response("[]", { headers: { "Content-Type": "application/json", Link: '<x>; rel="next"' } });
  };
  const call = (path, init = {}) => worker.fetch(new Request(`https://board.test${path}`, init), env);
  return { env, calls, call };
}

test("/__config", async () => {
  const { call } = setup();
  assert.deepEqual(await (await call("/__config")).json(), { repo: "o/tasks", ai: true });
});

test("/gh は TASKS_REPO 配下だけ転送し、トークンを付ける", async () => {
  const { call, calls } = setup();
  assert.equal((await call("/gh/user")).status, 403);
  assert.equal((await call("/gh/repos/other/tasks/issues")).status, 403);
  const res = await call("/gh/repos/o/tasks/issues?state=open");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Link"), '<x>; rel="next"');
  assert.equal(calls[0].url, "https://api.github.com/repos/o/tasks/issues?state=open");
  assert.equal(calls[0].auth, "Bearer t");
  await call("/gh/repos/o/tasks/issues/comments/5", { method: "DELETE" });
  assert.equal(calls[1].method, "DELETE");
  await call("/gh/repos/o/tasks/issues/1", { method: "PATCH", body: '{"state":"closed"}' });
  assert.equal(calls[2].body, '{"state":"closed"}');
});

test("/ai/<kind> は ai-spec.json のプロンプトとスキーマで Gemini を呼ぶ", async () => {
  const { call, calls } = setup({ gemini: { changes: [], agent_requests: [], note: "" } });
  const res = await call("/ai/instruct", { method: "POST", body: JSON.stringify({ instruction: "月曜まで" }) });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { changes: [], agent_requests: [], note: "" });
  const sent = JSON.parse(calls[0].body);
  const spec = JSON.parse(await readFile(new URL("../ai-spec.json", import.meta.url), "utf8"));
  assert.equal(sent.contents[0].parts[0].text, `${spec.endpoints.instruct.prompt}{"instruction":"月曜まで"}`);
  assert.deepEqual(sent.generationConfig.responseSchema, spec.endpoints.instruct.schema);
});

test("/ai: 未知の kind・GET は静的ファイル扱い、キーが無ければ 502", async () => {
  const { call, env } = setup();
  assert.equal((await call("/ai/evil", { method: "POST", body: "{}" })).status, 404);
  assert.equal((await call("/ai/tasks")).status, 404);
  delete env.GEMINI_API_KEY;
  assert.equal((await call("/ai/tasks", { method: "POST", body: "{}" })).status, 502);
});

test("ai-spec.json: 全エンドポイントの required はプロパティに存在する", async () => {
  const spec = JSON.parse(await readFile(new URL("../ai-spec.json", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(spec.endpoints).sort(), ["instruct", "interpret", "tasks", "triage"]);
  const walk = (s) => {
    if (s.type === "OBJECT") {
      for (const r of s.required || []) assert.ok(s.properties[r], `required ${r}`);
      for (const k of s.propertyOrdering || []) assert.ok(s.properties[k], `ordering ${k}`);
      Object.values(s.properties).forEach(walk);
    }
    if (s.type === "ARRAY") walk(s.items);
  };
  for (const ep of Object.values(spec.endpoints)) walk(ep.schema);
});
