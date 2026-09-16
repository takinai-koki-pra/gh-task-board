import { GitHubApi, DemoApi, GitHubError } from "./api.js";

// ---------- 列の定義 ----------
// Backlog: open かつ status ラベル無し / Todo, Doing: open + ラベル / Done: closed
const COLUMNS = [
  { key: "backlog", name: "Backlog", label: null, closed: false, color: "var(--col-backlog)" },
  { key: "todo", name: "Todo", label: "status:todo", closed: false, color: "var(--col-todo)" },
  { key: "doing", name: "Doing", label: "status:doing", closed: false, color: "var(--col-doing)" },
  { key: "done", name: "Done", label: null, closed: true, color: "var(--col-done)" },
];
const STATUS_LABEL_DEFS = [
  { name: "status:todo", color: "b0722e", description: "Task Board: Todo 列" },
  { name: "status:doing", color: "2f5d50", description: "Task Board: Doing 列" },
];
const STATUS_LABELS = new Set(STATUS_LABEL_DEFS.map((d) => d.name));
const DONE_LIMIT = 50;

const STORAGE_CONFIG = "ghtb.config.v1";
const STORAGE_CACHE = "ghtb.cache.v1";

// ---------- 状態 ----------
const state = {
  api: null,
  config: null,
  issues: [],
  filter: "",
  pending: new Set(),
  demo: new URLSearchParams(location.search).get("demo") === "1",
};

const $ = (sel) => document.querySelector(sel);
const el = {
  board: $("#board"),
  status: $("#status"),
  repoName: $("#repo-name"),
  search: $("#search"),
  refresh: $("#refresh-button"),
  quickAdd: $("#quick-add"),
  quickTitle: $("#quick-title"),
  quickColumn: $("#quick-column"),
  settingsDialog: $("#settings-dialog"),
  cfgRepo: $("#cfg-repo"),
  cfgToken: $("#cfg-token"),
  cfgMessage: $("#cfg-message"),
  taskDialog: $("#task-dialog"),
  taskNumber: $("#task-number"),
  taskLink: $("#task-link"),
  taskTitle: $("#task-title"),
  taskBody: $("#task-body"),
  taskColumns: $("#task-columns"),
  taskLabels: $("#task-labels"),
  taskMessage: $("#task-message"),
  cardTemplate: $("#card-template"),
};

// ---------- ユーティリティ ----------
function columnOf(issue) {
  if (issue.state === "closed") return "done";
  const names = issue.labels.map((l) => (typeof l === "string" ? l : l.name));
  if (names.includes("status:doing")) return "doing";
  if (names.includes("status:todo")) return "todo";
  return "backlog";
}

function labelNames(issue) {
  return issue.labels.map((l) => (typeof l === "string" ? l : l.name));
}

function patchForColumn(issue, colKey) {
  const col = COLUMNS.find((c) => c.key === colKey);
  const keep = labelNames(issue).filter((n) => !STATUS_LABELS.has(n));
  const labels = col.label ? [...keep, col.label] : keep;
  return { labels, state: col.closed ? "closed" : "open" };
}

function applyPatchLocally(issue, patch) {
  const existing = new Map(issue.labels.map((l) => [l.name, l]));
  return {
    ...issue,
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.body !== undefined ? { body: patch.body } : {}),
    ...(patch.state !== undefined ? { state: patch.state } : {}),
    ...(patch.labels !== undefined
      ? { labels: patch.labels.map((n) => existing.get(n) || { name: n, color: "888888" }) }
      : {}),
    updated_at: new Date().toISOString(),
  };
}

function setStatus(text, kind = "info") {
  if (!text) { el.status.hidden = true; return; }
  el.status.hidden = false;
  el.status.textContent = text;
  el.status.dataset.kind = kind;
}

let toastTimer = null;
function toast(text, kind = "info") {
  document.querySelectorAll(".toast").forEach((t) => t.remove());
  const t = document.createElement("div");
  t.className = "toast" + (kind === "error" ? " toast--error" : "");
  t.textContent = text;
  document.body.appendChild(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), kind === "error" ? 5000 : 2200);
}

function describeError(err) {
  if (err instanceof GitHubError) {
    if (err.status === 401) return "認証に失敗しました。トークンを確認してください。";
    if (err.status === 403) return "権限がありません。トークンの Issues 権限（Read and write）を確認してください。";
    if (err.status === 404) return "リポジトリが見つかりません。owner/repo とトークンの対象リポジトリを確認してください。";
    return `GitHub エラー: ${err.message}`;
  }
  if (err instanceof TypeError) return "ネットワークに接続できません。";
  return err.message || String(err);
}

function loadConfig() {
  try { return JSON.parse(localStorage.getItem(STORAGE_CONFIG) || "null"); } catch { return null; }
}
function saveConfig(cfg) {
  try { localStorage.setItem(STORAGE_CONFIG, JSON.stringify(cfg)); } catch {}
}
function loadCache(repo) {
  try {
    const c = JSON.parse(localStorage.getItem(STORAGE_CACHE) || "null");
    return c && c.repo === repo ? c.issues : null;
  } catch { return null; }
}
function saveCache(repo, issues) {
  try { localStorage.setItem(STORAGE_CACHE, JSON.stringify({ repo, issues, at: Date.now() })); } catch {}
}

// ---------- 描画 ----------
function render() {
  const q = state.filter.trim().toLowerCase();
  const grouped = Object.fromEntries(COLUMNS.map((c) => [c.key, []]));
  for (const issue of state.issues) {
    if (q && !`${issue.title} ${issue.body || ""} #${issue.number}`.toLowerCase().includes(q)) continue;
    grouped[columnOf(issue)].push(issue);
  }
  for (const key of Object.keys(grouped)) {
    grouped[key].sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
  }

  const frag = document.createDocumentFragment();
  for (const col of COLUMNS) {
    const column = document.createElement("section");
    column.className = "column";
    column.dataset.column = col.key;
    column.style.setProperty("--col-color", col.color);

    const items = grouped[col.key];
    const shown = col.key === "done" ? items.slice(0, DONE_LIMIT) : items;

    column.innerHTML = `
      <header class="column__head">
        <span class="column__dot" aria-hidden="true"></span>
        <span class="column__name">${col.name}</span>
        <span class="column__count">${items.length}</span>
        ${col.closed ? "" : `<button class="column__add" type="button" title="${col.name} に追加" aria-label="${col.name} に追加">+</button>`}
      </header>
      <div class="column__list" role="list"></div>`;
    const list = column.querySelector(".column__list");
    if (shown.length === 0) {
      const empty = document.createElement("div");
      empty.className = "column__empty";
      empty.textContent = q ? "該当なし" : col.key === "done" ? "完了したタスクはここに移動します" : "ここにドロップ";
      list.appendChild(empty);
    }
    for (const issue of shown) list.appendChild(renderCard(issue, col));
    if (items.length > shown.length) {
      const more = document.createElement("div");
      more.className = "column__empty";
      more.textContent = `他 ${items.length - shown.length} 件は GitHub で確認できます`;
      list.appendChild(more);
    }
    column.querySelector(".column__add")?.addEventListener("click", () => {
      el.quickColumn.value = col.key;
      el.quickTitle.focus();
    });
    frag.appendChild(column);
  }
  el.board.replaceChildren(frag);
}

function renderCard(issue, col) {
  const node = el.cardTemplate.content.firstElementChild.cloneNode(true);
  node.dataset.number = String(issue.number);
  node.style.setProperty("--col-color", col.color);
  if (col.key === "done") node.classList.add("card--done");
  if (state.pending.has(issue.number)) node.classList.add("is-pending");
  node.querySelector(".card__title").textContent = issue.title;
  node.querySelector(".card__number").textContent = `#${issue.number}`;
  const labels = node.querySelector(".card__labels");
  for (const l of issue.labels) {
    if (STATUS_LABELS.has(l.name)) continue;
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = l.name;
    chip.style.setProperty("--chip", `#${l.color || "888888"}`);
    labels.appendChild(chip);
  }
  node.setAttribute("aria-label", `#${issue.number} ${issue.title}`);
  return node;
}

function renderEmptyState() {
  el.board.innerHTML = `
    <div class="empty-state">
      <h2>GitHub リポジトリに接続</h2>
      <p>タスクは GitHub Issues として保存され、ラベルで列を管理します。<br>まずリポジトリとトークンを設定してください。</p>
      <button class="btn btn--primary" type="button" id="empty-setup">設定を開く</button>
    </div>`;
  $("#empty-setup").addEventListener("click", openSettings);
}

// ---------- データ操作 ----------
async function refresh({ silent = false } = {}) {
  if (!state.api) return;
  el.refresh.classList.add("is-spinning");
  try {
    const issues = await state.api.listIssues();
    state.issues = issues;
    if (!state.demo) saveCache(state.config.repo, issues);
    render();
    if (!silent) setStatus("");
  } catch (err) {
    setStatus(describeError(err), "error");
  } finally {
    el.refresh.classList.remove("is-spinning");
  }
}

async function mutate(number, patch, { successText } = {}) {
  const idx = state.issues.findIndex((i) => i.number === number);
  if (idx < 0) return;
  const before = state.issues[idx];
  state.issues[idx] = applyPatchLocally(before, patch);
  state.pending.add(number);
  render();
  try {
    const updated = await state.api.updateIssue(number, patch);
    const j = state.issues.findIndex((i) => i.number === number);
    if (j >= 0) state.issues[j] = updated;
    if (successText) toast(successText);
  } catch (err) {
    const j = state.issues.findIndex((i) => i.number === number);
    if (j >= 0) state.issues[j] = before;
    toast(describeError(err), "error");
  } finally {
    state.pending.delete(number);
    if (!state.demo) saveCache(state.config.repo, state.issues);
    render();
  }
}

function moveIssue(number, colKey) {
  const issue = state.issues.find((i) => i.number === number);
  if (!issue || columnOf(issue) === colKey) return;
  const col = COLUMNS.find((c) => c.key === colKey);
  mutate(number, patchForColumn(issue, colKey), { successText: `${col.name} へ移動しました` });
}

async function createIssue(title, colKey) {
  const col = COLUMNS.find((c) => c.key === colKey) || COLUMNS[1];
  const labels = col.label ? [col.label] : [];
  const btn = el.quickAdd.querySelector("button[type=submit]");
  btn.disabled = true;
  try {
    const issue = await state.api.createIssue({ title, labels });
    state.issues.unshift(issue);
    if (!state.demo) saveCache(state.config.repo, state.issues);
    render();
    toast(`#${issue.number} を追加しました`);
    return true;
  } catch (err) {
    toast(describeError(err), "error");
    return false;
  } finally {
    btn.disabled = false;
  }
}

// ---------- ドラッグ & ドロップ（Pointer Events、iOS Safari 対応） ----------
const drag = { card: null, ghost: null, active: false, startX: 0, startY: 0, timer: null, offX: 0, offY: 0, suppressClick: false };

function dragStart(card, x, y) {
  drag.active = true;
  card.classList.add("is-dragging");
  const rect = card.getBoundingClientRect();
  drag.offX = x - rect.left;
  drag.offY = y - rect.top;
  const ghost = card.cloneNode(true);
  ghost.classList.remove("is-dragging");
  ghost.classList.add("drag-ghost");
  ghost.style.width = `${rect.width}px`;
  document.body.appendChild(ghost);
  drag.ghost = ghost;
  dragMove(x, y);
  navigator.vibrate?.(10);
}

function dragMove(x, y) {
  drag.ghost.style.left = `${x - drag.offX}px`;
  drag.ghost.style.top = `${y - drag.offY}px`;
  const over = document.elementFromPoint(x, y)?.closest(".column");
  document.querySelectorAll(".column.is-over").forEach((c) => c !== over && c.classList.remove("is-over"));
  over?.classList.add("is-over");
  // 端に近づいたら横スクロール
  const boardRect = el.board.getBoundingClientRect();
  if (x < boardRect.left + 36) el.board.scrollLeft -= 10;
  else if (x > boardRect.right - 36) el.board.scrollLeft += 10;
}

function dragEnd(x, y, { cancelled = false } = {}) {
  clearTimeout(drag.timer);
  if (!drag.active) { drag.card = null; return; }
  const over = cancelled ? null : document.elementFromPoint(x, y)?.closest(".column");
  document.querySelectorAll(".column.is-over").forEach((c) => c.classList.remove("is-over"));
  drag.ghost?.remove();
  drag.card?.classList.remove("is-dragging");
  const number = Number(drag.card?.dataset.number);
  drag.active = false;
  drag.ghost = null;
  drag.card = null;
  drag.suppressClick = true;
  setTimeout(() => (drag.suppressClick = false), 0);
  if (over && number) moveIssue(number, over.dataset.column);
}

el.board.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  const card = e.target.closest(".card");
  if (!card) return;
  drag.card = card;
  drag.startX = e.clientX;
  drag.startY = e.clientY;
  if (e.pointerType === "touch") {
    // 長押しでドラッグ開始（それまでは縦スクロールを優先）
    drag.timer = setTimeout(() => dragStart(card, drag.startX, drag.startY), 220);
  }
});
document.addEventListener("pointermove", (e) => {
  if (!drag.card) return;
  if (!drag.active) {
    const dx = e.clientX - drag.startX, dy = e.clientY - drag.startY;
    if (e.pointerType === "touch") {
      if (Math.hypot(dx, dy) > 8) { clearTimeout(drag.timer); drag.card = null; } // スクロール優先
      return;
    }
    if (Math.hypot(dx, dy) > 6) dragStart(drag.card, e.clientX, e.clientY);
    return;
  }
  drag.startX = e.clientX; drag.startY = e.clientY;
  dragMove(e.clientX, e.clientY);
});
document.addEventListener("pointerup", (e) => dragEnd(e.clientX, e.clientY));
document.addEventListener("pointercancel", (e) => dragEnd(e.clientX, e.clientY, { cancelled: true }));
document.addEventListener("touchmove", (e) => { if (drag.active) e.preventDefault(); }, { passive: false });

// カードのクリック / Enter で詳細
el.board.addEventListener("click", (e) => {
  if (drag.suppressClick) return;
  const card = e.target.closest(".card");
  if (card) openTask(Number(card.dataset.number));
});
el.board.addEventListener("keydown", (e) => {
  const card = e.target.closest(".card");
  if (!card) return;
  const number = Number(card.dataset.number);
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openTask(number); }
  // ← → で列移動
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    const issue = state.issues.find((i) => i.number === number);
    const idx = COLUMNS.findIndex((c) => c.key === columnOf(issue));
    const next = COLUMNS[idx + (e.key === "ArrowRight" ? 1 : -1)];
    if (next) { e.preventDefault(); moveIssue(number, next.key); }
  }
});

// ---------- タスク詳細ダイアログ ----------
let editing = null;
function openTask(number) {
  const issue = state.issues.find((i) => i.number === number);
  if (!issue) return;
  editing = { number, column: columnOf(issue) };
  el.taskNumber.textContent = `#${issue.number}`;
  el.taskLink.href = issue.html_url;
  el.taskLink.hidden = state.demo;
  el.taskTitle.value = issue.title;
  el.taskBody.value = issue.body || "";
  el.taskMessage.hidden = true;
  el.taskColumns.replaceChildren(
    ...COLUMNS.map((c) => {
      const b = document.createElement("button");
      b.type = "button";
      b.role = "radio";
      b.textContent = c.name;
      b.setAttribute("aria-checked", String(c.key === editing.column));
      b.addEventListener("click", () => {
        editing.column = c.key;
        el.taskColumns.querySelectorAll("button").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
      });
      return b;
    })
  );
  const others = issue.labels.filter((l) => !STATUS_LABELS.has(l.name));
  el.taskLabels.replaceChildren(
    ...(others.length
      ? others.map((l) => {
          const chip = document.createElement("span");
          chip.className = "chip";
          chip.textContent = l.name;
          chip.style.setProperty("--chip", `#${l.color || "888888"}`);
          return chip;
        })
      : [Object.assign(document.createElement("span"), { className: "chip--empty", textContent: "ラベルは GitHub 側で付けられます" })])
  );
  el.taskDialog.showModal();
}

$("#task-cancel").addEventListener("click", () => el.taskDialog.close());
$("#task-save").addEventListener("click", async () => {
  if (!editing) return;
  const issue = state.issues.find((i) => i.number === editing.number);
  const title = el.taskTitle.value.trim();
  if (!title) { el.taskTitle.focus(); return; }
  const patch = {};
  if (title !== issue.title) patch.title = title;
  if (el.taskBody.value !== (issue.body || "")) patch.body = el.taskBody.value;
  if (editing.column !== columnOf(issue)) Object.assign(patch, patchForColumn(issue, editing.column));
  el.taskDialog.close();
  if (Object.keys(patch).length) await mutate(editing.number, patch, { successText: "保存しました" });
  editing = null;
});
el.taskDialog.addEventListener("click", (e) => { if (e.target === el.taskDialog) el.taskDialog.close(); });

// ---------- 設定ダイアログ ----------
function openSettings() {
  el.cfgRepo.value = state.config?.repo || "";
  el.cfgToken.value = state.config?.token || "";
  el.cfgMessage.hidden = true;
  el.settingsDialog.showModal();
}
$("#settings-button").addEventListener("click", openSettings);
$("#repo-button").addEventListener("click", openSettings);
$("#cfg-cancel").addEventListener("click", () => el.settingsDialog.close());
el.settingsDialog.addEventListener("click", (e) => { if (e.target === el.settingsDialog) el.settingsDialog.close(); });
$("#cfg-save").addEventListener("click", async () => {
  const repo = el.cfgRepo.value.trim().replace(/^https:\/\/github\.com\//, "").replace(/\/+$/, "");
  const token = el.cfgToken.value.trim();
  const msg = el.cfgMessage;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) { msg.hidden = false; msg.dataset.kind = "error"; msg.textContent = "リポジトリは owner/repo の形式で入力してください。"; return; }
  if (!token) { msg.hidden = false; msg.dataset.kind = "error"; msg.textContent = "トークンを入力してください。"; return; }
  const btn = $("#cfg-save");
  btn.disabled = true;
  msg.hidden = false; msg.dataset.kind = "info"; msg.textContent = "接続を確認しています…";
  const api = new GitHubApi({ token, repo });
  try {
    const info = await api.getRepo();
    const created = await api.ensureLabels(STATUS_LABEL_DEFS);
    msg.dataset.kind = "ok";
    msg.textContent = `接続しました: ${info.full_name}` + (created.length ? `（ラベル ${created.join(", ")} を作成）` : "");
    connect({ repo: info.full_name, token });
    saveConfig(state.config);
    setTimeout(() => el.settingsDialog.close(), 600);
    await refresh();
  } catch (err) {
    msg.dataset.kind = "error";
    msg.textContent = describeError(err);
  } finally {
    btn.disabled = false;
  }
});

// ---------- クイック追加 / 検索 / 再読み込み ----------
el.quickColumn.replaceChildren(
  ...COLUMNS.filter((c) => !c.closed).map((c) => Object.assign(document.createElement("option"), { value: c.key, textContent: c.name }))
);
el.quickColumn.value = "todo";
el.quickAdd.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!state.api) { openSettings(); return; }
  const title = el.quickTitle.value.trim();
  if (!title) return;
  if (await createIssue(title, el.quickColumn.value)) el.quickTitle.value = "";
});
el.search.addEventListener("input", () => { state.filter = el.search.value; if (state.api) render(); });
el.refresh.addEventListener("click", () => refresh());
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && state.api) refresh({ silent: true }); });
window.addEventListener("online", () => state.api && refresh({ silent: true }));

// ---------- 起動 ----------
function connect(config) {
  state.config = config;
  state.api = new GitHubApi(config);
  el.repoName.textContent = config.repo;
}

async function boot() {
  if (state.demo) {
    const res = await fetch("demo-data.json");
    state.api = new DemoApi(await res.json());
    state.config = { repo: "demo/tasks" };
    el.repoName.textContent = "デモ（保存されません）";
    setStatus("デモモード: 操作はこの画面内だけに反映され、GitHub には書き込みません。");
    await refresh({ silent: true });
    return;
  }
  const cfg = loadConfig();
  if (!cfg) { renderEmptyState(); return; }
  connect(cfg);
  const cached = loadCache(cfg.repo);
  if (cached) { state.issues = cached; render(); }
  await refresh();
}

boot();

if ("serviceWorker" in navigator && !state.demo) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
