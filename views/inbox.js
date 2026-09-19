// 受信箱: 「対応必須」→「その他」を 1 本のリストで。各グループの中はソース別のセクション。行は 38px（dense）。
import { VIEWS, mustHandle, sourceKind, compareTasks } from "../model.js";
import { rowHtml, kbd, icon, esc } from "../ui.js";

const SECTIONS = [
  { key: "agent", name: "エージェントから" },
  { key: "slack", name: "Slack から" },
  { key: "mail", name: "メールから" },
  { key: "paste", name: "貼り付けから" },
];

export function splitInbox(ctx) {
  const items = ctx.tasks.filter((t) => VIEWS.inbox(t, ctx.today));
  const must = [], other = [];
  for (const t of items) (mustHandle(t, ctx.today, ctx.triage[t.number]?.priority) ? must : other).push(t);
  return { must, other };
}

export function renderInbox(ctx) {
  const { must, other } = splitInbox(ctx);
  const groups = [
    { key: "must", name: "対応必須", items: must },
    { key: "other", name: "その他", items: other },
  ];
  const order = [];
  const parts = [];
  let shown = 0;
  for (const g of groups) {
    const list = g.items.filter(ctx.match).sort(compareTasks(ctx.today));
    if (!list.length) continue;
    shown += list.length;
    parts.push(`<div class="grp-h">${g.name}<span class="n">${list.length}</span></div>`);
    for (const sec of SECTIONS) {
      const rows = list.filter((t) => sourceKind(t) === sec.key);
      if (!rows.length) continue;
      parts.push(`<div class="sech">${sec.name}<span class="n">${rows.length}</span></div>`);
      for (const t of rows) {
        order.push(t.number);
        const selected = t.number === ctx.selected;
        const keys = !selected ? "" : t.reportPending ? kbd("Y") + kbd("R") : kbd("1") + kbd("2") + kbd("3") + kbd("4");
        parts.push(rowHtml(t, { today: ctx.today, mode: "dense", selected, pending: ctx.pending.has(t.number), verdict: ctx.triage[t.number], keys }));
      }
    }
  }
  if (!shown) {
    parts.push(`<div class="empty">${icon("tray")}<p>${ctx.filter ? "該当するタスクはありません" : "受信箱は空です"}</p>
      <p class="dim">${kbd("N")} で追加、${kbd("Ctrl", "K")} で文から作る</p></div>`);
  }
  return {
    title: "受信箱",
    tabs: [],
    html: `<div class="list list--dense" role="listbox" aria-label="受信箱">${parts.join("")}</div>`,
    order,
    count: must.length + other.length,
  };
}
