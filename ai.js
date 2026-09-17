// Gemini 呼び出しのクライアント側。/ai/* を叩き、返ってきた提案を正規化する。
// 提案は提案のまま返す（適用は app.js）。デモモードでは規則ベースの疑似応答を返す。
import { normalizeChanges, resolveDateWord, ROUTES, isYmd, parseQuickInput } from "./model.js";

export class AiError extends Error {}

async function post(kind, input) {
  let res;
  try {
    res = await fetch(`./ai/${kind}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
  } catch {
    throw new AiError("AI に接続できません");
  }
  let data = null;
  try { data = await res.json(); } catch { /* 下で扱う */ }
  if (!res.ok || !data) throw new AiError(data?.message || `AI ${res.status}`);
  return data;
}

// Gemini に渡すタスクの現在値（第 10 節: title, labels, task メタ, 直近コメント 3 件）
export function taskContext(task) {
  return {
    number: task.number,
    title: task.title,
    column: task.column,
    next: task.next,
    route: task.route || "",
    due: task.due,
    wake: task.wake,
    clients: task.clients,
    priority: task.priority ? "high" : "none",
    labels: task.labels,
    source: task.sources,
    notes: task.notes.slice(0, 600),
    comments: task.comments.slice(-3).map((c) => ({ at: c.created_at, by: c.user?.login || "", body: String(c.body || "").slice(0, 400) })),
  };
}

const cleanRequests = (list) =>
  (Array.isArray(list) ? list : [])
    .map((r) => ({ text: String(r?.text || "").trim().slice(0, 80), route: ROUTES.includes(r?.route) ? r.route : "claude" }))
    .filter((r) => r.text);

export class AiClient {
  constructor({ enabled, demo }) {
    this.enabled = !!enabled;
    this.demo = !!demo;
  }
  get available() { return this.enabled || this.demo; }

  async instruct(task, instruction, { today, clients }) {
    const raw = this.demo
      ? demoInstruct(task, instruction, today)
      : await post("instruct", { today, clients, task: taskContext(task), instruction });
    return {
      changes: normalizeChanges(raw.changes, task),
      agentRequests: cleanRequests(raw.agent_requests),
      note: String(raw.note || "").trim(),
    };
  }

  async interpret(text, { today, clients, selected, tasks }) {
    const raw = this.demo
      ? demoInterpret(text, selected, today)
      : await post("interpret", { today, clients, text, selected: selected ? taskContext(selected) : null, tasks: tasks.map((t) => ({ number: t.number, title: t.title, clients: t.clients })) });
    return (Array.isArray(raw.proposals) ? raw.proposals : [])
      .filter((p) => p && ["create", "change", "route"].includes(p.kind))
      .map((p) => ({
        kind: p.kind,
        summary: String(p.summary || "").trim(),
        target: Number(p.target) || (selected && p.kind !== "create" ? selected.number : 0),
        title: p.kind === "create" ? String(p.title || "").trim().slice(0, 60) : "",
        changes: Array.isArray(p.changes) ? p.changes : [],
        agentText: p.kind === "route" ? String(p.agent_text || "").trim().slice(0, 80) : "",
        route: ROUTES.includes(p.route) ? p.route : "claude",
      }))
      .slice(0, 3);
  }

  async triage(tasks, today) {
    if (this.demo || !tasks.length) return [];
    const raw = await post("triage", {
      today,
      tasks: tasks.map((t) => ({ number: t.number, title: t.title, due: t.due, priority: t.priority ? "high" : "none", next: t.next, source: t.sources[0] || "", notes: t.notes.slice(0, 300) })),
    });
    return (raw.results || []).filter((r) => r && Number(r.number) && ["must", "other"].includes(r.priority))
      .map((r) => ({ number: Number(r.number), priority: r.priority, reason: String(r.reason || "").slice(0, 40) }));
  }

  async tasks(text, today) {
    const raw = await post("tasks", { today, text });
    return (raw.tasks || [])
      .filter((t) => t && String(t.title || "").trim())
      .map((t) => ({
        title: String(t.title).trim().slice(0, 120),
        notes: String(t.notes || "").trim(),
        checklist: (Array.isArray(t.checklist) ? t.checklist : []).map((s) => String(s).trim()).filter(Boolean),
        column: ["backlog", "todo", "doing"].includes(t.column) ? t.column : "backlog",
        client: String(t.client || "").trim().toLowerCase().replace(/[^\w-]/g, ""),
        priority: t.priority === "high",
        next: t.next === "waiting" ? "waiting" : "self",
        due: isYmd(t.due) ? t.due : "",
        source: String(t.source || "").trim(),
      }));
  }
}

// ---------- デモ用の疑似応答（?demo=1。Gemini を呼ばない） ----------
function findDate(text, today) {
  for (const m of text.replace(/(来週|今週)の/g, "$1").matchAll(/(今日|明日|明後日|(?:来週|今週)?[月火水木金土日]曜日?|来週|\d{1,2}\/\d{1,2}|\d{1,2}月\d{1,2}日)/g)) {
    const d = resolveDateWord(m[1], today);
    if (d) return d;
  }
  return "";
}

function demoInstruct(task, text, today) {
  const changes = [];
  const agent_requests = [];
  const due = findDate(text, today);
  if (/再表示|後で|寝かせ/.test(text) && due) changes.push({ field: "wake", to: due });
  else if (due) changes.push({ field: "due", to: due });
  if (/返事|返信|来た|きた|もらえた/.test(text) && task.next !== "self") changes.push({ field: "next", to: "self" });
  if (/待ち/.test(text) && !/来た|きた/.test(text)) changes.push({ field: "next", to: "waiting" });
  if (/急ぎ|至急|優先/.test(text)) changes.push({ field: "priority", to: "high" });
  if (/着手|始め/.test(text)) changes.push({ field: "column", to: "doing" });
  const fwd = text.match(/([\p{Script=Han}\p{Script=Katakana}A-Za-z]{1,8}さん)に(転送|送付|共有)/u);
  if (fwd) {
    const title = /NDA/i.test(task.title + text) ? `${fwd[1]}へ NDA を${fwd[2]}する` : `${fwd[1]}へ${fwd[2]}する`;
    changes.push({ field: "title", to: title });
    agent_requests.push({ text: `${fwd[2]}メールの下書きを作る`, route: "local" });
  }
  if (/下書き|調べて|まとめて|一覧に/.test(text) && !agent_requests.length) {
    agent_requests.push({ text: text.replace(/^.*?[。、]\s*/, "").slice(0, 30), route: "claude" });
  }
  return { changes, agent_requests, note: "デモ: 規則ベースの疑似応答です" };
}

function demoInterpret(text, selected, today) {
  const due = findDate(text, today);
  if (selected && /(これ|この|選択)/.test(text)) {
    const changes = [];
    if (due) changes.push({ field: "due", to: due });
    if (/今日やる/.test(text)) changes.push({ field: "column", to: "todo" });
    if (changes.length) return { proposals: [{ kind: "change", summary: `#${selected.number} を更新する`, target: selected.number, changes }] };
  }
  const client = (text.match(/\b(DBJ|JICA)\b/i) || [])[1];
  if (selected && client && /今日やる/.test(text)) {
    return { proposals: [{ kind: "change", summary: `#${selected.number} を ${client.toUpperCase()} の今日やるにする`, target: selected.number, changes: [{ field: "client", to: client.toLowerCase() }, { field: "column", to: "todo" }] }] };
  }
  const q = parseQuickInput(text.replace(/(を|の)?(タスク(に|を)?)?(追加|作って|作成)(して)?$/, ""), today);
  return { proposals: [{ kind: "create", summary: `「${q.title}」を作る`, title: q.title, changes: due ? [{ field: "due", to: due }] : [] }] };
}
