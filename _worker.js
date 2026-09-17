// Cloudflare Pages Functions（_worker.js）。serve.py と同じ役割を持つ。
//   /__config   … アプリに「プロキシ経由で繋げる」ことを伝える
//   /gh/*       … GitHub API へ転送（TASKS_REPO 配下のみ許可、トークンは secret）
//   /ai/<kind>  … Gemini に提案を JSON で出させる（tasks / instruct / interpret / triage）
// プロンプトとスキーマは ai-spec.json（serve.py と共有）。それ以外は静的ファイル（env.ASSETS）。
// 認証は Cloudflare Access に任せる。

const GITHUB_API = "https://api.github.com";
const DEFAULT_REPO = "takinai-koki-pra/tasks";
const DEFAULT_MODEL = "gemini-3.8-flash";
const AI_KINDS = ["tasks", "instruct", "interpret", "triage"];

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

let specPromise = null;
function loadSpec(env, request) {
  specPromise ||= env.ASSETS.fetch(new Request(new URL("/ai-spec.json", request.url))).then((r) => {
    if (!r.ok) throw new Error(`ai-spec.json ${r.status}`);
    return r.json();
  }).catch((e) => { specPromise = null; throw e; });
  return specPromise;
}

async function proxyGitHub(request, url, env) {
  const repo = env.TASKS_REPO || DEFAULT_REPO;
  const path = url.pathname.slice("/gh".length);
  // 許可するのはタスク用リポジトリ配下だけ
  if (!path.startsWith(`/repos/${repo}/`) && path !== `/repos/${repo}`) return json({ message: "forbidden path" }, 403);
  if (!env.GITHUB_TOKEN) return json({ message: "GITHUB_TOKEN が未設定です" }, 500);
  const hasBody = !["GET", "HEAD", "DELETE"].includes(request.method);
  const upstream = new Request(GITHUB_API + path + url.search, {
    method: request.method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "gh-task-board",
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
    },
    body: hasBody ? await request.text() : undefined,
  });
  const res = await fetch(upstream);
  const headers = new Headers({ "Cache-Control": "no-store" });
  for (const k of ["Content-Type", "Link"]) if (res.headers.get(k)) headers.set(k, res.headers.get(k));
  return new Response(res.body, { status: res.status, headers });
}

async function callGemini(env, prompt, schema, input) {
  const model = env.GEMINI_MODEL || DEFAULT_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const payload = {
    contents: [{ role: "user", parts: [{ text: prompt + JSON.stringify(input) }] }],
    generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature: 0.2 },
  };
  for (let attempt = 0; attempt < 3; attempt++) { // 429 / 503 は少し待って再試行
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      const data = await res.json();
      const parts = data?.candidates?.[0]?.content?.parts || [];
      return JSON.parse(parts.map((p) => p.text || "").join("") || "{}");
    }
    let msg = "";
    try { msg = (await res.json()).error?.message || ""; } catch { /* ignore */ }
    if ((res.status === 429 || res.status === 503) && attempt < 2) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    throw new Error(`Gemini API ${res.status}: ${msg || res.statusText}`);
  }
  throw new Error("Gemini API: 再試行の上限");
}

async function ai(kind, request, env) {
  if (!env.GEMINI_API_KEY) return json({ message: "GEMINI_API_KEY が未設定です" }, 502);
  let input = {};
  try { input = await request.json(); } catch { return json({ message: "JSON を送ってください" }, 400); }
  try {
    const spec = (await loadSpec(env, request)).endpoints[kind];
    return json(await callGemini(env, spec.prompt, spec.schema, input));
  } catch (e) {
    return json({ message: String(e.message || e) }, 502);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/__config") return json({ repo: env.TASKS_REPO || DEFAULT_REPO, ai: !!env.GEMINI_API_KEY });
    if (url.pathname.startsWith("/gh/")) return proxyGitHub(request, url, env);
    const m = url.pathname.match(/^\/ai\/([a-z]+)$/);
    if (m && AI_KINDS.includes(m[1]) && request.method === "POST") return ai(m[1], request, env);
    return env.ASSETS.fetch(request);
  },
};
