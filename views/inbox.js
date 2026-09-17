// 受信箱: 「対応必須 / その他」タブ、ソース別のセクション。行は 38px（dense）。
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
  const list = (ctx.inboxTab === "must" ? must : other).filter(ctx.match).sort(compareTasks(ctx.today));
  const order = [];
  const parts = [];
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
  const otherTab = ctx.inboxTab === "must" ? other : must;
  if (!list.length) {
    parts.push(`<div class="empty">${icon("tray")}<p>${ctx.filter ? "該当するタスクはありません" : ctx.inboxTab === "must" ? "対応必須はありません" : "ほかに未仕分けはありません"}</p>
      ${otherTab.length ? `<p class="dim">${ctx.inboxTab === "must" ? "その他" : "対応必須"} ${otherTab.length} 件は ${kbd("Tab")} で</p>` : `<p class="dim">${kbd("N")} で追加、${kbd("Ctrl", "K")} で文から作る</p>`}</div>`);
  } else if (otherTab.length) {
    parts.push(`<div class="sech dim">${ctx.inboxTab === "must" ? "その他" : "対応必須"} ${otherTab.length} 件は ${kbd("Tab")} で</div>`);
  }
  return {
    title: "受信箱",
    tabs: [
      { key: "must", label: "対応必須", n: must.length, on: ctx.inboxTab === "must" },
      { key: "other", label: "その他", n: other.length, on: ctx.inboxTab === "other" },
    ],
    html: `<div class="list list--dense" role="listbox" aria-label="受信箱">${parts.join("")}</div>`,
    order,
    count: must.length + other.length,
  };
}
