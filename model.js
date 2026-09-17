// Issue ⇔ タスクの変換。DOM に依存しない純関数だけを置く（node --test で検証する）。
// 正本は docs/data-model.md。節番号はそこに対応する。

// ---------- ラベル（第 4 節） ----------
export const STATUS_LABELS = { todo: "status:todo", doing: "status:doing" };
export const WAITING = "waiting";
export const AGENT = "agent";
export const ROUTES = ["claude", "codex", "local"];
export const AGENT_LABELS = [AGENT, ...ROUTES.map((r) => `agent:${r}`)];
export const PRIORITY_HIGH = "priority:high";

export const LABEL_DEFS = [
  { name: "status:todo", color: "2563eb", description: "列: Todo" },
  { name: "status:doing", color: "d97706", description: "列: Doing" },
  { name: PRIORITY_HIGH, color: "dc2626", description: "優先" },
  { name: WAITING, color: "9ca3af", description: "次に動く: 相手待ち" },
  { name: AGENT, color: "7c3aed", description: "次に動く: エージェント（振り分け未定）" },
  ...ROUTES.map((r) => ({ name: `agent:${r}`, color: "7c3aed", description: `次に動く: エージェント（${r}）` })),
];

export function labelDefFor(name) {
  const known = LABEL_DEFS.find((d) => d.name === name);
  if (known) return known;
  if (name.startsWith("client:")) return { name, color: "16a34a", description: "案件" };
  if (name.startsWith("ctx:")) return { name, color: "6b7280", description: "文脈" };
  return null;
}

// 案件の表示名。無いものは slug をそのまま（英字 4 文字以下は大文字）。
export const CLIENT_NAMES = { dbj: "DBJ", shinetsu: "信越", jica: "JICA", personal: "個人・環境" };
export function clientName(slug) {
  if (CLIENT_NAMES[slug]) return CLIENT_NAMES[slug];
  return /^[a-z0-9]{1,4}$/.test(slug) ? slug.toUpperCase() : slug;
}

export const labelNames = (issue) => (issue.labels || []).map((l) => (typeof l === "string" ? l : l.name));

// ---------- 列（第 3 節） ----------
export const COLUMNS = [
  { key: "backlog", name: "Backlog" },
  { key: "todo", name: "Todo" },
  { key: "doing", name: "Doing" },
  { key: "done", name: "Done" },
];

export function columnOf(issue) {
  if (issue.state === "closed") return "done";
  const names = labelNames(issue);
  if (names.includes(STATUS_LABELS.doing)) return "doing";
  if (names.includes(STATUS_LABELS.todo)) return "todo";
  return "backlog";
}

// ---------- 本文の task ブロック（第 5 節） ----------
const BLOCK_RE = /^```task\n([\s\S]*?)\n?```[ \t]*(?:\n|$)/;
// `https://…` を key と誤読しないよう、コロン直後の // は除外する
const KEY_RE = /^([A-Za-z_][\w-]*):(?!\/\/)[ \t]*(.*)$/;
export const META_KEYS = ["due", "wake", "source"];

export function parseBody(body) {
  const text = String(body || "").replace(/\r\n?/g, "\n");
  const m = text.match(BLOCK_RE);
  if (!m) return { meta: null, rest: text };
  const meta = [];
  for (const line of m[1].split("\n")) {
    const km = line.match(KEY_RE);
    if (km) meta.push([km[1], km[2].trim()]);
    else if (meta.length && line.trim()) {
      const last = meta[meta.length - 1];
      last[1] = last[1] ? `${last[1]}\n${line.trim()}` : line.trim();
    }
  }
  return { meta, rest: text.slice(m[0].length) };
}

export function getMeta(parsed, key) {
  const hit = parsed.meta?.find(([k]) => k === key);
  return hit ? hit[1] : "";
}

export function buildBody(meta, rest) {
  const lines = [];
  for (const [k, v] of meta) {
    const [first, ...more] = String(v || "").split("\n");
    lines.push(first ? `${k}: ${first}` : `${k}:`);
    lines.push(...more);
  }
  const tail = rest ? (rest.startsWith("\n") ? rest : `${rest}`) : "";
  return "```task\n" + lines.join("\n") + "\n```\n" + tail;
}

// updates: { due?, wake?, source? } 値 "" は空にする。未知のキーと順序は保持する。
export function setMeta(body, updates) {
  const parsed = parseBody(body);
  const meta = parsed.meta ? parsed.meta.map(([k, v]) => [k, v]) : META_KEYS.map((k) => [k, ""]);
  for (const [k, v] of Object.entries(updates)) {
    if (v === undefined) continue;
    const hit = meta.find(([mk]) => mk === k);
    if (hit) hit[1] = v ?? "";
    else meta.push([k, v ?? ""]);
  }
  return buildBody(meta, parsed.rest);
}

export function newBody({ due = "", wake = "", source = "", notes = "" } = {}) {
  return buildBody([["due", due], ["wake", wake], ["source", source]], notes);
}

export function checklist(text) {
  const done = (String(text || "").match(/^\s*[-*] \[[xX]\]/gm) || []).length;
  const open = (String(text || "").match(/^\s*[-*] \[ \]/gm) || []).length;
  return { done, total: done + open };
}

// n 番目（0 始まり）のチェックボックスを反転した本文を返す
export function toggleChecklist(body, index) {
  let i = -1;
  return String(body || "").replace(/^(\s*[-*] \[)([ xX])(\])/gm, (all, a, mark, b) => {
    i++;
    if (i !== index) return all;
    return a + (mark === " " ? "x" : " ") + b;
  });
}

// ---------- コメント（第 7.2 節） ----------
export const commentKind = (c) => {
  const s = String(c?.body || "").trimStart();
  if (s.startsWith("報告:")) return "report";
  if (s.startsWith("着手:")) return "start";
  if (s.startsWith("指示:")) return "instruct";
  return "other";
};
export const commentText = (c) => String(c?.body || "").trimStart().replace(/^(報告|着手|指示):\s*/, "");

// ---------- 日付 ----------
const pad = (n) => String(n).padStart(2, "0");
export function localDate(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
const toDate = (ymd) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d);
};
export function addDays(ymd, n) {
  const d = toDate(ymd);
  d.setDate(d.getDate() + n);
  return localDate(d);
}
export const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || "")) && localDate(toDate(s)) === s;
const WEEK = "日月火水木金土";
export const weekday = (ymd) => WEEK[toDate(ymd).getDay()];

export function formatMd(ymd) {
  if (!isYmd(ymd)) return "";
  const [, m, d] = ymd.split("-").map(Number);
  return `${m}/${d} ${weekday(ymd)}`;
}

export function formatDate(ymd, today) {
  if (!isYmd(ymd)) return "";
  if (ymd === today) return "今日";
  if (ymd === addDays(today, 1)) return "明日";
  return formatMd(ymd);
}

// 「今日」「明日」「明後日」「金曜」「来週」「来週金曜」「9/19」「9月19日」「+3」
export function resolveDateWord(word, today) {
  const w = String(word || "").trim();
  if (!w) return null;
  if (w === "今日") return today;
  if (w === "明日") return addDays(today, 1);
  if (w === "明後日") return addDays(today, 2);
  const plus = w.match(/^\+(\d{1,3})日?$/);
  if (plus) return addDays(today, Number(plus[1]));
  const dow = today && toDate(today).getDay();
  const wd = w.match(/^(来週|今週)?([月火水木金土日])曜?(?:日)?$/);
  if (wd) {
    const target = WEEK.indexOf(wd[2]);
    if (wd[1] === "来週") {
      const nextMonday = addDays(today, ((8 - dow) % 7) || 7);
      return addDays(nextMonday, (target + 6) % 7);
    }
    return addDays(today, (target - dow + 7) % 7);
  }
  if (w === "来週") return addDays(today, ((8 - dow) % 7) || 7);
  const md = w.match(/^(\d{1,2})[/月](\d{1,2})日?$/);
  if (md) {
    const [y] = today.split("-").map(Number);
    const m = Number(md[1]), d = Number(md[2]);
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    let ymd = `${y}-${pad(m)}-${pad(d)}`;
    if (ymd < addDays(today, -60)) ymd = `${y + 1}-${pad(m)}-${pad(d)}`; // 2 か月以上前なら来年
    return isYmd(ymd) ? ymd : null;
  }
  return null;
}

// 入力行の解釈（Gemini は使わない）。例: 「見積を返す 金曜 #dbj !」
const DATE_TOKEN = /(?:^|\s)(今日|明日|明後日|(?:来週|今週)?[月火水木金土日]曜日?|来週|\d{1,2}\/\d{1,2}|\d{1,2}月\d{1,2}日|\+\d{1,3}日?)(?:まで|までに)?(?=\s|$)/g;
export function parseQuickInput(text, today) {
  let rest = ` ${String(text || "")} `;
  let due = "";
  const clients = [];
  let priority = false;
  rest = rest.replace(/(?:^|\s)#([\w-]+)(?=\s|$)/g, (_, slug) => { clients.push(slug.toLowerCase()); return " "; });
  rest = rest.replace(/(?:^|\s)[!！](?=\s|$)/g, () => { priority = true; return " "; });
  rest = rest.replace(/^\s*[!！]|[!！]\s*$/g, () => { priority = true; return " "; });
  rest = rest.replace(DATE_TOKEN, (all, word) => {
    const d = resolveDateWord(word, today);
    if (!d || due) return all;
    due = d;
    return " ";
  });
  return { title: rest.replace(/\s+/g, " ").trim(), due, clients, priority };
}

// Ctrl+K: 文なら AI、単語ならコマンド検索（第 10 節）
export function isSentence(text) {
  const s = String(text || "").trim();
  if (/(て|で|して|たい|ください|までに)$/.test(s) && s.length >= 4) return true;
  return s.length >= 8 && /[をにへでがはとも]|まで|から/.test(s);
}

// ---------- タスク ----------
export function toTask(issue, comments = []) {
  const names = labelNames(issue);
  const parsed = parseBody(issue.body);
  const route = ROUTES.find((r) => names.includes(`agent:${r}`)) || null;
  const next = names.includes(WAITING) ? "waiting" : route || names.includes(AGENT) ? "agent" : "self";
  const sorted = [...comments].sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  const latest = sorted[sorted.length - 1] || null;
  const lastReport = [...sorted].reverse().find((c) => commentKind(c) === "report") || null;
  const lastStart = [...sorted].reverse().find((c) => commentKind(c) === "start") || null;
  return {
    number: issue.number,
    title: issue.title,
    state: issue.state,
    stateReason: issue.state_reason || null,
    column: columnOf(issue),
    labels: names,
    clients: names.filter((n) => n.startsWith("client:")).map((n) => n.slice(7)),
    ctx: names.filter((n) => n.startsWith("ctx:")).map((n) => n.slice(4)),
    priority: names.includes(PRIORITY_HIGH),
    next,
    route,
    due: isYmd(getMeta(parsed, "due")) ? getMeta(parsed, "due") : "",
    wake: isYmd(getMeta(parsed, "wake")) ? getMeta(parsed, "wake") : "",
    sources: getMeta(parsed, "source").split("\n").map((s) => s.trim()).filter(Boolean),
    notes: parsed.rest,
    checklist: checklist(parsed.rest),
    comments: sorted,
    latest,
    reportPending: !!latest && commentKind(latest) === "report" && issue.state === "open",
    lastReport,
    sessionUrl: lastStart ? (commentText(lastStart).match(/https?:\/\/\S+/) || [null])[0] : null,
    url: issue.html_url,
    created: issue.created_at,
    updated: issue.updated_at,
  };
}

export function sourceKind(task) {
  if (task.reportPending) return "agent";
  const s = task.sources[0] || "";
  if (/slack\.com/.test(s)) return "slack";
  if (/outlook|office\.com|mail|^message:/i.test(s)) return "mail";
  return "paste";
}

// ---------- 派生ビュー（第 6 節） ----------
const wakeOk = (t, today) => !t.wake || t.wake <= today;
export const VIEWS = {
  inbox: (t) => t.state === "open" && ((t.column === "backlog" && !t.wake) || t.reportPending),
  today: (t, today) =>
    t.state === "open" && wakeOk(t, today) && t.next === "self" &&
    (t.column === "todo" || t.column === "doing" || (t.due && t.due <= today) || t.priority),
  waiting: (t) => t.state === "open" && t.next === "waiting",
  agent: (t) => t.state === "open" && t.next === "agent",
  later: (t, today) => t.state === "open" && !!t.wake && t.wake > today,
  overdue: (t, today) => t.state === "open" && !!t.due && t.due < today,
};
export const inClient = (slug) => (t) => t.state === "open" && t.clients.includes(slug);
export const inCtx = (slug) => (t) => t.state === "open" && t.ctx.includes(slug);

// 受信箱の「対応必須」: AI の判定があればそれ、無ければ規則で決める
export function mustHandle(task, today, verdict) {
  if (task.reportPending) return true;
  if (verdict === "must") return true;
  if (verdict === "other") return false;
  return task.priority || (!!task.due && task.due <= addDays(today, 2));
}

// 一覧の並び: 期限切れ → 優先 → 期限の近い順 → 更新の新しい順
export function compareTasks(today) {
  return (a, b) => {
    const ao = a.due && a.due < today ? 0 : 1, bo = b.due && b.due < today ? 0 : 1;
    if (ao !== bo) return ao - bo;
    if (a.priority !== b.priority) return a.priority ? -1 : 1;
    if (a.column === "doing" && b.column !== "doing") return -1;
    if (b.column === "doing" && a.column !== "doing") return 1;
    if ((a.due || "9") !== (b.due || "9")) return (a.due || "9") < (b.due || "9") ? -1 : 1;
    return a.updated < b.updated ? 1 : -1;
  };
}

// ---------- 変更 → PATCH ----------
// change: { column, next, route, due, wake, source, title, clients, priority }
// next: "self" | "waiting" | "agent"。route: "claude" | "codex" | "local" | null
export function patchFor(issue, change) {
  const patch = {};
  let labels = labelNames(issue);
  const before = labels.join("\n");
  if (change.title !== undefined && change.title.trim() && change.title !== issue.title) patch.title = change.title.trim();

  if (change.column !== undefined) {
    labels = labels.filter((n) => n !== STATUS_LABELS.todo && n !== STATUS_LABELS.doing);
    if (change.column === "done" || change.column === "not_planned") {
      if (issue.state !== "closed" || issue.state_reason !== (change.column === "done" ? "completed" : "not_planned")) {
        patch.state = "closed";
        patch.state_reason = change.column === "done" ? "completed" : "not_planned";
      }
    } else {
      if (STATUS_LABELS[change.column]) labels.push(STATUS_LABELS[change.column]);
      if (issue.state === "closed") { patch.state = "open"; patch.state_reason = "reopened"; }
    }
  }
  if (change.next !== undefined) {
    labels = labels.filter((n) => n !== WAITING && !AGENT_LABELS.includes(n));
    if (change.next === "waiting") labels.push(WAITING);
    if (change.next === "agent") labels.push(change.route && ROUTES.includes(change.route) ? `agent:${change.route}` : AGENT);
  }
  if (change.priority !== undefined) {
    labels = labels.filter((n) => n !== PRIORITY_HIGH);
    if (change.priority) labels.push(PRIORITY_HIGH);
  }
  if (change.clients !== undefined) {
    labels = labels.filter((n) => !n.startsWith("client:"));
    for (const c of change.clients) if (c) labels.push(`client:${c}`);
  }
  if (labels.join("\n") !== before) patch.labels = [...new Set(labels)];

  const meta = {};
  for (const k of META_KEYS) if (change[k] !== undefined) meta[k] = change[k];
  if (Object.keys(meta).length) {
    const cur = parseBody(issue.body);
    const differs = Object.entries(meta).some(([k, v]) => getMeta(cur, k) !== v);
    if (differs) patch.body = setMeta(issue.body, meta);
  }
  if (change.body !== undefined && change.body !== issue.body) patch.body = change.body;
  return patch;
}

// Undo 用: 変更前の状態に戻す PATCH
export function snapshot(issue) {
  const s = { title: issue.title, body: issue.body || "", state: issue.state, labels: labelNames(issue) };
  s.state_reason = issue.state === "closed" ? issue.state_reason || "completed" : "reopened";
  return s;
}

// 今の Issue を before の状態に戻すための最小の PATCH
export function restorePatch(current, before) {
  const snap = snapshot(before);
  const patch = {};
  if (current.title !== snap.title) patch.title = snap.title;
  if ((current.body || "") !== snap.body) patch.body = snap.body;
  const cur = labelNames(current);
  if ([...cur].sort().join("\n") !== [...snap.labels].sort().join("\n")) patch.labels = snap.labels;
  if (current.state !== snap.state || (snap.state === "closed" && (current.state_reason || "completed") !== snap.state_reason)) {
    patch.state = snap.state;
    patch.state_reason = snap.state_reason;
  }
  return patch;
}

// PATCH をローカルの Issue に当てる（楽観的更新）
export function applyPatch(issue, patch) {
  const existing = new Map((issue.labels || []).map((l) => (typeof l === "string" ? [l, { name: l }] : [l.name, l])));
  const out = { ...issue, updated_at: new Date().toISOString() };
  for (const k of ["title", "body", "state"]) if (patch[k] !== undefined) out[k] = patch[k];
  if (patch.state_reason !== undefined) out.state_reason = patch.state === "open" ? null : patch.state_reason;
  if (patch.labels) out.labels = patch.labels.map((n) => existing.get(n) || { name: n, color: labelDefFor(n)?.color || "888888" });
  return out;
}

// ---------- AI の変更提案（/ai/instruct の changes[]） ----------
export const CHANGE_FIELDS = ["next", "due", "wake", "title", "client", "priority", "column"];
const NEXT_WORDS = { self: "self", 自分: "self", waiting: "waiting", 相手待ち: "waiting", agent: "agent", エージェント: "agent" };

export function normalizeChanges(raw, task) {
  const out = [];
  for (const c of Array.isArray(raw) ? raw : []) {
    if (!c || !CHANGE_FIELDS.includes(c.field)) continue;
    let to = String(c.to ?? "").trim();
    if (c.field === "next") { to = NEXT_WORDS[to] || ""; if (!to || to === task.next) continue; }
    if (c.field === "due" || c.field === "wake") { if (to && !isYmd(to)) continue; if (to === task[c.field]) continue; }
    if (c.field === "title") { if (!to || to === task.title) continue; to = to.slice(0, 120); }
    if (c.field === "client") { to = to.toLowerCase().replace(/^client:/, ""); if (task.clients.length === 1 && task.clients[0] === to) continue; }
    if (c.field === "priority") { to = /^(high|true|1|yes)$/i.test(to) ? "high" : "none"; if ((to === "high") === task.priority) continue; }
    if (c.field === "column") { if (!["backlog", "todo", "doing", "done"].includes(to) || to === task.column) continue; }
    out.push({ field: c.field, from: fieldValue(task, c.field), to });
  }
  // 同じフィールドは最後のものだけ
  return [...new Map(out.map((c) => [c.field, c])).values()];
}

export function fieldValue(task, field) {
  if (field === "client") return task.clients.join(",");
  if (field === "priority") return task.priority ? "high" : "none";
  return task[field] ?? "";
}

export function changesToChange(changes) {
  const change = {};
  for (const c of changes) {
    if (c.field === "client") change.clients = c.to ? [c.to] : [];
    else if (c.field === "priority") change.priority = c.to === "high";
    else change[c.field] = c.to;
  }
  return change;
}

const NEXT_NAMES = { self: "自分", waiting: "相手待ち", agent: "エージェント" };
const FIELD_NAMES = { next: "次に動く", due: "期限", wake: "再表示", title: "タイトル", client: "案件", priority: "優先", column: "列" };
export function describeChange(c, today) {
  const v = (x) => {
    if (c.field === "next") return NEXT_NAMES[x] || x;
    if (c.field === "due" || c.field === "wake") return x ? formatDate(x, today) : "なし";
    if (c.field === "client") return x ? x.split(",").map(clientName).join("・") : "なし";
    if (c.field === "priority") return x === "high" ? "あり" : "なし";
    if (c.field === "column") return COLUMNS.find((col) => col.key === x)?.name || x;
    return x || "なし";
  };
  return { name: FIELD_NAMES[c.field], from: v(c.from), to: v(c.to) };
}

export function summarizeChanges(changes, today) {
  return changes.map((c) => { const d = describeChange(c, today); return `${d.name}: ${d.to}`; }).join("、");
}

export function nextName(task) {
  if (task.next === "agent") return task.route ? `エージェント（${task.route}）` : "エージェント";
  return NEXT_NAMES[task.next];
}
