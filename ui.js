// 描画の共通部品: アイコン、エスケープ、簡易 Markdown、行（.row）。DOM 状態は持たない。
import { clientName, formatDate, sourceKind } from "./model.js";

// ---------- アイコン（Phosphor Light を icons/phosphor/ に同梱） ----------
export const ICONS = [
  "tray", "sun", "hourglass", "sparkle", "moon", "kanban", "magnifying-glass", "gear", "circle", "check-circle",
  "slack-logo", "clipboard-text", "envelope-simple", "calendar-blank", "check-square", "chat-circle",
  "arrow-counter-clockwise", "arrow-clockwise", "plus", "x", "arrow-square-out", "user", "flag-banner",
  "folder-simple", "hash", "warning-circle", "play-circle", "paper-plane-tilt", "command", "stack",
  "circle-half", "list-plus", "robot", "caret-right",
];
const svgCache = new Map();

export async function loadIcons() {
  await Promise.all(ICONS.map(async (name) => {
    try {
      const res = await fetch(`icons/phosphor/${name}.svg`);
      if (res.ok) svgCache.set(name, (await res.text()).trim());
    } catch { /* アイコンが無くても動く */ }
  }));
}

// size: "s"(14) | "m"(16) | ""(20)
export const icon = (name, size = "", cls = "") =>
  `<i class="ic ${size} ${cls}" data-icon="${name}" aria-hidden="true">${svgCache.get(name) || ""}</i>`;

// 静的 HTML の <i data-icon> に SVG を差し込む
export function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll("i[data-icon]")) {
    if (el.firstElementChild) continue;
    const svg = svgCache.get(el.dataset.icon);
    if (svg) el.innerHTML = svg;
    el.classList.add("ic");
    el.setAttribute("aria-hidden", "true");
  }
}

// ---------- 文字列 ----------
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
// http(s) 以外のリンク（javascript: など）は無効にする
export const safeUrl = (url) => (/^https?:\/\//i.test(String(url || "")) ? esc(url) : "#");
export const kbd = (...keys) => keys.map((k) => `<kbd>${esc(k)}</kbd>`).join("");

export function relTime(iso, now = Date.now()) {
  const t = new Date(iso).getTime();
  if (!t) return "";
  const m = Math.round((now - t) / 60000);
  if (m < 1) return "今";
  if (m < 60) return `${m} 分前`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} 時間前`;
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// ---------- 簡易 Markdown（見出し・箇条書き・番号・チェック・太字・コード・リンク） ----------
function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noopener">${shortUrl(unesc(url))}</a>`);
}

const UNESC = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
const unesc = (s) => String(s).replace(/&(amp|lt|gt|quot|#39);/g, (m) => UNESC[m]);

// 生の URL を「ホスト + パス」に縮めて、エスケープ済みの文字列で返す
export function shortUrl(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 24 ? `${u.pathname.slice(0, 22)}…` : u.pathname;
    return esc(u.hostname.replace(/^www\./, "") + (path === "/" ? "" : path));
  } catch { return esc(url); }
}

// checkable: チェックボックスをクリックできるようにする（data-check に通し番号）
export function markdown(src, { checkable = false } = {}) {
  const lines = String(src || "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let list = null; // "ul" | "ol"
  let check = 0;
  let inCode = false;
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const line of lines) {
    if (/^```/.test(line)) { close(); out.push(inCode ? "</code></pre>" : "<pre><code>"); inCode = !inCode; continue; }
    if (inCode) { out.push(esc(line) + "\n"); continue; }
    let m;
    if ((m = line.match(/^\s*[-*] \[([ xX])\]\s?(.*)$/))) {
      if (list !== "ul") { close(); out.push('<ul class="md-check">'); list = "ul"; }
      const on = m[1] !== " ";
      out.push(`<li class="${on ? "on" : ""}"><button type="button" class="md-box" ${checkable ? `data-check="${check}"` : "disabled"} aria-pressed="${on}">${icon(on ? "check-square" : "circle", "m")}</button><span>${inline(m[2])}</span></li>`);
      check++;
    } else if ((m = line.match(/^\s*[-*] (.*)$/))) {
      if (list !== "ul") { close(); out.push("<ul>"); list = "ul"; }
      out.push(`<li>${inline(m[1])}</li>`);
    } else if ((m = line.match(/^\s*\d+[.)] (.*)$/))) {
      if (list !== "ol") { close(); out.push("<ol>"); list = "ol"; }
      out.push(`<li>${inline(m[1])}</li>`);
    } else if ((m = line.match(/^(#{1,4}) (.*)$/))) {
      close(); out.push(`<p class="md-h">${inline(m[2])}</p>`);
    } else if (!line.trim()) {
      close();
    } else {
      close(); out.push(`<p>${inline(line)}</p>`);
    }
  }
  close();
  if (inCode) out.push("</code></pre>");
  return out.join("");
}

// ---------- 行 ----------
const SOURCE_ICON = { slack: "slack-logo", mail: "envelope-simple", paste: "clipboard-text", agent: "sparkle" };
export const sourceIcon = (task) => SOURCE_ICON[sourceKind(task)];

// mode: "list" | "dense"（受信箱） | "card"（ボード）
export function rowHtml(task, { today, mode = "list", selected = false, pending = false, verdict = null, keys = "" } = {}) {
  const done = task.state === "closed";
  const cls = ["row", `row--${mode}`, selected && "sel", pending && "pending", done && "done",
    task.stateReason === "not_planned" && "dropped"].filter(Boolean).join(" ");
  const tags = task.clients.map((c) => `<span class="tag">${esc(clientName(c))}</span>`).join("");
  const props = [];
  if (task.next === "waiting") props.push(`<span class="pill wait">${icon("hourglass", "s")}待ち</span>`);
  if (task.reportPending) props.push(`<span class="pill ai">${icon("sparkle", "s")}確認待ち</span>`);
  else if (task.next === "agent") props.push(`<span class="pill ai">${icon("sparkle", "s")}${esc(task.route || "AI")}</span>`);
  if (task.checklist.total) props.push(`<span class="pill">${icon("check-square", "s")}${task.checklist.done}/${task.checklist.total}</span>`);
  if (task.due && !done) {
    const over = task.due < today;
    props.push(`<span class="pill ${over ? "over" : task.due === today ? "today" : ""}">${icon("calendar-blank", "s")}${esc(formatDate(task.due, today))}</span>`);
  }
  if (task.wake && task.wake > today && !done) props.push(`<span class="pill">${icon("moon", "s")}${esc(formatDate(task.wake, today))}</span>`);
  if (task.column === "doing" && mode !== "card") props.push(`<span class="pill doing">${icon("play-circle", "s")}Doing</span>`);

  const from = mode === "dense" ? fromHtml(task) : "";
  const sub = [];
  if (mode === "list") {
    if (task.sources[0]) sub.push(`<span>${icon(sourceIcon(task), "s")}${esc(sourceLabel(task))}</span>`);
    for (const c of task.ctx) sub.push(`<span>${icon("hash", "s")}${esc(c)}</span>`);
    if (task.latest) sub.push(`<span class="clip">${icon("chat-circle", "s")}${esc(String(task.latest.body || "").split("\n")[0].slice(0, 60))}</span>`);
  }
  const why = verdict?.reason && mode === "dense" ? ` title="${esc(verdict.reason)}"` : "";
  return `<div class="${cls}" data-n="${task.number}" role="option" aria-selected="${selected}" tabindex="-1"${why}>
    <button type="button" class="row-check" data-act="toggle-done" title="${done ? "未完了に戻す" : "完了（E）"}" tabindex="-1">${icon(done ? "check-circle" : "circle")}</button>
    ${mode === "dense" ? `<span class="row-id">#${task.number}</span>` : ""}
    <div class="row-main">
      <div class="row-title">${task.priority ? '<span class="pri">!</span>' : ""}<span class="tt">${esc(task.title)}</span>${mode !== "dense" ? tags : ""}${from}</div>
      ${sub.length ? `<div class="row-sub">${sub.join("")}</div>` : ""}
    </div>
    <div class="row-props">${props.join("")}</div>
    ${mode === "dense" ? `<div class="row-keys">${keys}</div>` : ""}
  </div>`;
}

export function sourceLabel(task) {
  const s = task.sources[0] || "";
  const kind = sourceKind(task);
  if (kind === "slack") {
    const ch = s.match(/archives\/([A-Z0-9]+)/);
    return ch ? `Slack ${ch[1]}` : "Slack";
  }
  if (kind === "mail") return "メール";
  try { return new URL(s).hostname.replace(/^www\./, ""); } catch { return s.slice(0, 30); }
}

function fromHtml(task) {
  const kind = sourceKind(task);
  const parts = [];
  if (kind === "agent") {
    const who = task.lastReport?.user?.login || "agent";
    return `<span class="from ai">${icon("sparkle", "s")}${esc(who)} · ${esc(relTime(task.lastReport?.created_at))}</span>`;
  }
  if (task.clients[0]) parts.push(clientName(task.clients[0]));
  if (kind === "paste") parts.push(`メモ ${new Date(task.created).getMonth() + 1}/${new Date(task.created).getDate()}`);
  else parts.push(sourceLabel(task));
  return `<span class="from">${icon(sourceIcon(task), "s")}${esc(parts.join(" · "))}</span>`;
}
