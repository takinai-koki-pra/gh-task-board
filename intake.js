// まとめて追加: 貼り付けたテキストをタスクに分解する（Gemini、使えなければ行ごと）。第 8 節。
import { clientName, formatDate, parseQuickInput } from "./model.js";
import { esc } from "./ui.js";

const BULLET_RE = /^(?:[-*•・■□▪‣◦]|\d+[.)]|\[[ xX]\])\s*/;

export function splitLines(text, today) {
  const seen = new Set();
  return String(text).split(/\r?\n/)
    .map((l) => l.trim().replace(BULLET_RE, "").trim())
    .filter((l) => l && !seen.has(l) && seen.add(l))
    .slice(0, 50)
    .map((line) => {
      const q = parseQuickInput(line, today);
      const url = (line.match(/https?:\/\/\S+/) || [""])[0];
      return { title: q.title.replace(url, "").trim() || line, notes: "", checklist: [], column: "backlog", client: q.clients[0] || "", priority: q.priority, next: "self", due: q.due, source: url };
    });
}

export class Intake {
  // hooks: { ai(), parse(text) → tasks, create(tasks) → Promise<number>, today() }
  constructor(dialog, hooks) {
    this.dialog = dialog;
    this.hooks = hooks;
    this.tasks = [];
    this.busy = false;
    dialog.innerHTML = `<form method="dialog" class="dlg">
      <h2>まとめて追加</h2>
      <p class="lead">メモ・メール・議事録などを貼ると、タスクに分解して受信箱に入れます。</p>
      <textarea rows="7" placeholder="ここに貼り付け（Ctrl+Enter で分解）" data-text></textarea>
      <div class="row-tools"><button type="button" class="btn" data-parse>タスクに分解</button><span class="msg" data-msg></span></div>
      <div class="intake-list" data-list></div>
      <div class="actions"><button type="button" class="btn ghost" data-cancel>閉じる</button><button type="button" class="btn pri2" data-add disabled>追加</button></div>
    </form>`;
    this.text = dialog.querySelector("[data-text]");
    this.list = dialog.querySelector("[data-list]");
    this.msg = dialog.querySelector("[data-msg]");
    this.addBtn = dialog.querySelector("[data-add]");
    dialog.querySelector("[data-parse]").addEventListener("click", () => this.parse());
    dialog.querySelector("[data-cancel]").addEventListener("click", () => dialog.close());
    dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.close(); });
    this.text.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.ctrlKey) { e.preventDefault(); this.parse(); } });
    this.list.addEventListener("change", () => this.updateAdd());
    this.addBtn.addEventListener("click", () => this.add());
  }

  open(text = "") {
    this.text.value = text;
    this.tasks = [];
    this.list.innerHTML = "";
    this.msg.textContent = "";
    this.updateAdd();
    this.dialog.showModal();
    if (text.trim()) this.parse(); else this.text.focus();
  }

  async parse() {
    const text = this.text.value.trim();
    if (!text || this.busy) return;
    this.busy = true;
    const today = this.hooks.today();
    this.msg.textContent = this.hooks.ai() ? "Gemini で整理しています…" : "行ごとに分割しています…";
    let via = "lines", error = "";
    try {
      if (this.hooks.ai()) { this.tasks = await this.hooks.parse(text); via = "ai"; }
      else this.tasks = splitLines(text, today);
    } catch (err) {
      error = err.message || String(err);
      this.tasks = splitLines(text, today);
    }
    this.render();
    this.msg.textContent = via === "ai" ? `Gemini が ${this.tasks.length} 件に整理しました。直してから追加できます。`
      : error ? `Gemini を使えなかったので行ごとに分割しました（${error}）` : `${this.tasks.length} 件に分割しました。`;
    this.busy = false;
  }

  render() {
    const today = this.hooks.today();
    this.list.innerHTML = this.tasks.map((t, i) => {
      const meta = [
        t.client && clientName(t.client), t.due && `期限 ${formatDate(t.due, today)}`, t.priority && "優先",
        t.next === "waiting" && "相手待ち", t.checklist.length && `小項目 ${t.checklist.length}`, t.source && "リンクあり",
      ].filter(Boolean);
      return `<label class="intake-item" data-i="${i}">
        <input type="checkbox" checked />
        <input type="text" value="${esc(t.title)}" data-title />
        <select data-col>${["backlog", "todo", "doing"].map((c) => `<option value="${c}"${c === t.column ? " selected" : ""}>${c === "backlog" ? "受信箱" : c === "todo" ? "Todo" : "Doing"}</option>`).join("")}</select>
        ${meta.length || t.notes ? `<span class="meta">${esc(meta.join(" · "))}${t.notes ? ` — ${esc(t.notes.slice(0, 80))}` : ""}</span>` : ""}
      </label>`;
    }).join("");
    this.updateAdd();
  }

  checked() {
    return [...this.list.querySelectorAll(".intake-item")]
      .filter((row) => row.querySelector("input[type=checkbox]").checked)
      .map((row) => ({ ...this.tasks[Number(row.dataset.i)], title: row.querySelector("[data-title]").value.trim(), column: row.querySelector("[data-col]").value }))
      .filter((t) => t.title);
  }

  updateAdd() {
    const n = this.list.querySelectorAll("input[type=checkbox]:checked").length;
    this.addBtn.disabled = n === 0;
    this.addBtn.textContent = n ? `${n} 件を追加` : "追加";
    this.list.querySelectorAll(".intake-item").forEach((r) => r.classList.toggle("off", !r.querySelector("input[type=checkbox]").checked));
  }

  async add() {
    const items = this.checked();
    if (!items.length) return;
    this.addBtn.disabled = true;
    this.msg.textContent = `追加中… 0/${items.length}`;
    const ok = await this.hooks.create(items, (n) => { this.msg.textContent = `追加中… ${n}/${items.length}`; });
    this.dialog.close();
    return ok;
  }
}
