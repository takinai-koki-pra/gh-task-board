// Cloudflare Pages Functions（_worker.js）。serve.py と同じ 3 つの役割を持つ。
//   /__config   … アプリに「プロキシ経由で繋げる」ことを伝える
//   /gh/*       … GitHub API へ転送（TASKS_REPO 配下のみ許可、トークンは secret）
//   /ai/tasks   … Gemini でテキストをタスク配列に整形
// それ以外は静的ファイル（env.ASSETS）。認証は Cloudflare Access に任せる。

const GITHUB_API = "https://api.github.com";
const DEFAULT_REPO = "takinai-koki-pra/tasks";
const DEFAULT_MODEL = "gemini-3.8-flash";

const AI_PROMPT = `あなたはタスク整理アシスタントです。ユーザーが貼り付けたテキスト（メモ・メール・議事録・箇条書きなど）から、
実行すべきタスクを抽出してください。

ルール:
- title は 40 字以内の自然な日本語で、動詞で終える（例: 「山田さんに NDA を返送する」）
- 重複や言い換えは 1 つにまとめる
- 挨拶・雑談・単なる事実の記述はタスクにしない
- 期日・締切・リンク・補足は title ではなく body に書く（無ければ空文字）
- 今すぐ着手すべきものは column を "todo"、いつかやる・検討中は "backlog"
- 何も抽出できなければ空配列

--- テキスト ---
`;

const GEMINI_SCHEMA = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      title: { type: "STRING" },
      body: { type: "STRING" },
      column: { type: "STRING", enum: ["todo", "backlog"] },
    },
    required: ["title", "body", "column"],
  },
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

async function proxyGitHub(request, url, env) {
  const repo = env.TASKS_REPO || DEFAULT_REPO;
  const path = url.pathname.slice("/gh".length);
  // 許可するのはタスク用リポジトリ配下だけ
  if (!path.startsWith(`/repos/${repo}/`) && path !== `/repos/${repo}`) return json({ message: "forbidden path" }, 403);
  if (!env.GITHUB_TOKEN) return json({ message: "GITHUB_TOKEN が未設定です" }, 500);
  const upstream = new Request(GITHUB_API + path + url.search, {
    method: request.method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "gh-task-board",
      ...(request.method !== "GET" ? { "Content-Type": "application/json" } : {}),
    },
    body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.text(),
  });
  const res = await fetch(upstream);
  const headers = new Headers({ "Cache-Control": "no-store" });
  for (const k of ["Content-Type", "Link"]) if (res.headers.get(k)) headers.set(k, res.headers.get(k));
  return new Response(res.body, { status: res.status, headers });
}

async function aiTasks(request, env) {
  if (!env.GEMINI_API_KEY) return json({ message: "GEMINI_API_KEY が未設定です" }, 502);
  let text = "";
  try { text = String((await request.json()).text || ""); } catch { /* 空扱い */ }
  if (!text.trim()) return json({ tasks: [] });
  const model = env.GEMINI_MODEL || DEFAULT_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const payload = {
    contents: [{ role: "user", parts: [{ text: AI_PROMPT + text }] }],
    generationConfig: { responseMimeType: "application/json", responseSchema: GEMINI_SCHEMA, temperature: 0.2 },
  };
  let data = null;
  for (let attempt = 0; attempt < 3; attempt++) { // 429 / 503 は少し待って再試行
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify(payload),
    });
    if (res.ok) { data = await res.json(); break; }
    let msg = "";
    try { msg = (await res.json()).error?.message || ""; } catch { /* ignore */ }
    if ((res.status === 429 || res.status === 503) && attempt < 2) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    return json({ message: `Gemini API ${res.status}: ${msg || res.statusText}` }, 502);
  }
  const parts = data?.candidates?.[0]?.content?.parts || [];
  let tasks = [];
  try { tasks = JSON.parse(parts.map((p) => p.text || "").join("") || "[]"); } catch { tasks = []; }
  return json({
    tasks: tasks
      .filter((t) => t && typeof t === "object" && String(t.title || "").trim())
      .map((t) => ({
        title: String(t.title).trim().slice(0, 120),
        body: String(t.body || "").trim(),
        column: ["todo", "backlog"].includes(t.column) ? t.column : "todo",
      })),
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/__config") return json({ repo: env.TASKS_REPO || DEFAULT_REPO, ai: !!env.GEMINI_API_KEY });
    if (url.pathname.startsWith("/gh/")) return proxyGitHub(request, url, env);
    if (url.pathname === "/ai/tasks" && request.method === "POST") return aiTasks(request, env);
    return env.ASSETS.fetch(request);
  },
};
