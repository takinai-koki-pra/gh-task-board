// 今日 / 相手待ち / エージェント / 後で / 案件 / 文脈。行部品は受信箱と同じ .row。
import { VIEWS, inClient, inCtx, compareTasks, clientName, formatDate } from "../model.js";
import { rowHtml, icon, kbd, esc } from "../ui.js";

const ROUTE_NAMES = { "": "振り分け待ち", claude: "Claude（クラウド）", codex: "Codex", local: "手元の PC" };

function sectionsFor(view, tasks, today) {
  const byCol = (list) => [
    { name: "Doing", rows: list.filter((t) => t.column === "doing") },
    { name: "Todo", rows: list.filter((t) => t.column === "todo") },
    { name: "Backlog", rows: list.filter((t) => t.column === "backlog") },
  ];
  switch (view.kind) {
    case "today": {
      const list = tasks.filter((t) => VIEWS.today(t, today));
      return {
        title: "今日", icon: "sun",
        sections: [
          { name: "期限切れ", rows: list.filter((t) => VIEWS.overdue(t, today)), warn: true },
          { name: "Doing", rows: list.filter((t) => t.column === "doing" && !VIEWS.overdue(t, today)) },
          { name: "今日やる", rows: list.filter((t) => t.column !== "doing" && !VIEWS.overdue(t, today)) },
        ],
      };
    }
    case "waiting":
      return { title: "相手待ち", icon: "hourglass", sections: byCol(tasks.filter(VIEWS.waiting)) };
    case "agent": {
      const list = tasks.filter(VIEWS.agent);
      return { title: "エージェント", icon: "sparkle", sections: Object.entries(ROUTE_NAMES).map(([r, name]) => ({ name, rows: list.filter((t) => (t.route || "") === r) })) };
    }
    case "later": {
      const list = tasks.filter((t) => VIEWS.later(t, today)).sort((a, b) => (a.wake < b.wake ? -1 : 1));
      const dates = [...new Set(list.map((t) => t.wake))];
      return { title: "後で", icon: "moon", sort: false, sections: dates.map((d) => ({ name: `${formatDate(d, today)} に再表示`, rows: list.filter((t) => t.wake === d) })) };
    }
    case "client":
      return { title: clientName(view.slug), icon: "folder-simple", sections: byCol(tasks.filter(inClient(view.slug))), closed: tasks.filter((t) => t.state === "closed" && t.clients.includes(view.slug)) };
    case "ctx":
      return { title: `#${view.slug}`, icon: "hash", sections: byCol(tasks.filter(inCtx(view.slug))) };
    case "search":
      return { title: "検索", icon: "magnifying-glass", sections: [{ name: "未完了", rows: tasks.filter((t) => t.state === "open") }, { name: "完了", rows: tasks.filter((t) => t.state === "closed").slice(0, 30) }] };
    default:
      return { title: "", sections: [] };
  }
}

export function renderList(ctx) {
  const def = sectionsFor(ctx.view, ctx.tasks, ctx.today);
  const order = [];
  const parts = [];
  let count = 0;
  for (const sec of def.sections) {
    let rows = sec.rows.filter(ctx.match);
    if (def.sort !== false) rows = rows.sort(compareTasks(ctx.today));
    if (!rows.length) continue;
    count += rows.length;
    parts.push(`<div class="sec${sec.warn ? " warn" : ""}">${esc(sec.name)}<span class="n">${rows.length}</span></div>`);
    for (const t of rows) {
      order.push(t.number);
      parts.push(rowHtml(t, { today: ctx.today, selected: t.number === ctx.selected, pending: ctx.pending.has(t.number) }));
    }
  }
  if (def.closed?.length) {
    const rows = def.closed.filter(ctx.match).slice(0, 20);
    if (rows.length) parts.push(`<details class="closed"><summary class="sec">完了<span class="n">${def.closed.length}</span></summary>${rows.map((t) => rowHtml(t, { today: ctx.today, selected: t.number === ctx.selected })).join("")}</details>`);
    for (const t of rows) order.push(t.number);
  }
  if (!count) {
    parts.push(`<div class="empty">${icon(def.icon || "tray")}<p>${ctx.filter ? "該当するタスクはありません" : "ここには何もありません"}</p><p class="dim">${kbd("N")} で追加</p></div>`);
  }
  return { title: def.title, html: `<div class="list" role="listbox" aria-label="${esc(def.title)}">${parts.join("")}</div>`, order, count };
}

export const listCount = (view, tasks, today) =>
  sectionsFor(view, tasks, today).sections.reduce((n, s) => n + s.rows.length, 0);
