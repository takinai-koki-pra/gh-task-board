// ボード: 4 列（Backlog / Todo / Doing / Done）。行部品は .row の card 版。ドラッグで列移動。
import { COLUMNS, compareTasks } from "../model.js";
import { rowHtml, esc } from "../ui.js";

const DONE_LIMIT = 30;

export function renderBoard(ctx) {
  const order = [];
  const cols = COLUMNS.map((col) => {
    let rows = ctx.tasks.filter((t) => t.column === col.key).filter(ctx.match);
    const total = rows.length;
    if (col.key === "done") rows = rows.sort((a, b) => (a.updated < b.updated ? 1 : -1)).slice(0, DONE_LIMIT);
    else rows = rows.sort(compareTasks(ctx.today));
    for (const t of rows) order.push(t.number);
    return `<section class="col" data-col="${col.key}">
      <header class="col-h"><span class="col-dot ${col.key}"></span>${esc(col.name)}<span class="n">${total}</span></header>
      <div class="col-list">${rows.map((t) => rowHtml(t, { today: ctx.today, mode: "card", selected: t.number === ctx.selected, pending: ctx.pending.has(t.number) })).join("") || '<div class="col-empty">ここにドロップ</div>'}
      ${total > rows.length ? `<div class="col-empty">他 ${total - rows.length} 件は GitHub で</div>` : ""}</div>
    </section>`;
  });
  return { title: "ボード", html: `<div class="board">${cols.join("")}</div>`, order, count: order.length };
}

// ---------- ドラッグ（Pointer Events。タッチは長押しで開始） ----------
export function attachBoardDrag(root, { onDrop, onClickSuppressed }) {
  const drag = { row: null, ghost: null, active: false, x: 0, y: 0, timer: null, offX: 0, offY: 0 };
  const colAt = (x, y) => document.elementFromPoint(x, y)?.closest(".col");

  function start(x, y) {
    drag.active = true;
    const rect = drag.row.getBoundingClientRect();
    drag.offX = x - rect.left;
    drag.offY = y - rect.top;
    drag.ghost = drag.row.cloneNode(true);
    drag.ghost.classList.add("drag-ghost");
    drag.ghost.style.width = `${rect.width}px`;
    document.body.appendChild(drag.ghost);
    drag.row.classList.add("dragging");
    move(x, y);
  }
  function move(x, y) {
    drag.ghost.style.transform = `translate(${x - drag.offX}px, ${y - drag.offY}px)`;
    const over = colAt(x, y);
    root.querySelectorAll(".col.over").forEach((c) => c !== over && c.classList.remove("over"));
    over?.classList.add("over");
  }
  function end(x, y, cancelled) {
    clearTimeout(drag.timer);
    if (drag.active) {
      const over = cancelled ? null : colAt(x, y);
      root.querySelectorAll(".col.over").forEach((c) => c.classList.remove("over"));
      drag.ghost?.remove();
      drag.row?.classList.remove("dragging");
      onClickSuppressed();
      if (over) onDrop(Number(drag.row.dataset.n), over.dataset.col);
    }
    drag.row = null;
    drag.active = false;
  }

  root.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !root.querySelector(".board")) return;
    const row = e.target.closest(".row");
    if (!row || e.target.closest(".row-check")) return;
    drag.row = row;
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (e.pointerType === "touch") drag.timer = setTimeout(() => drag.row && start(drag.x, drag.y), 220);
  });
  document.addEventListener("pointermove", (e) => {
    if (!drag.row) return;
    if (!drag.active) {
      const dist = Math.hypot(e.clientX - drag.x, e.clientY - drag.y);
      if (e.pointerType === "touch") { if (dist > 8) { clearTimeout(drag.timer); drag.row = null; } return; }
      if (dist > 6) start(e.clientX, e.clientY);
      return;
    }
    move(e.clientX, e.clientY);
  });
  document.addEventListener("pointerup", (e) => end(e.clientX, e.clientY, false));
  document.addEventListener("pointercancel", (e) => end(e.clientX, e.clientY, true));
  document.addEventListener("touchmove", (e) => { if (drag.active) e.preventDefault(); }, { passive: false });
}
