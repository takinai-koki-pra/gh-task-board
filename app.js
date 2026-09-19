// 起動、状態、描画の振り分け、操作（楽観的更新 + Undo）、キー操作。
import { GitHubApi, DemoApi, GitHubError } from "./api.js";
import { AiClient } from "./ai.js";
import {
  toTask, VIEWS, LABEL_DEFS, labelDefFor, patchFor, applyPatch, restorePatch, newBody, setMeta, parseBody, buildBody,
  toggleChecklist, localDate, addDays, parseQuickInput, formatDate, clientName, normalizeChanges, changesToChange,
  summarizeChanges, commentKind, ROUTES, COLUMNS, inClient, inCtx,
} from "./model.js";
import { loadIcons, hydrateIcons, icon, esc, kbd } from "./ui.js";
import { renderInbox, splitInbox } from "./views/inbox.js";
import { renderList, listCount } from "./views/list.js";
import { renderBoard, attachBoardDrag } from "./views/board.js";
import { renderPanel, renderPanelEmpty, renderAskExtras, renderPopover } from "./panel.js";
import { Palette } from "./palette.js";
import { UndoStack, Toaster } from "./undo.js";
import { Intake } from "./intake.js";

const STORAGE_CONFIG = "ghtb.config.v1";
const STORAGE_CACHE = "ghtb.cache.v2";
const STORAGE_TRIAGE = "ghtb.triage.v1";
const STORAGE_UI = "ghtb.ui.v1";
const CLIENT_DOTS = [1, 2, 3, 4, 5, 6].map((i) => `var(--dot-${i})`);

// ---------- 状態 ----------
const params = new URLSearchParams(location.search);
const state = {
  api: null,
  ai: new AiClient({ enabled: false, demo: false }),
  config: null,
  demo: params.get("demo") === "1",
  local: false,
  issues: [],
  comments: new Map(), // issue 番号 → コメント[]
  fullComments: new Set(), // 全件を読んだ issue
  commentsLoading: null,
  tasks: [],
  byNumber: new Map(),
  today: localDate(),
  view: { kind: "inbox" },
  inboxTab: "must",
  selected: null,
  order: [],
  filter: "",
  pending: new Set(),
  triage: loadJson(STORAGE_TRIAGE, {}),
  draft: null, // 指示欄: { number, mode: "instruct"|"return", text, busy, error, result, off:Set, route, ready }
  newRow: false,
  edit: null, // { kind: "title"|"notes", number }
  popover: null, // { field, number }
  chord: null,
  loaded: false,
};

const $ = (s) => document.querySelector(s);
const el = {
  app: $("#app"), nav: $("#nav"), repoName: $("#repo-name"), title: $("#view-title"), tabs: $("#tabs"),
  search: $("#search"), notice: $("#notice"), view: $("#view"), status: $("#status-keys"),
  panel: $("#panel"), panelBody: $("#panel-body"), ask: $("#ask"), askIn: $("#ask-in"), askSlot: $("#ask-slot"),
  askBox: $("#ask-box"), askHint: $("#ask-hint"), popover: $("#popover"), refresh: $("#refresh-button"),
};

const undo = new UndoStack();
const toaster = new Toaster($("#toasts"), { onUndo: () => runUndo() });

function loadJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || "null") ?? fallback; } catch { return fallback; }
}
function saveJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 保存できなくても動く */ }
}

// ---------- 永続する入力部品（再描画で消さない） ----------
const askInput = document.createElement("textarea");
askInput.rows = 1;
askInput.className = "ask-input";
askInput.placeholder = "このタスクに指示…";
askInput.setAttribute("aria-label", "このタスクへの指示");
el.askSlot.appendChild(askInput);

const newRowEl = document.createElement("div");
newRowEl.className = "row row--new";
const newInput = document.createElement("input");
newInput.type = "text";
newInput.placeholder = "タスク名（例: 見積を返す 金曜 #dbj !）";
newInput.setAttribute("aria-label", "新しいタスク");
const newHint = document.createElement("div");
newHint.className = "new-hint";

// ---------- 導出 ----------
function derive() {
  state.today = localDate();
  state.tasks = state.issues.map((i) => toTask(i, state.comments.get(i.number) || []));
  state.byNumber = new Map(state.tasks.map((t) => [t.number, t]));
}
const issueOf = (n) => state.issues.find((i) => i.number === n);
const selectedTask = () => state.byNumber.get(state.selected) || null;

function clientList() {
  const set = new Set();
  for (const t of state.tasks) for (const c of t.clients) set.add(c);
  return [...set].sort();
}
function ctxList() {
  const set = new Set();
  for (const t of state.tasks) if (t.state === "open") for (const c of t.ctx) set.add(c);
  return [...set].sort();
}
function clientColor(slug) {
  const i = clientList().indexOf(slug);
  return CLIENT_DOTS[(i < 0 ? 0 : i) % CLIENT_DOTS.length];
}

function matcher() {
  const words = state.filter.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return () => true;
  return (t) => {
    const hay = `#${t.number} ${t.title} ${t.notes} ${t.clients.map(clientName).join(" ")} ${t.clients.join(" ")}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  };
}

function viewCtx() {
  return {
    tasks: state.tasks, today: state.today, selected: state.selected, pending: state.pending, triage: state.triage,
    inboxTab: state.inboxTab, filter: state.filter, match: matcher(), view: state.view,
  };
}

function viewContains(view, task) {
  const t = task;
  switch (view.kind) {
    case "inbox": return VIEWS.inbox(t, state.today);
    case "today": case "waiting": case "agent": case "later": return VIEWS[view.kind](t, state.today);
    case "client": return inClient(view.slug)(t) || (t.state === "closed" && t.clients.includes(view.slug));
    case "ctx": return inCtx(view.slug)(t);
    case "board": return true;
    default: return false;
  }
}

// ---------- 描画 ----------
function update() {
  derive();
  render();
}

function render() {
  if (!state.api) return;
  renderNav();
  const ctx = viewCtx();
  const out = state.view.kind === "inbox" ? renderInbox(ctx) : state.view.kind === "board" ? renderBoard(ctx) : renderList(ctx);
  const prevOrder = state.order;
  state.order = out.order;
  // 選択中の行が消えたら、同じ位置の行へ
  if (state.selected != null && !out.order.includes(state.selected) && !state.edit) {
    const idx = prevOrder.indexOf(state.selected);
    const next = idx >= 0 ? out.order[Math.min(idx, out.order.length - 1)] : out.order[0];
    if (next !== undefined || idx >= 0) return select(next ?? null, { scroll: true });
  }
  if (state.selected == null && out.order.length && state.loaded && !isNarrow()) return select(out.order[0]);

  el.title.textContent = out.title;
  document.title = `${out.title} — Task Board`;
  el.tabs.innerHTML = (out.tabs || []).map((t) => `<button type="button" role="tab" class="${t.on ? "on" : ""}" aria-selected="${t.on}" data-tab="${t.key}">${esc(t.label)}<span class="n">${t.n}</span></button>`).join("");

  const scroll = el.view.querySelector(".list, .board")?.scrollTop ?? 0;
  const newFocused = document.activeElement === newInput;
  el.view.innerHTML = out.html;
  if (state.newRow) {
    const host = el.view.querySelector(".list, .board");
    if (host.classList.contains("board")) el.view.insertBefore(newRowEl, host);
    else host.prepend(newRowEl);
    if (newFocused) newInput.focus();
  }
  const host = el.view.querySelector(".list, .board");
  if (host) host.scrollTop = scroll;
  renderPanelArea();
  renderStatus();
}

function renderNav() {
  const t = state.tasks;
  const today = state.today;
  const { must, other } = splitInbox({ tasks: t, today, triage: state.triage });
  const item = (kind, iconName, label, n, extra = {}) => {
    const on = state.view.kind === kind && (extra.slug === undefined || state.view.slug === extra.slug);
    return `<button type="button" class="it${on ? " on" : ""}" data-view="${kind}"${extra.slug !== undefined ? ` data-slug="${esc(extra.slug)}"` : ""}>${extra.dot ? `<span class="dot" style="--dot:${extra.dot}"></span>` : icon(iconName)}<span class="lbl">${esc(label)}</span>${n ? `<span class="n${extra.hot ? " hot" : ""}">${n}</span>` : ""}</button>`;
  };
  const clients = clientList().map((c) => ({ c, n: t.filter(inClient(c)).length })).filter((x) => x.n || (state.view.kind === "client" && state.view.slug === x.c));
  const ctxs = ctxList();
  el.nav.innerHTML = [
    item("inbox", "tray", "受信箱", must.length + other.length, { hot: must.length > 0 }),
    item("today", "sun", "今日", listCount({ kind: "today" }, t, today)),
    item("waiting", "hourglass", "相手待ち", t.filter(VIEWS.waiting).length),
    item("agent", "sparkle", "エージェント", t.filter(VIEWS.agent).length),
    item("later", "moon", "後で", t.filter((x) => VIEWS.later(x, today)).length),
    item("board", "kanban", "ボード", 0),
    clients.length ? '<div class="grp">案件</div>' : "",
    ...clients.map(({ c, n }) => item("client", "", clientName(c), n, { slug: c, dot: clientColor(c) })),
    ctxs.length ? '<div class="grp">環境</div>' : "",
    ...ctxs.map((c) => item("ctx", "hash", c, t.filter(inCtx(c)).length, { slug: c })),
  ].join("");
}

function renderPanelArea() {
  const task = selectedTask();
  el.app.classList.toggle("has-sel", !!task);
  if (!task) {
    el.panelBody.innerHTML = renderPanelEmpty({ demo: state.demo });
    el.ask.hidden = true;
    closePopover();
    return;
  }
  const pctx = {
    today: state.today, draft: state.draft, triage: state.triage, clientColor, clients: clientList(), ai: state.ai.available,
    commentsLoading: state.commentsLoading === task.number,
  };
  if (!(state.edit && state.edit.number === task.number)) {
    const keep = el.panelBody.dataset.n === String(task.number) ? el.panelBody.scrollTop : 0;
    el.panelBody.innerHTML = renderPanel(task, pctx);
    el.panelBody.dataset.n = String(task.number);
    el.panelBody.scrollTop = keep;
  }
  el.ask.hidden = task.state === "closed" && !state.draft;
  const d = state.draft?.number === task.number ? state.draft : null;
  askInput.placeholder = d?.mode === "return" ? "差し戻す内容（エージェントへの指示）…" : state.ai.available ? "このタスクに指示…" : "このタスクに指示…（AI 未設定）";
  el.askIn.classList.toggle("idle", document.activeElement !== askInput && !askInput.value);
  el.askIn.classList.toggle("ret", d?.mode === "return");
  const extras = renderAskExtras(task, pctx);
  el.askBox.innerHTML = extras.box;
  el.askHint.innerHTML = extras.hint ? `<span>${extras.hint}</span>` : "";
  if (state.popover && state.popover.number !== task.number) closePopover();
  renderStatus();
}

function renderStatus() {
  const k = (keys, label) => `<span>${keys}${esc(label)}</span>`;
  const task = selectedTask();
  const parts = [];
  const active = document.activeElement;
  if (active === askInput) {
    const d = state.draft;
    parts.push(k(kbd("Enter"), d?.result || d?.ready ? " 適用" : " 送る"), k(kbd("Shift", "Enter"), " 改行"), k(kbd("Esc"), " 戻る"));
  } else if (active === newInput) {
    parts.push(k(kbd("Enter"), " 追加して続ける"), k(kbd("Esc"), " 閉じる"), k("", "金曜 / 9/19 / 来週 → 期限、#slug → 案件、! → 優先"));
  } else {
    parts.push(k(kbd("J") + kbd("K"), " 移動"));
    if (state.view.kind === "board") parts.push(k(kbd("←") + kbd("→"), " 列を移動"));
    if (task?.reportPending) parts.push(k(kbd("Y"), " 承認"), k(kbd("R"), " 差し戻し"));
    parts.push(k(kbd("1"), " 今日"), k(kbd("2"), " 後で"), k(kbd("3"), " 相手待ち"), k(kbd("4"), " エージェント"), k(kbd("E"), " 完了"), k(kbd("I"), " 指示"));
    if (undo.size) parts.push(k(kbd("Ctrl", "Z"), " 元に戻す"));
  }
  el.status.innerHTML = parts.join("");
}

const isNarrow = () => matchMedia("(max-width: 900px)").matches;

function select(number, { scroll = true, open = false } = {}) {
  if (state.selected !== number) {
    if (state.draft && state.draft.number !== number && !state.draft.busy) { state.draft = null; askInput.value = ""; }
    state.edit = null;
    closePopover();
  }
  state.selected = number;
  if (open && isNarrow()) el.app.classList.add("panel-open");
  render();
  if (scroll && number != null) el.view.querySelector(`.row[data-n="${number}"]`)?.scrollIntoView({ block: "nearest" });
  if (number != null) ensureComments(number);
}

function setView(view, { keepSelection = false } = {}) {
  state.view = view;
  state.newRow = false;
  el.app.classList.remove("nav-open");
  saveJson(STORAGE_UI, { view: state.view, inboxTab: state.inboxTab });
  if (!keepSelection) { state.selected = null; state.order = []; }
  render();
  el.view.scrollTop = 0;
}

function openTask(number) {
  const task = state.byNumber.get(number);
  if (!task) return;
  if (!viewContains(state.view, task)) {
    if (VIEWS.inbox(task, state.today)) {
      state.view = { kind: "inbox" };
    } else if (VIEWS.today(task, state.today)) state.view = { kind: "today" };
    else state.view = { kind: "board" };
  }
  state.filter = "";
  el.search.value = "";
  select(number, { open: true });
}

function moveSelection(delta) {
  const order = state.order;
  if (!order.length) return;
  const i = order.indexOf(state.selected);
  const next = i < 0 ? order[delta > 0 ? 0 : order.length - 1] : order[Math.max(0, Math.min(order.length - 1, i + delta))];
  select(next);
}

function setNotice(text, kind = "info") {
  el.notice.hidden = !text;
  el.notice.textContent = text || "";
  el.notice.dataset.kind = kind;
}

function describeError(err) {
  if (err instanceof GitHubError) {
    if (err.status === 401) return "認証に失敗しました。トークンを確認してください。";
    if (err.status === 403) return "権限がありません（Issues: Read and write が必要です）。";
    if (err.status === 404) return "見つかりません。リポジトリ名と権限を確認してください。";
    if (err.status === 422) return `GitHub が受け付けませんでした: ${err.message}`;
    return `GitHub エラー: ${err.message}`;
  }
  if (err instanceof TypeError) return "ネットワークに接続できません。";
  return err.message || String(err);
}

function saveCache() {
  if (state.demo || !state.config) return;
  const comments = Object.fromEntries([...state.comments].filter(([n]) => state.issues.some((i) => i.number === n && i.state === "open")));
  saveJson(STORAGE_CACHE, { repo: state.config.repo, issues: state.issues, comments, at: Date.now() });
}

// ---------- データ ----------
async function refresh({ silent = false } = {}) {
  if (!state.api) return;
  el.refresh.classList.add("spin");
  try {
    const since = new Date(Date.now() - 90 * 86400000).toISOString();
    const [issues, recent] = await Promise.all([state.api.listIssues(), state.api.listRecentComments({ since })]);
    state.issues = issues;
    for (const [n, list] of recent) {
      if (state.fullComments.has(n)) {
        const byId = new Map((state.comments.get(n) || []).map((c) => [c.id, c]));
        for (const c of list) byId.set(c.id, c);
        state.comments.set(n, [...byId.values()]);
      } else state.comments.set(n, list);
    }
    state.loaded = true;
    saveCache();
    if (!silent) setNotice("");
    update();
    if (state.selected != null) ensureComments(state.selected, { force: true });
    runTriage();
  } catch (err) {
    setNotice(describeError(err), "error");
  } finally {
    el.refresh.classList.remove("spin");
  }
}

async function ensureComments(number, { force = false } = {}) {
  const issue = issueOf(number);
  if (!issue || state.demo) return;
  const have = (state.comments.get(number) || []).length;
  if (!force && state.fullComments.has(number)) return;
  if ((issue.comments || 0) <= have && (state.fullComments.has(number) || have === (issue.comments || 0))) {
    if (have === (issue.comments || 0)) state.fullComments.add(number);
    return;
  }
  state.commentsLoading = number;
  renderPanelArea();
  try {
    const list = await state.api.listComments(number);
    state.comments.set(number, list);
    state.fullComments.add(number);
  } catch { /* 履歴が読めなくても続ける */ }
  if (state.commentsLoading === number) state.commentsLoading = null;
  update();
}

let triageBusy = false;
async function runTriage() {
  if (!state.ai.enabled || triageBusy) return;
  const todo = state.tasks
    .filter((t) => VIEWS.inbox(t, state.today) && !t.reportPending && state.triage[t.number]?.at !== t.updated)
    .slice(0, 25);
  if (!todo.length) return;
  triageBusy = true;
  try {
    const results = await state.ai.triage(todo, state.today);
    for (const r of results) {
      const t = state.byNumber.get(r.number);
      if (t) state.triage[r.number] = { priority: r.priority, reason: r.reason, at: t.updated };
    }
    // 開いている Issue だけ残す
    const open = new Set(state.issues.filter((i) => i.state === "open").map((i) => i.number));
    for (const n of Object.keys(state.triage)) if (!open.has(Number(n))) delete state.triage[n];
    saveJson(STORAGE_TRIAGE, state.triage);
    update();
  } catch { /* 規則で判定したまま */ }
  triageBusy = false;
}

// 楽観的更新 + 失敗時ロールバック。成功したら true
async function mutate(number, patch, { label = "変更", toastText = "", undoable = true } = {}) {
  const idx = state.issues.findIndex((i) => i.number === number);
  if (idx < 0) return false;
  if (!Object.keys(patch).length) { if (toastText) toaster.show(toastText); return true; }
  const before = state.issues[idx];
  state.issues[idx] = applyPatch(before, patch);
  state.pending.add(number);
  update();
  try {
    const updated = await state.api.updateIssue(number, patch);
    const j = state.issues.findIndex((i) => i.number === number);
    if (j >= 0) state.issues[j] = { ...updated, comments: Math.max(updated.comments || 0, state.issues[j].comments || 0) };
    if (undoable) undo.push(label, () => restore(number, before));
    if (toastText) toaster.show(toastText, { undoable });
    return true;
  } catch (err) {
    const j = state.issues.findIndex((i) => i.number === number);
    if (j >= 0) state.issues[j] = before;
    toaster.show(describeError(err), { kind: "error" });
    return false;
  } finally {
    state.pending.delete(number);
    saveCache();
    update();
  }
}

async function restore(number, before) {
  const cur = issueOf(number);
  if (!cur) return;
  const patch = restorePatch(cur, before);
  if (Object.keys(patch).length && !(await mutate(number, patch, { undoable: false }))) throw new Error("元に戻せませんでした");
}

async function addComment(number, body) {
  try {
    const c = await state.api.createComment(number, body);
    const list = state.comments.get(number) || [];
    state.comments.set(number, [...list, c]);
    const issue = issueOf(number);
    if (issue) issue.comments = (issue.comments || 0) + 1;
    update();
    return c;
  } catch (err) {
    toaster.show(`コメントを書けませんでした: ${describeError(err)}`, { kind: "error" });
    return null;
  }
}

async function removeComment(number, c) {
  if (!c) return;
  await state.api.deleteComment(c.id);
  state.comments.set(number, (state.comments.get(number) || []).filter((x) => x.id !== c.id));
  const issue = issueOf(number);
  if (issue) issue.comments = Math.max(0, (issue.comments || 1) - 1);
  update();
}

async function runUndo() {
  try {
    const label = await undo.pop();
    if (label) toaster.show(`元に戻しました（${label}）`, { kind: "info" });
    else toaster.show("戻せる操作はありません", { kind: "info" });
  } catch (err) {
    toaster.show(describeError(err), { kind: "error" });
  }
  renderStatus();
}

async function createTask(t, { quiet = false, select: sel = true } = {}) {
  const labels = [];
  if (t.column === "todo" || t.column === "doing") labels.push(`status:${t.column}`);
  if (t.next === "waiting") labels.push("waiting");
  if (t.next === "agent") labels.push(t.route ? `agent:${t.route}` : "agent");
  if (t.priority) labels.push("priority:high");
  for (const c of t.clients || []) labels.push(`client:${c}`);
  for (const c of t.ctx || []) labels.push(`ctx:${c}`);
  const notes = [...(t.checklist || []).map((s) => `- [ ] ${s}`), (t.checklist?.length && t.notes ? "" : null), t.notes || null].filter((x) => x !== null).join("\n");
  const body = newBody({ due: t.due || "", wake: t.wake || "", source: t.source || "", notes: notes ? `${notes}\n` : "" });
  try {
    const issue = await state.api.createIssue({ title: t.title, body, labels });
    state.issues.unshift(issue);
    saveCache();
    undo.push("追加", async () => {
      const cur = issueOf(issue.number);
      if (cur && cur.state === "open") await mutate(issue.number, { state: "closed", state_reason: "not_planned" }, { undoable: false });
    });
    if (sel) state.selected = issue.number;
    update();
    if (!quiet) toaster.show(`#${issue.number} を追加しました`, { undoable: true });
    return issue;
  } catch (err) {
    toaster.show(describeError(err), { kind: "error" });
    return null;
  }
}

// ---------- 操作 ----------
const TRIAGE = {
  1: { label: "今日", change: (t) => ({ next: "self", ...(t.column === "backlog" ? { column: "todo" } : {}), ...(t.wake > state.today ? { wake: "" } : {}) }) },
  2: { label: "後で", change: () => ({ column: "backlog", wake: addDays(state.today, 7) }) },
  3: { label: "相手待ち", change: (t) => ({ next: "waiting", ...(t.column === "backlog" ? { column: "todo" } : {}) }) },
  4: { label: "エージェント", change: (t) => ({ next: "agent", route: t.route, ...(t.column === "backlog" ? { column: "todo" } : {}) }) },
};

async function triage(key) {
  const task = selectedTask();
  if (!task || task.state === "closed") return;
  if (task.reportPending) {
    if (key === "4") return startReturn();
    return approve(TRIAGE[key].change(task), TRIAGE[key].label);
  }
  const def = TRIAGE[key];
  const change = def.change(task);
  const text = key === "2" ? `#${task.number} を ${formatDate(change.wake, state.today)} まで後回しにしました` : `#${task.number} を「${def.label}」にしました`;
  await mutate(task.number, patchFor(issueOf(task.number), change), { label: def.label, toastText: text });
}

async function toggleDone(number = state.selected) {
  const task = state.byNumber.get(number);
  if (!task) return;
  const done = task.state === "closed";
  await mutate(number, patchFor(issueOf(number), { column: done ? "todo" : "done" }), {
    label: done ? "再開" : "完了",
    toastText: done ? `#${number} を未完了に戻しました` : `#${number} を完了にしました`,
  });
}

async function dropTask() {
  const task = selectedTask();
  if (!task || task.stateReason === "not_planned") return;
  await mutate(task.number, patchFor(issueOf(task.number), { column: "not_planned" }), { label: "やらない", toastText: `#${task.number} を「やらない」でクローズしました` });
}

async function moveColumn(number, col) {
  const task = state.byNumber.get(number);
  if (!task || task.column === col) return;
  const name = COLUMNS.find((c) => c.key === col)?.name || col;
  await mutate(number, patchFor(issueOf(number), { column: col }), { label: "列の移動", toastText: `#${number} を ${name} へ移動しました` });
}

async function approve(extra = {}, label = "") {
  const task = selectedTask();
  if (!task?.reportPending) return;
  const before = issueOf(task.number);
  const change = { next: "self", ...(task.column === "backlog" && !extra.wake ? { column: "todo" } : {}), ...extra };
  if (!(await mutate(task.number, patchFor(before, change), { undoable: false }))) return;
  const c = await addComment(task.number, `指示: 承認${label ? `（${label}）` : ""}`);
  undo.push("承認", async () => { await restore(task.number, before); await removeComment(task.number, c); });
  toaster.show(`#${task.number} の報告を承認しました`, { undoable: true });
}

function lastRoute(task) {
  for (const c of [...task.comments].reverse()) {
    const m = String(c.body || "").match(/（agent:(claude|codex|local)）/);
    if (m) return m[1];
  }
  return task.route || "claude";
}

function startReturn() {
  const task = selectedTask();
  if (!task) return;
  state.draft = { number: task.number, mode: "return", text: "", off: new Set(), route: lastRoute(task) };
  askInput.value = "";
  renderPanelArea();
  focusAsk();
}

function requestBody(reqs, route) {
  const texts = reqs.map((r) => r.text);
  const head = texts.length === 1 ? `指示: ${texts[0]}（agent:${route}）` : `指示: 次を頼みます（agent:${route}）\n${texts.map((t) => `- ${t}`).join("\n")}`;
  return route === "codex" ? `${head}\n\n@codex ${texts.join(" / ")}` : head;
}

// 指示（または Ctrl+K の提案）を適用する: 属性を PATCH、指示コメントを 1 行、依頼があれば agent:<route> + 依頼コメント
async function applyInstruction(number, text, changes, reqs) {
  const issue = issueOf(number);
  const task = state.byNumber.get(number);
  if (!issue || !task) return false;
  const change = changesToChange(changes);
  const route = reqs[0]?.route;
  if (reqs.length) { change.next = "agent"; change.route = route; }
  const before = issue;
  if (!(await mutate(number, patchFor(issue, change), { undoable: false }))) return false;
  const shown = reqs.length ? [...changes.filter((c) => c.field !== "next"), { field: "next", from: task.next, to: "agent" }] : changes;
  const summary = [summarizeChanges(shown, state.today), reqs.length ? `依頼（${route}）: ${reqs.map((r) => r.text).join(" / ")}` : ""].filter(Boolean).join("、");
  const log = await addComment(number, `指示: 「${text.replace(/\s+/g, " ").slice(0, 200)}」 → ${summary || "変更なし"}`);
  const req = reqs.length ? await addComment(number, requestBody(reqs, route)) : null;
  undo.push("指示", async () => {
    await restore(number, before);
    await removeComment(number, log);
    if (req) await addComment(number, `指示: 取り消し（直前の依頼「${reqs.map((r) => r.text).join(" / ")}」は不要になりました）`);
  });
  toaster.show(reqs.length ? `#${number} を更新し、「${reqs[0].text}」をエージェントに頼みました` : `#${number} を更新しました`, { undoable: true });
  return true;
}

// ---------- 指示欄 ----------
function focusAsk() {
  const task = selectedTask();
  if (!task) return;
  el.ask.hidden = false;
  if (isNarrow()) el.app.classList.add("panel-open");
  askInput.focus();
  autoGrow();
  renderPanelArea();
  renderStatus();
}

function autoGrow() {
  askInput.style.height = "auto";
  askInput.style.height = `${Math.min(askInput.scrollHeight, 160)}px`;
}

async function submitAsk() {
  const task = selectedTask();
  if (!task) return;
  const text = askInput.value.trim();
  const d = state.draft?.number === task.number ? state.draft : null;
  if (d?.busy) return;

  if (d?.mode === "return") {
    if (d.ready && text === d.text) return sendReturn();
    if (!text) return;
    state.draft = { ...d, text, ready: true };
    return renderPanelArea();
  }
  if (d?.result && text === d.text) return applyDraft();
  if (!text) return;
  if (!state.ai.available) { toaster.show("AI が使えない環境です（GEMINI_API_KEY 未設定）", { kind: "error" }); return; }
  const draft = { number: task.number, mode: "instruct", text, busy: true, off: new Set() };
  state.draft = draft;
  update();
  try {
    draft.result = await state.ai.instruct(task, text, { today: state.today, clients: clientList() });
  } catch (err) {
    draft.error = err.message || String(err);
  }
  draft.busy = false;
  if (state.draft === draft) { update(); renderStatus(); }
}

async function applyDraft() {
  const d = state.draft;
  if (!d?.result) return;
  const changes = d.result.changes.filter((c) => !d.off.has(`c:${c.field}`));
  const reqs = d.result.agentRequests.filter((_, i) => !d.off.has(`a:${i}`));
  if (!changes.length && !reqs.length) return discardDraft();
  state.draft = null;
  askInput.value = "";
  autoGrow();
  askInput.blur();
  el.view.focus({ preventScroll: true });
  await applyInstruction(d.number, d.text, changes, reqs);
}

async function sendReturn() {
  const d = state.draft;
  if (!d?.ready) return;
  const issue = issueOf(d.number);
  state.draft = null;
  askInput.value = "";
  autoGrow();
  askInput.blur();
  el.view.focus({ preventScroll: true });
  const before = issue;
  if (!(await mutate(d.number, patchFor(issue, { next: "agent", route: d.route }), { undoable: false }))) return;
  await addComment(d.number, requestBody([{ text: d.text }], d.route));
  undo.push("差し戻し", async () => {
    await restore(d.number, before);
    await addComment(d.number, `指示: 取り消し（直前の差し戻し「${d.text}」は不要になりました）`);
  });
  toaster.show(`#${d.number} を差し戻しました（${d.route}）`, { undoable: true });
}

function discardDraft() {
  state.draft = null;
  askInput.value = "";
  autoGrow();
  askInput.blur();
  el.view.focus();
  update();
}

askInput.addEventListener("keydown", (e) => {
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitAsk(); return; }
  if (e.key === "Escape") {
    e.preventDefault();
    if (state.draft) discardDraft();
    else { askInput.blur(); el.view.focus(); }
  }
});
askInput.addEventListener("input", () => { autoGrow(); renderStatus(); });
askInput.addEventListener("focus", () => { el.askIn.classList.remove("idle"); renderStatus(); });
askInput.addEventListener("blur", () => { el.askIn.classList.toggle("idle", !askInput.value); renderStatus(); });

el.ask.addEventListener("click", (e) => {
  const b = e.target.closest("[data-act]");
  if (!b) { if (e.target.closest("#ask-in")) askInput.focus(); return; }
  const d = state.draft;
  switch (b.dataset.act) {
    case "apply": d?.mode === "return" ? sendReturn() : applyDraft(); break;
    case "discard": discardDraft(); break;
    case "chip": {
      const key = b.dataset.key;
      d.off.has(key) ? d.off.delete(key) : d.off.add(key);
      renderPanelArea();
      break;
    }
    case "drop-agents":
      d.result.agentRequests.forEach((_, i) => d.off.add(`a:${i}`));
      renderPanelArea();
      break;
    case "cycle-route":
      d.route = ROUTES[(ROUTES.indexOf(d.route) + 1) % ROUTES.length];
      renderPanelArea();
      break;
  }
});

// ---------- パネル（プロパティ・編集） ----------
el.panelBody.addEventListener("click", (e) => {
  const task = selectedTask();
  if (!task) return;
  const prop = e.target.closest("[data-prop]");
  if (prop) {
    if (prop.dataset.prop === "priority") {
      mutate(task.number, patchFor(issueOf(task.number), { priority: !task.priority }), { label: "優先", toastText: task.priority ? "優先を外しました" : "優先にしました" });
      return;
    }
    return openPopover(prop.dataset.prop, prop);
  }
  const check = e.target.closest("[data-check]");
  if (check) {
    const issue = issueOf(task.number);
    const parsed = parseBody(issue.body);
    const rest = toggleChecklist(parsed.rest, Number(check.dataset.check));
    const body = parsed.meta ? buildBody(parsed.meta, rest) : rest;
    mutate(task.number, { body }, { label: "チェック" });
    return;
  }
  const actEl = e.target.closest("[data-act]");
  const act = actEl?.dataset.act;
  if (act === "triage") triage(actEl.dataset.key);
  if (act === "done") toggleDone(task.number);
  if (act === "approve") approve();
  if (act === "return") startReturn();
  if (act === "edit-title") startEdit("title");
  if (act === "edit-notes") startEdit("notes");
});

function startEdit(kind) {
  const task = selectedTask();
  if (!task) return;
  state.edit = { kind, number: task.number };
  if (kind === "title") {
    const h = el.panelBody.querySelector(".p-title");
    const input = Object.assign(document.createElement("input"), { type: "text", value: task.title, className: "p-title-input" });
    h.replaceWith(input);
    input.focus();
    input.select();
    const finish = (save) => {
      if (!state.edit) return;
      state.edit = null;
      const v = input.value.trim();
      if (save && v && v !== task.title) mutate(task.number, { title: v }, { label: "タイトル", toastText: "タイトルを変えました" });
      else render();
    };
    input.addEventListener("keydown", (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      if (e.key === "Escape") { e.preventDefault(); finish(false); }
    });
    input.addEventListener("blur", () => finish(true));
  } else {
    const box = el.panelBody.querySelector(".notes");
    const ta = Object.assign(document.createElement("textarea"), { value: task.notes, className: "notes-input", rows: 8 });
    const bar = document.createElement("div");
    bar.className = "notes-bar";
    bar.innerHTML = `<button type="button" class="btn pri2" data-save>保存 ${kbd("Ctrl", "Enter")}</button><button type="button" class="btn ghost" data-cancel>やめる ${kbd("Esc")}</button>`;
    box.replaceChildren(ta, bar);
    ta.focus();
    const finish = (save) => {
      if (!state.edit) return;
      state.edit = null;
      if (save && ta.value !== task.notes) {
        const issue = issueOf(task.number);
        const parsed = parseBody(issue.body);
        const body = parsed.meta ? buildBody(parsed.meta, ta.value) : ta.value;
        mutate(task.number, { body }, { label: "メモ", toastText: "メモを保存しました" });
      } else render();
    };
    ta.addEventListener("keydown", (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === "Enter" && e.ctrlKey) { e.preventDefault(); finish(true); }
      if (e.key === "Escape") { e.preventDefault(); finish(false); }
    });
    bar.querySelector("[data-save]").addEventListener("click", () => finish(true));
    bar.querySelector("[data-cancel]").addEventListener("click", () => finish(false));
  }
}

function openPopover(field, anchor) {
  const task = selectedTask();
  if (!task) return;
  if (state.popover?.field === field) return closePopover();
  state.popover = { field, number: task.number };
  el.popover.innerHTML = renderPopover(field, task, { today: state.today, clients: clientList(), clientColor });
  el.popover.hidden = false;
  const r = anchor.getBoundingClientRect();
  const w = el.popover.offsetWidth, h = el.popover.offsetHeight;
  el.popover.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
  el.popover.style.top = `${r.bottom + 4 + h > innerHeight ? Math.max(8, r.top - h - 4) : r.bottom + 4}px`;
  (el.popover.querySelector(".opt.on") || el.popover.querySelector(".opt"))?.focus();
}

function closePopover() {
  state.popover = null;
  el.popover.hidden = true;
}

function applyPopover(value) {
  const p = state.popover;
  const task = p && state.byNumber.get(p.number);
  if (!task) return;
  const issue = issueOf(task.number);
  let change;
  let text;
  switch (p.field) {
    case "column":
      closePopover();
      if (value === "not_planned") dropTask();
      else moveColumn(task.number, value);
      return;
    case "next":
      change = value.startsWith("agent:") ? { next: "agent", route: value.slice(6) } : { next: value };
      text = "次に動く主体を変えました";
      break;
    case "due":
    case "wake":
      change = { [p.field]: value };
      text = value ? `${p.field === "due" ? "期限" : "再表示"}を ${formatDate(value, state.today)} にしました` : `${p.field === "due" ? "期限" : "再表示"}を外しました`;
      break;
    case "client": {
      const has = task.clients.includes(value);
      change = { clients: !value ? [] : has ? task.clients.filter((c) => c !== value) : [...task.clients, value] };
      text = !value ? "案件を外しました" : has ? `${clientName(value)} を外しました` : `${clientName(value)} にしました`;
      break;
    }
  }
  closePopover();
  mutate(task.number, patchFor(issue, change), { label: text, toastText: text });
}

el.popover.addEventListener("click", (e) => {
  const opt = e.target.closest(".opt[data-value]");
  if (opt) applyPopover(opt.dataset.value);
});
el.popover.addEventListener("change", (e) => {
  if (e.target.matches("[data-date]") && e.target.value) applyPopover(e.target.value);
});
el.popover.addEventListener("keydown", (e) => {
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === "Escape") { e.preventDefault(); closePopover(); return; }
  if (e.target.matches("[data-new-client]") && e.key === "Enter") {
    e.preventDefault();
    const slug = e.target.value.trim().toLowerCase().replace(/[^\w-]/g, "");
    if (slug) applyPopover(slug);
    return;
  }
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    const opts = [...el.popover.querySelectorAll(".opt[data-value], input")];
    const i = opts.indexOf(document.activeElement);
    opts[(i + (e.key === "ArrowDown" ? 1 : -1) + opts.length) % opts.length]?.focus();
    e.preventDefault();
  }
});
document.addEventListener("mousedown", (e) => {
  if (state.popover && !e.target.closest("#popover") && !e.target.closest("[data-prop]")) closePopover();
});

// ---------- 一覧（クリック・新規行） ----------
let suppressClick = false;
el.view.addEventListener("click", (e) => {
  if (suppressClick) return;
  if (!typing(e.target)) el.view.focus({ preventScroll: true });
  const row = e.target.closest(".row[data-n]");
  if (!row) return;
  const n = Number(row.dataset.n);
  if (e.target.closest("[data-act=toggle-done]")) { toggleDone(n); return; }
  select(n, { scroll: false, open: true });
});
el.view.addEventListener("dblclick", (e) => {
  const row = e.target.closest(".row[data-n]");
  if (row && !isNarrow()) focusAsk();
});
el.tabs.addEventListener("click", (e) => {
  const b = e.target.closest("[data-tab]");
  if (b) { state.inboxTab = b.dataset.tab; saveJson(STORAGE_UI, { view: state.view, inboxTab: state.inboxTab }); state.selected = null; render(); }
});
el.nav.addEventListener("click", (e) => {
  const b = e.target.closest("[data-view]");
  if (!b) return;
  setView(b.dataset.slug !== undefined ? { kind: b.dataset.view, slug: b.dataset.slug } : { kind: b.dataset.view });
});
attachBoardDrag(el.view, {
  onDrop: (n, col) => moveColumn(n, col),
  onClickSuppressed: () => { suppressClick = true; setTimeout(() => (suppressClick = false), 0); },
});

newRowEl.innerHTML = icon("circle");
const newMain = document.createElement("div");
newMain.className = "row-main";
newMain.append(newInput, newHint);
newRowEl.append(newMain);
newRowEl.insertAdjacentHTML("beforeend", `<div class="row-props new-keys">${kbd("Enter")} 追加 ${kbd("Esc")}</div>`);

function newRowDefaults() {
  const v = state.view;
  const today = state.today;
  switch (v.kind) {
    case "inbox": return { column: "backlog", where: "受信箱" };
    case "today": return { column: "todo", where: "今日" };
    case "waiting": return { column: "todo", next: "waiting", where: "相手待ち" };
    case "agent": return { column: "todo", next: "agent", where: "エージェント" };
    case "later": return { column: "backlog", wake: addDays(today, 7), where: `後で（${formatDate(addDays(today, 7), today)}）` };
    case "client": return { column: "todo", clients: [v.slug], where: clientName(v.slug) };
    case "ctx": return { column: "todo", ctx: [v.slug], where: `#${v.slug}` };
    default: return { column: "todo", where: "Todo" };
  }
}

function updateNewHint() {
  const q = parseQuickInput(newInput.value, state.today);
  const def = newRowDefaults();
  const bits = [`<span>${icon("tray", "s")}${esc(def.where)}</span>`];
  if (q.due) bits.push(`<span><b>期限 ${esc(formatDate(q.due, state.today))}</b></span>`);
  for (const c of q.clients) bits.push(`<span><b>案件 ${esc(clientName(c))}</b></span>`);
  if (q.priority) bits.push(`<span class="pri">! 優先</span>`);
  if (newInput.value.trim() && !q.title) bits.push('<span class="over">タイトルが空です</span>');
  newHint.innerHTML = bits.join("");
}

function openNewRow() {
  if (!state.api) return;
  state.newRow = true;
  render();
  newInput.focus();
  updateNewHint();
  renderStatus();
}
function closeNewRow() {
  state.newRow = false;
  newInput.value = "";
  newRowEl.remove();
  el.view.focus();
  renderStatus();
}

newInput.addEventListener("input", updateNewHint);
newInput.addEventListener("focus", renderStatus);
newInput.addEventListener("keydown", async (e) => {
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === "Escape") { e.preventDefault(); closeNewRow(); return; }
  if (e.key !== "Enter") return;
  e.preventDefault();
  const q = parseQuickInput(newInput.value, state.today);
  if (!q.title) return;
  const def = newRowDefaults();
  newInput.value = "";
  updateNewHint();
  await createTask({ ...def, title: q.title, due: q.due, priority: q.priority, clients: [...new Set([...(def.clients || []), ...q.clients])] }, { select: true });
  if (state.newRow) newInput.focus();
});
newInput.addEventListener("paste", (e) => {
  const text = e.clipboardData?.getData("text") || "";
  if (/\n/.test(text.trim())) { e.preventDefault(); closeNewRow(); intake.open(text); }
});

// ---------- まとめて追加 ----------
const intake = new Intake($("#intake-dialog"), {
  ai: () => state.ai.enabled,
  today: () => state.today,
  parse: (text) => state.ai.tasks(text, state.today),
  create: async (items, progress) => {
    let ok = 0;
    for (const t of items) {
      const created = await createTask({ ...t, clients: t.client ? [t.client] : [] }, { quiet: true, select: false });
      if (created) ok++;
      progress(ok);
    }
    toaster.show(`${ok} 件を追加しました`);
    return ok;
  },
});

// ---------- Ctrl+K ----------
const palette = new Palette($("#palette"), {
  ai: () => state.ai.available,
  today: () => state.today,
  selected: selectedTask,
  tasks: () => state.tasks,
  openTask: (n) => openTask(n),
  onClose: () => renderStatus(),
  commands: () => {
    const cmds = [];
    const go = (label, view, keys, iconName, keywords = "") => cmds.push({ group: "移動", icon: iconName, label, keys, keywords, run: () => setView(view) });
    go("受信箱", { kind: "inbox" }, kbd("G") + kbd("I"), "tray", "inbox");
    go("今日", { kind: "today" }, kbd("G") + kbd("T"), "sun", "today");
    go("相手待ち", { kind: "waiting" }, kbd("G") + kbd("W"), "hourglass", "waiting");
    go("エージェント", { kind: "agent" }, kbd("G") + kbd("A"), "sparkle", "agent");
    go("後で", { kind: "later" }, kbd("G") + kbd("L"), "moon", "later");
    go("ボード", { kind: "board" }, kbd("B"), "kanban", "board kanban");
    for (const c of clientList()) go(`案件: ${clientName(c)}`, { kind: "client", slug: c }, "", "folder-simple", c);
    const t = selectedTask();
    if (t) {
      const on = (label, run, keys, iconName, keywords = "") => cmds.push({ group: `#${t.number} に対して`, icon: iconName, label, keys, keywords, run });
      if (t.reportPending) on("報告を承認", () => approve(), kbd("Y"), "check-circle", "approve");
      if (t.reportPending) on("差し戻す", () => startReturn(), kbd("R"), "arrow-counter-clockwise", "return");
      on(t.state === "closed" ? "未完了に戻す" : "完了にする", () => toggleDone(t.number), kbd("E"), "check-circle", "done complete");
      on("今日やる", () => triage("1"), kbd("1"), "sun", "today");
      on("後で（+7 日）", () => triage("2"), kbd("2"), "moon", "later");
      on("相手待ちにする", () => triage("3"), kbd("3"), "hourglass", "waiting");
      on("エージェントに渡す", () => triage("4"), kbd("4"), "sparkle", "agent");
      on("指示を書く", () => setTimeout(focusAsk), kbd("I"), "chat-circle", "instruct");
      on(t.priority ? "優先を外す" : "優先にする", () => mutate(t.number, patchFor(issueOf(t.number), { priority: !t.priority }), { label: "優先", toastText: "優先を変えました" }), "", "flag-banner", "priority");
      on("やらないでクローズ", () => dropTask(), kbd("Del"), "x", "drop not planned");
      on("GitHub で開く", () => window.open(t.url, "_blank", "noopener"), "", "arrow-square-out", "github");
    }
    cmds.push({ group: "作成", icon: "plus", label: "新しいタスク", keys: kbd("N"), keywords: "new add", run: () => setTimeout(openNewRow) });
    cmds.push({ group: "作成", icon: "clipboard-text", label: "まとめて追加（貼り付け）", keywords: "paste intake", run: () => setTimeout(() => intake.open()) });
    cmds.push({ group: "その他", icon: "arrow-counter-clockwise", label: "元に戻す", keys: kbd("Ctrl", "Z"), keywords: "undo", run: () => runUndo() });
    cmds.push({ group: "その他", icon: "arrow-clockwise", label: "再読み込み", keywords: "refresh reload", run: () => refresh() });
    cmds.push({ group: "その他", icon: "gear", label: "設定", keywords: "settings", run: () => setTimeout(openSettings) });
    return cmds;
  },
  interpret: (text) => state.ai.interpret(text, { today: state.today, clients: clientList(), selected: selectedTask(), tasks: state.tasks.filter((t) => t.state === "open").slice(0, 80) }),
  execute: (p) => executeProposal(p),
});

async function executeProposal(p) {
  const text = palette.input.value.trim();
  if (p.kind === "create") {
    const c = changesToChange(normalizeChanges(p.changes, toTask({ number: 0, title: "", body: "", state: "open", labels: [] })));
    const issue = await createTask({ title: p.title || p.summary, column: c.column || "backlog", next: c.next, due: c.due, wake: c.wake, priority: c.priority, clients: c.clients || [] });
    if (issue) await addComment(issue.number, `指示: 「${text}」 → 起票`);
    if (issue) openTask(issue.number);
    return;
  }
  const task = state.byNumber.get(p.target);
  if (!task) { toaster.show(`#${p.target} が見つかりません`, { kind: "error" }); return; }
  const changes = normalizeChanges(p.changes, task);
  const reqs = p.kind === "route" ? [{ text: p.agentText || p.summary, route: p.route }] : [];
  if (!changes.length && !reqs.length) { toaster.show("変える所がありませんでした", { kind: "info" }); return; }
  openTask(task.number);
  await applyInstruction(task.number, text, changes, reqs);
}

// ---------- キー操作 ----------
const typing = (t) => t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
const CHORDS = { i: { kind: "inbox" }, t: { kind: "today" }, w: { kind: "waiting" }, a: { kind: "agent" }, l: { kind: "later" }, b: { kind: "board" } };

document.addEventListener("keydown", (e) => {
  if (e.isComposing || e.keyCode === 229) return; // IME 変換中は無視
  const k = e.key;
  if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === "k") {
    e.preventDefault();
    palette.isOpen ? palette.close() : palette.open();
    return;
  }
  if (palette.isOpen || document.querySelector("dialog[open]")) return;
  if (state.popover) { // ポップオーバー側で扱う
    if (k === "Escape" && !el.popover.contains(e.target)) { e.preventDefault(); closePopover(); }
    return;
  }
  if (typing(e.target)) {
    if (e.target === el.search) {
      if (k === "Escape") { e.preventDefault(); el.search.value = ""; state.filter = ""; el.search.blur(); render(); }
      if (k === "Enter" || k === "ArrowDown") { e.preventDefault(); el.search.blur(); if (state.order[0]) select(state.order[0]); }
    }
    return;
  }
  if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === "z") { e.preventDefault(); runUndo(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  if (state.chord === "g") {
    state.chord = null;
    const v = CHORDS[k.toLowerCase()];
    if (v) { e.preventDefault(); setView(v); }
    return;
  }
  const inPanel = el.panel.contains(e.target) && e.target !== el.panel;
  switch (k) {
    case "j": case "ArrowDown": e.preventDefault(); moveSelection(1); break;
    case "k": case "ArrowUp": e.preventDefault(); moveSelection(-1); break;
    case "ArrowLeft": case "ArrowRight":
      if (state.view.kind === "board" && state.selected != null) {
        e.preventDefault();
        const t = selectedTask();
        const i = COLUMNS.findIndex((c) => c.key === t.column);
        const next = COLUMNS[i + (k === "ArrowRight" ? 1 : -1)];
        if (next) moveColumn(t.number, next.key);
      }
      break;
    case "Enter":
      if (inPanel) return;
      e.preventDefault();
      if (state.selected != null) { if (isNarrow()) el.app.classList.add("panel-open"); el.panel.focus(); }
      break;
    case "1": case "2": case "3": case "4": e.preventDefault(); triage(k); break;
    case "e": case "E": e.preventDefault(); toggleDone(); break;
    case "Delete": e.preventDefault(); dropTask(); break;
    case "i": case "I": e.preventDefault(); focusAsk(); break;
    case "y": case "Y": if (selectedTask()?.reportPending) { e.preventDefault(); approve(); } break;
    case "r": case "R": if (selectedTask()?.reportPending) { e.preventDefault(); startReturn(); } break;
    case "/": e.preventDefault(); el.search.focus(); el.search.select(); break;
    case "b": case "B": e.preventDefault(); setView({ kind: "board" }, { keepSelection: true }); break;
    case "g": case "G": state.chord = "g"; setTimeout(() => { state.chord = null; }, 1200); break;
    case "n": case "N": e.preventDefault(); openNewRow(); break;
    case "Escape":
      if (el.app.classList.contains("panel-open")) { el.app.classList.remove("panel-open"); break; }
      if (inPanel || document.activeElement === el.panel) { el.view.focus(); break; }
      if (state.newRow) { closeNewRow(); break; }
      if (state.filter) { el.search.value = ""; state.filter = ""; render(); break; }
      break;
  }
});

el.search.addEventListener("input", () => { state.filter = el.search.value; render(); });
$("#new-button").addEventListener("click", () => openNewRow());
$("#intake-button").addEventListener("click", () => state.api ? intake.open() : openSettings());
$("#palette-button").addEventListener("click", () => palette.open());
el.refresh.addEventListener("click", () => refresh());
$("#menu-button").addEventListener("click", () => el.app.classList.toggle("nav-open"));
$("#panel-close").addEventListener("click", () => el.app.classList.remove("panel-open"));
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && state.api && !state.demo) refresh({ silent: true }); });
window.addEventListener("online", () => state.api && !state.demo && refresh({ silent: true }));
setInterval(() => { if (document.visibilityState === "visible" && state.api && !state.demo && !state.pending.size) refresh({ silent: true }); }, 120000);
setInterval(() => { if (localDate() !== state.today) update(); }, 60000); // 日付が変わったら
matchMedia("(max-width: 900px)").addEventListener("change", () => { el.app.classList.remove("panel-open", "nav-open"); render(); });

// ---------- 設定 ----------
const settings = {
  dialog: $("#settings-dialog"), repo: $("#cfg-repo"), token: $("#cfg-token"), msg: $("#cfg-message"), save: $("#cfg-save"),
};
function openSettings() {
  settings.repo.value = state.config?.repo || "";
  settings.token.value = state.config?.token || "";
  settings.msg.hidden = true;
  $("#cfg-token-field").hidden = state.local;
  $("#cfg-token-hint").hidden = state.local;
  settings.dialog.showModal();
}
function settingsMsg(text, kind) { settings.msg.hidden = false; settings.msg.dataset.kind = kind; settings.msg.textContent = text; }
$("#settings-button").addEventListener("click", openSettings);
$("#repo-button").addEventListener("click", openSettings);
$("#cfg-cancel").addEventListener("click", () => settings.dialog.close());
settings.dialog.addEventListener("click", (e) => { if (e.target === settings.dialog) settings.dialog.close(); });
settings.save.addEventListener("click", async () => {
  if (state.demo) { settings.dialog.close(); return; }
  const repo = settings.repo.value.trim().replace(/^https:\/\/github\.com\//, "").replace(/\/+$/, "");
  const token = settings.token.value.trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return settingsMsg("リポジトリは owner/repo の形式で入力してください。", "error");
  if (!token && !state.local) return settingsMsg("トークンを入力してください。", "error");
  if (state.local && repo !== state.config?.repo) return settingsMsg("プロキシ経由ではリポジトリはサーバー側（serve.py の引数 / TASKS_REPO）で決まります。", "error");
  settings.save.disabled = true;
  settingsMsg("接続を確認しています…", "info");
  const config = state.local ? { repo, base: "./gh" } : { repo, token };
  const api = new GitHubApi(config);
  try {
    const info = await api.getRepo();
    api.defFor = labelDefFor;
    const created = await api.ensureLabels(LABEL_DEFS.map((d) => d.name));
    settingsMsg(`接続しました: ${info.full_name}${created.length ? `（ラベル ${created.length} 個を作成）` : ""}`, "ok");
    connect({ ...config, repo: info.full_name }, api);
    if (!state.local) saveJson(STORAGE_CONFIG, state.config);
    setTimeout(() => settings.dialog.close(), 600);
    await refresh();
  } catch (err) {
    settingsMsg(describeError(err), "error");
  } finally {
    settings.save.disabled = false;
  }
});

// ---------- 起動 ----------
function connect(config, api = new GitHubApi(config)) {
  state.config = config;
  state.api = api;
  state.api.defFor = labelDefFor;
  el.repoName.textContent = config.repo;
  el.app.classList.remove("unconnected");
}

async function probeProxy() {
  try {
    const res = await fetch("./__config", { cache: "no-store" });
    if (!res.ok || !(res.headers.get("Content-Type") || "").includes("json")) return null;
    return await res.json();
  } catch { return null; }
}

function renderUnconnected() {
  el.app.classList.add("unconnected");
  el.title.textContent = "接続";
  el.view.innerHTML = `<div class="empty">${icon("kanban")}<p><b>GitHub リポジトリに接続</b></p><p class="dim">タスクは GitHub Issues として保存されます。リポジトリとトークンを設定してください。<br><a href="?demo=1">デモを見る</a></p><button type="button" class="btn pri2" id="empty-setup">設定を開く</button></div>`;
  el.panelBody.innerHTML = "";
  $("#empty-setup").addEventListener("click", openSettings);
}

function restoreUi() {
  const ui = loadJson(STORAGE_UI, null);
  if (ui?.view?.kind) state.view = ui.view;
  if (ui?.inboxTab) state.inboxTab = ui.inboxTab;
  const v = params.get("view");
  if (v && ["inbox", "today", "waiting", "agent", "later", "board"].includes(v)) state.view = { kind: v };
}

async function boot() {
  // アイコンは待たずに描画し、揃ったら描き直す
  loadIcons().then(() => { hydrateIcons(); if (state.api) render(); else if (el.app.classList.contains("unconnected")) renderUnconnected(); });
  restoreUi();
  if (state.demo) {
    const raw = await (await fetch("demo-data.json", { cache: "no-store" })).text();
    const now = Date.now();
    const data = JSON.parse(raw
      .replace(/@D([+-]\d+)/g, (_, n) => addDays(state.today, Number(n)))
      .replace(/@T-(\d+)/g, (_, n) => new Date(now - Number(n) * 60000).toISOString()));
    state.triage = data.triage || {};
    state.api = new DemoApi(data);
    state.config = { repo: "demo/tasks" };
    state.ai = new AiClient({ enabled: false, demo: true });
    el.repoName.textContent = "デモ（保存されません）";
    setNotice("デモモード: 操作はこの画面の中だけに反映され、GitHub には書き込みません。AI は規則ベースの疑似応答です。");
    await refresh({ silent: true });
    return;
  }
  const proxy = await probeProxy();
  if (proxy) {
    state.local = true;
    state.ai = new AiClient({ enabled: proxy.ai });
    connect({ repo: proxy.repo, base: "./gh" });
    loadCached(proxy.repo);
    await refresh({ silent: true });
    state.api.ensureLabels(LABEL_DEFS.map((d) => d.name)).catch((err) => setNotice(`ラベルを作れませんでした: ${describeError(err)}`, "error"));
    return;
  }
  const cfg = loadJson(STORAGE_CONFIG, null);
  if (!cfg) { renderUnconnected(); return; }
  connect(cfg);
  loadCached(cfg.repo);
  await refresh();
}

function loadCached(repo) {
  const c = loadJson(STORAGE_CACHE, null);
  if (!c || c.repo !== repo) return;
  state.issues = c.issues || [];
  state.comments = new Map(Object.entries(c.comments || {}).map(([n, l]) => [Number(n), l]));
  state.loaded = true;
  update();
}

boot();

// Service Worker は公開サイトでのみ使う（ローカル開発ではキャッシュが邪魔になる）
if ("serviceWorker" in navigator) {
  const isLocal = ["localhost", "127.0.0.1"].includes(location.hostname);
  if (isLocal || state.demo) navigator.serviceWorker.getRegistrations?.().then((rs) => rs.forEach((r) => r.unregister()));
  else {
    // デプロイ後に古いアプリが残らないよう、SW が入れ替わったら 1 回だけ再読み込みする（初回インストール時は除く）
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!hadController || reloaded) return;
      reloaded = true;
      location.reload();
    });
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").then((reg) => {
        // タブを開きっぱなしでも、戻ってきたときに更新を確認する
        document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") reg.update().catch(() => {}); });
      }).catch(() => {});
    });
  }
}
