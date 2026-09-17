// 右パネル: 選択中タスクの詳細（引用、プロパティ、メモ、履歴）、エージェント報告の承認 / 差し戻し、指示欄。
import { clientName, formatDate, formatMd, nextName, COLUMNS, commentKind, commentText, describeChange, addDays, resolveDateWord, ROUTES } from "./model.js";
import { esc, icon, kbd, markdown, relTime, shortUrl, sourceIcon, safeUrl } from "./ui.js";

const COLUMN_ICONS = { backlog: "circle-half", todo: "circle", doing: "play-circle", done: "check-circle" };

export function renderPanelEmpty(ctx) {
  return `<div class="p-empty">${icon("tray")}<p>タスクを選ぶと、ここに詳細が出ます</p>
    <ul class="keys">
      <li>${kbd("J")}${kbd("K")} 移動</li><li>${kbd("1")}〜${kbd("4")} 仕分け</li><li>${kbd("E")} 完了</li>
      <li>${kbd("N")} 追加</li><li>${kbd("Ctrl", "K")} コマンド / 文で指示</li><li>${kbd("Ctrl", "Z")} 元に戻す</li>
    </ul>
    ${ctx.demo ? '<p class="dim">デモモード: GitHub には書き込みません</p>' : ""}</div>`;
}

function activeChanges(draft, task) {
  if (!draft?.result || draft.number !== task.number || draft.mode !== "instruct") return new Map();
  return new Map(draft.result.changes.filter((c) => !draft.off.has(`c:${c.field}`)).map((c) => [c.field, c]));
}

function propValue(field, task, ctx, chg) {
  const today = ctx.today;
  const show = (html, empty) => ({ html, empty });
  let cur;
  switch (field) {
    case "column": cur = show(`${icon(COLUMN_ICONS[task.column], "m")}${task.state === "closed" && task.stateReason === "not_planned" ? "やらない" : COLUMNS.find((c) => c.key === task.column).name}`); break;
    case "next": cur = show(task.next === "waiting" ? `<span class="wait">${icon("hourglass", "m")}相手待ち</span>` : task.next === "agent" ? `<span class="ai">${icon("sparkle", "m")}${esc(nextName(task))}</span>` : `${icon("user", "m")}自分`); break;
    case "due": cur = task.due ? show(`${icon("calendar-blank", "m")}<span class="${task.due < today && task.state === "open" ? "over" : ""}">${esc(formatDate(task.due, today))}</span>`) : show(`${icon("calendar-blank", "m")}なし`, true); break;
    case "wake": cur = task.wake ? show(`${icon("moon", "m")}${esc(formatDate(task.wake, today))}`) : show(`${icon("moon", "m")}なし`, true); break;
    case "client": cur = task.clients.length ? show(task.clients.map((c) => `<span class="dot" style="--dot:${ctx.clientColor(c)}"></span>${esc(clientName(c))}`).join(" ")) : show(`${icon("folder-simple", "m")}なし`, true); break;
    case "priority": cur = task.priority ? show(`<span class="pri">!</span>優先`) : show(`${icon("flag-banner", "m")}なし`, true); break;
    default: cur = show("");
  }
  if (!chg) return `<button type="button" class="v${cur.empty ? " unset" : ""}" data-prop="${field}">${cur.html}</button>`;
  const d = describeChange(chg, today);
  return `<button type="button" class="v chg" data-prop="${field}"><span class="old">${esc(d.from)}</span><span class="arr">→</span>${esc(d.to)}</button>`;
}

export function renderPanel(task, ctx) {
  const chg = activeChanges(ctx.draft, task);
  const src = task.sources[0];
  const link = src
    ? `<a href="${safeUrl(src)}" target="_blank" rel="noopener">${/slack\.com/.test(src) ? "Slack" : "元の文脈"}で開く ↗</a>`
    : `<a href="${safeUrl(task.url)}" target="_blank" rel="noopener">GitHub で開く ↗</a>`;
  const idParts = [`#${task.number}`, ...task.clients.map(clientName), ...task.ctx];
  const titleChg = chg.get("title");
  const parts = [];
  parts.push(`<div class="p-id"><span>${esc(idParts.join(" · "))}</span><span class="links">${src ? `<a href="${safeUrl(task.url)}" target="_blank" rel="noopener">GitHub ↗</a>` : ""}${link}</span></div>`);
  parts.push(titleChg
    ? `<h3 class="p-title chg"><span class="old">${esc(task.title)}</span>${esc(titleChg.to)}</h3>`
    : `<h3 class="p-title" data-act="edit-title" title="クリックで編集">${esc(task.title)}</h3>`);

  if (task.state === "open" && !task.reportPending) {
    parts.push(`<div class="touch-acts only-narrow">
      <button type="button" class="btn" data-act="triage" data-key="1">${icon("sun", "m")}今日</button>
      <button type="button" class="btn" data-act="triage" data-key="2">${icon("moon", "m")}後で</button>
      <button type="button" class="btn" data-act="triage" data-key="3">${icon("hourglass", "m")}待ち</button>
      <button type="button" class="btn" data-act="triage" data-key="4">${icon("sparkle", "m")}AI</button>
      <button type="button" class="btn" data-act="done">${icon("check-circle", "m")}完了</button>
    </div>`);
  }
  if (task.reportPending || (task.lastReport && ctx.draft?.mode === "return" && ctx.draft.number === task.number)) parts.push(reportHtml(task, ctx));

  if (task.sources.length) {
    parts.push(`<div class="quote">${task.sources.map((s) => `<a href="${safeUrl(s)}" target="_blank" rel="noopener">${icon(sourceIcon(task), "s")}${shortUrl(s)}</a>`).join("")}</div>`);
  }

  const verdict = ctx.triage[task.number];
  parts.push(`<div class="prop">
    <span class="k">状態</span>${propValue("column", task, ctx, chg.get("column"))}
    <span class="k">次に動く</span>${propValue("next", task, ctx, chg.get("next"))}
    <span class="k">期限</span>${propValue("due", task, ctx, chg.get("due"))}
    <span class="k">再表示</span>${propValue("wake", task, ctx, chg.get("wake"))}
    <span class="k">案件</span>${propValue("client", task, ctx, chg.get("client"))}
    <span class="k">優先</span>${propValue("priority", task, ctx, chg.get("priority"))}
  </div>`);
  if (verdict?.reason && task.state === "open") parts.push(`<div class="verdict">${icon("sparkle", "s")}${verdict.priority === "must" ? "対応必須" : "その他"}: ${esc(verdict.reason)}</div>`);

  parts.push(`<div class="notes">${task.notes.trim() ? markdown(task.notes, { checkable: true }) : '<p class="dim">メモなし</p>'}<button type="button" class="linkbtn" data-act="edit-notes">メモを編集</button></div>`);
  parts.push(historyHtml(task, ctx));
  return parts.join("");
}

function reportHtml(task, ctx) {
  const r = task.lastReport;
  const body = commentText(r);
  const took = (() => {
    const start = [...task.comments].reverse().find((c) => commentKind(c) === "start" && c.created_at <= r.created_at);
    if (!start) return "";
    const min = Math.round((new Date(r.created_at) - new Date(start.created_at)) / 60000);
    return min > 0 ? ` · ${min} 分かけて作業` : "";
  })();
  return `<div class="report">
    <div class="rh">${icon("sparkle", "s")}エージェントの報告<span>${esc(r.user?.login || "")} · ${esc(relTime(r.created_at))}${took}</span></div>
    <div class="rb md">${markdown(body)}</div>
    ${task.reportPending ? `<div class="decide">
      <button type="button" class="btn pri2" data-act="approve">承認 ${kbd("Y")}</button>
      <button type="button" class="btn" data-act="return">差し戻し ${kbd("R")}</button>
      ${task.sessionUrl ? `<a class="btn ghost" href="${safeUrl(task.sessionUrl)}" target="_blank" rel="noopener">Claude で開く ↗</a>` : ""}
      <a class="btn ghost" href="${safeUrl(r.html_url || task.url)}" target="_blank" rel="noopener">GitHub ↗</a>
    </div>` : ""}
  </div>`;
}

function historyHtml(task, ctx) {
  const list = task.comments;
  const loading = ctx.commentsLoading;
  if (!list.length && !loading) return "";
  const who = (c) => {
    const kind = commentKind(c);
    const bot = kind === "report" || kind === "start" || /\[bot\]$/.test(c.user?.login || "");
    return `<span class="who${bot ? " bot" : ""}">${esc(c.user?.login || "?")} · ${esc(relTime(c.created_at))}</span>`;
  };
  const rows = list.slice(-12).map((c) => {
    const text = String(c.body || "").trim();
    const short = text.length > 280 ? `${text.slice(0, 280)}…` : text;
    return `<div class="cmt ${commentKind(c)}">${who(c)}<div class="md">${markdown(short)}</div></div>`;
  });
  return `<div class="hist"><div class="hh">${icon("chat-circle", "s")}履歴<span>${list.length}${loading ? " · 読み込み中…" : ""}</span></div>${list.length > 12 ? `<a class="dim" href="${safeUrl(task.url)}" target="_blank" rel="noopener">以前の ${list.length - 12} 件は GitHub で</a>` : ""}${rows.join("")}</div>`;
}

// ---------- 指示欄 ----------
export function renderAskExtras(task, ctx) {
  const d = ctx.draft?.number === task.number ? ctx.draft : null;
  if (!d) return { hint: ctx.ai ? "" : "AI が使えない環境です（GEMINI_API_KEY 未設定）", box: "" };
  if (d.busy) return { box: `<div class="prop2 busy">${icon("sparkle", "s")}考えています…</div>`, hint: "" };
  if (d.error) return { box: `<div class="prop2 err">${icon("warning-circle", "s")}${esc(d.error)}</div>`, hint: `${kbd("Enter")} でもう一度 · ${kbd("Esc")} でやめる` };
  if (d.mode === "return" && d.ready) {
    const route = d.route;
    return {
      box: `<div class="prop2">
        <div class="h">${icon("sparkle", "s")}差し戻し内容</div>
        <div class="chips">
          <span class="chip agent">${icon("sparkle", "s")}${esc(d.text)}</span>
          <button type="button" class="chip" data-act="cycle-route" title="クリックで実行先を切り替え">実行先 <b>${esc(route)}</b></button>
          <span class="chip">次に動く <span class="arr">→</span> エージェント</span>
          <span class="chip">受信箱から外す</span>
        </div>
        <div class="go"><button type="button" class="btn pri2" data-act="apply">送る ${kbd("Enter")}</button><button type="button" class="btn ghost" data-act="discard">やめる ${kbd("Esc")}</button></div>
      </div>`,
      hint: "指示はコメントとして Issue に付き、エージェントはそれを読んで続ける",
    };
  }
  if (!d.result) {
    return { box: "", hint: d.mode === "return" ? `差し戻す内容を書いて ${kbd("Enter")}` : `${kbd("Enter")} で送る · ${kbd("Shift", "Enter")} で改行 · ${kbd("Esc")} で戻る` };
  }
  const { changes, agentRequests, note } = d.result;
  const chips = [];
  for (const c of changes) {
    const key = `c:${c.field}`;
    const x = describeChange(c, ctx.today);
    const off = d.off.has(key);
    chips.push(`<button type="button" class="chip${off ? " x" : ""}" data-act="chip" data-key="${key}" title="${off ? "クリックで戻す" : "クリックで外す"}">${esc(x.name)} ${c.field === "title" ? `<span class="old">${esc(x.from.length > 12 ? `…${x.from.slice(-10)}` : x.from)}</span><span class="arr">→</span>` : c.from !== "" && c.field !== "priority" ? `<span class="old">${esc(x.from)}</span><span class="arr">→</span>` : ""}<b>${esc(x.to)}</b></button>`);
  }
  agentRequests.forEach((r, i) => {
    const key = `a:${i}`;
    const off = d.off.has(key);
    chips.push(`<button type="button" class="chip agent${off ? " x" : ""}" data-act="chip" data-key="${key}" title="${off ? "クリックで戻す" : "クリックで外す"}">${icon("sparkle", "s")}${esc(r.text)} <span class="route">${esc(r.route)}</span></button>`);
  });
  const anyAgent = agentRequests.some((_, i) => !d.off.has(`a:${i}`));
  const empty = !changes.length && !agentRequests.length;
  return {
    box: `<div class="prop2">
      <div class="h">${icon("sparkle", "s")}${empty ? "変える所が見つかりませんでした" : "こう変えます"}</div>
      ${chips.length ? `<div class="chips">${chips.join("")}</div>` : ""}
      ${note ? `<div class="note">${esc(note)}</div>` : ""}
      <div class="go">
        ${empty ? "" : `<button type="button" class="btn pri2" data-act="apply">適用 ${kbd("Enter")}</button>`}
        ${anyAgent ? `<button type="button" class="btn" data-act="drop-agents">依頼はしない</button>` : ""}
        <button type="button" class="btn ghost" data-act="discard">やめる ${kbd("Esc")}</button>
      </div>
    </div>`,
    hint: empty ? "言い換えてもう一度送れます" : "上のプロパティにも差分を先に映しています · 適用後は履歴にコメントが残る",
  };
}

// ---------- プロパティのポップオーバー ----------
export function renderPopover(field, task, ctx) {
  const today = ctx.today;
  const opt = (value, label, on, extra = "") => `<button type="button" class="opt${on ? " on" : ""}" data-value="${esc(value)}" ${extra}>${label}</button>`;
  switch (field) {
    case "column":
      return [...COLUMNS.map((c) => opt(c.key, `${icon(COLUMN_ICONS[c.key], "m")}${c.name}`, task.column === c.key && task.stateReason !== "not_planned")),
        opt("not_planned", `${icon("x", "m")}やらない（クローズ）`, task.stateReason === "not_planned")].join("");
    case "next":
      return [
        opt("self", `${icon("user", "m")}自分`, task.next === "self"),
        opt("waiting", `${icon("hourglass", "m")}相手待ち`, task.next === "waiting"),
        opt("agent", `${icon("sparkle", "m")}エージェント（振り分け未定）`, task.next === "agent" && !task.route),
        ...ROUTES.map((r) => opt(`agent:${r}`, `<span class="indent"></span>${r}`, task.route === r)),
      ].join("");
    case "due":
    case "wake": {
      const cur = task[field];
      const quick = field === "due"
        ? [["今日", today], ["明日", addDays(today, 1)], ["金曜", resolveDateWord("金曜", today)], ["来週月曜", resolveDateWord("来週", today)], ["+7 日", addDays(today, 7)]]
        : [["明日", addDays(today, 1)], ["月曜", resolveDateWord("月曜", today)], ["+3 日", addDays(today, 3)], ["+7 日", addDays(today, 7)], ["+14 日", addDays(today, 14)]];
      return `${quick.map(([l, v]) => opt(v, `${esc(l)}<span class="dim">${esc(formatMd(v))}</span>`, cur === v)).join("")}
        <label class="opt date">${icon("calendar-blank", "m")}<input type="date" value="${esc(cur)}" data-date /></label>
        ${opt("", `${icon("x", "m")}なし`, !cur)}`;
    }
    case "client":
      return `${ctx.clients.map((c) => opt(c, `<span class="dot" style="--dot:${ctx.clientColor(c)}"></span>${esc(clientName(c))}<span class="dim">${esc(c)}</span>`, task.clients.includes(c))).join("")}
        <label class="opt">${icon("plus", "m")}<input type="text" placeholder="新しい案件（英小文字）" data-new-client spellcheck="false" /></label>
        ${opt("", `${icon("x", "m")}なし`, !task.clients.length)}`;
    default:
      return "";
  }
}
