// 直前の変更の逆操作を積む（最大 10 件）。トーストは 8 秒で消える。確認ダイアログは出さない。
import { esc, icon, kbd } from "./ui.js";

const LIMIT = 10;
const TOAST_MS = 8000;

export class UndoStack {
  constructor() { this.items = []; this.busy = false; }
  push(label, undo) {
    this.items.push({ label, undo });
    if (this.items.length > LIMIT) this.items.shift();
  }
  get size() { return this.items.length; }
  // 戻した操作のラベルを返す。無ければ null
  async pop() {
    if (this.busy) return null;
    const item = this.items.pop();
    if (!item) return null;
    this.busy = true;
    try { await item.undo(); return item.label; } finally { this.busy = false; }
  }
}

export class Toaster {
  constructor(root, { onUndo }) {
    this.root = root;
    this.onUndo = onUndo;
    this.timer = null;
  }
  show(text, { kind = "ok", undoable = false } = {}) {
    clearTimeout(this.timer);
    const ic = kind === "error" ? icon("warning-circle", "m", "t-err") : kind === "ok" ? icon("check-circle", "m", "t-ok") : icon("sparkle", "m", "t-ai");
    this.root.innerHTML = `<div class="toast ${kind}" role="status">${ic}<span>${esc(text)}</span>${undoable ? `<button type="button" class="u">${icon("arrow-counter-clockwise", "m")}元に戻す ${kbd("Ctrl", "Z")}</button>` : ""}</div>`;
    this.root.querySelector(".u")?.addEventListener("click", () => this.onUndo());
    this.timer = setTimeout(() => this.hide(), kind === "error" ? TOAST_MS + 2000 : TOAST_MS);
  }
  hide() { this.root.innerHTML = ""; }
}
