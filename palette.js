// Ctrl+K: 入力は 1 つ。単語ならコマンド検索とタスク検索、文なら /ai/interpret の提案。
// 会話は続かない。実行したら閉じる。
import { isSentence, describeChange, clientName } from "./model.js";
import { esc, icon, kbd } from "./ui.js";

export class Palette {
  // hooks: { commands(), tasks(), selected(), openTask(n), interpret(text), execute(proposal), today() , ai() }
  constructor(root, hooks) {
    this.root = root;
    this.hooks = hooks;
    this.items = [];
    this.index = 0;
    this.proposals = null; // { text, list, busy, error }
    root.innerHTML = `<div class="dimmer" data-close></div>
      <div class="pal" role="dialog" aria-label="コマンド">
        <div class="pal-in">${icon("magnifying-glass", "", "pal-ic")}<input type="text" placeholder="コマンド・タスクを検索、または文で指示" spellcheck="false" autocomplete="off" aria-label="コマンド" /></div>
        <div class="pal-list" role="listbox"></div>
        <div class="pal-ft"><span>文を打つと AI の提案、単語ならコマンド検索</span><span class="r">${kbd("↑")}${kbd("↓")} 選択 ${kbd("Enter")} 実行 ${kbd("Esc")} 閉じる</span></div>
      </div>`;
    this.input = root.querySelector("input");
    this.list = root.querySelector(".pal-list");
    this.ic = root.querySelector(".pal-ic");
    this.input.addEventListener("input", () => { this.proposals = null; this.index = 0; this.update(); });
    this.input.addEventListener("keydown", (e) => this.onKey(e));
    root.addEventListener("mousedown", (e) => { if (e.target.closest("[data-close]")) { e.preventDefault(); this.close(); } });
    this.list.addEventListener("mousemove", (e) => {
      const o = e.target.closest(".o");
      if (o && Number(o.dataset.i) !== this.index) { this.index = Number(o.dataset.i); this.paintSel(); }
    });
    this.list.addEventListener("click", (e) => {
      const o = e.target.closest(".o");
      if (o) { this.index = Number(o.dataset.i); this.run(); }
    });
  }

  get isOpen() { return !this.root.hidden; }

  open(text = "") {
    this.root.hidden = false;
    this.input.value = text;
    this.proposals = null;
    this.index = 0;
    this.update();
    this.input.focus();
    this.input.select();
  }

  close() {
    this.root.hidden = true;
    this.proposals = null;
    this.hooks.onClose?.();
  }

  onKey(e) {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Escape") { e.preventDefault(); this.close(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); this.move(1); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); this.move(-1); return; }
    if (e.key === "Tab") { e.preventDefault(); this.move(e.shiftKey ? -1 : 1); return; }
    if (e.key === "Enter") { e.preventDefault(); this.run(); }
  }

  move(d) {
    if (!this.items.length) return;
    this.index = (this.index + d + this.items.length) % this.items.length;
    this.paintSel();
  }

  paintSel() {
    this.list.querySelectorAll(".o").forEach((o) => {
      const on = Number(o.dataset.i) === this.index;
      o.classList.toggle("on", on);
      o.setAttribute("aria-selected", String(on));
      if (on) o.scrollIntoView({ block: "nearest" });
    });
  }

  async run() {
    const item = this.items[this.index];
    if (!item || item.disabled) return;
    const keepOpen = await item.run();
    if (!keepOpen) this.close();
  }

  async ask(text) {
    this.proposals = { text, list: [], busy: true };
    this.update();
    try {
      const list = await this.hooks.interpret(text);
      if (this.proposals?.text !== text) return;
      this.proposals = { text, list, busy: false };
    } catch (err) {
      if (this.proposals?.text !== text) return;
      this.proposals = { text, list: [], busy: false, error: err.message || String(err) };
    }
    this.index = 0;
    this.update();
    return true;
  }

  update() {
    const q = this.input.value.trim();
    const sentence = isSentence(q);
    this.ic.innerHTML = icon(sentence ? "sparkle" : "magnifying-glass");
    this.ic.classList.toggle("ai", sentence);
    const groups = [];
    const items = [];
    const add = (group, item) => {
      if (!groups.length || groups[groups.length - 1].name !== group) groups.push({ name: group, items: [] });
      groups[groups.length - 1].items.push(items.length);
      items.push(item);
    };

    if (sentence) {
      const p = this.proposals;
      if (p && p.text === q) {
        if (p.busy) add("AI の提案", { icon: "sparkle", label: "考えています…", disabled: true, run: () => true });
        else if (p.error) add("AI の提案", { icon: "warning-circle", label: p.error, sub: "Enter でもう一度", run: () => this.ask(q) });
        else if (!p.list.length) add("AI の提案", { icon: "sparkle", label: "ボードでできる操作が見つかりませんでした", sub: "言い換えるか、単語でコマンドを探してください", disabled: true, run: () => true });
        for (const prop of p.list) add("AI の提案", { icon: prop.kind === "create" ? "list-plus" : prop.kind === "route" ? "robot" : "sparkle", label: prop.summary || "提案", html: this.proposalChips(prop), run: () => this.hooks.execute(prop) });
      } else if (this.hooks.ai()) {
        add("AI の提案", { icon: "sparkle", label: `AI に聞く`, sub: this.hooks.selected() ? `選択中の #${this.hooks.selected().number} に対して解釈します` : "新しいタスクや操作を提案します", keys: kbd("Enter"), run: () => this.ask(q) });
      } else {
        add("AI の提案", { icon: "warning-circle", label: "AI が使えない環境です", sub: "GEMINI_API_KEY を設定すると文で指示できます", disabled: true, run: () => true });
      }
    }

    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const hit = (text) => words.every((w) => text.toLowerCase().includes(w));
    const cmds = this.hooks.commands().filter((c) => !q || hit(`${c.label} ${c.keywords || ""}`));
    for (const c of cmds.slice(0, sentence ? 3 : 12)) add(c.group || "コマンド", c);

    if (q && (!sentence || q.length < 20)) {
      const tasks = this.hooks.tasks().filter((t) => hit(`#${t.number} ${t.title} ${t.clients.map(clientName).join(" ")}`)).slice(0, 8);
      for (const t of tasks) add("タスク", { icon: t.state === "closed" ? "check-circle" : "circle", label: `${t.title}`, sub: `#${t.number}${t.clients.length ? ` · ${t.clients.map(clientName).join("・")}` : ""}`, run: () => this.hooks.openTask(t.number) });
    }
    if (!items.length) add("", { icon: "magnifying-glass", label: "見つかりません", disabled: true, run: () => true });

    this.items = items;
    if (this.index >= items.length) this.index = 0;
    this.list.innerHTML = groups.map((g) => `${g.name ? `<div class="g">${esc(g.name)}</div>` : ""}${g.items.map((i) => {
      const it = items[i];
      return `<div class="o${it.disabled ? " disabled" : ""}${i === this.index ? " on" : ""}" data-i="${i}" role="option" aria-selected="${i === this.index}">${icon(it.icon || "caret-right")}<div class="ot">${esc(it.label)}${it.sub ? `<span class="sub">${esc(it.sub)}</span>` : ""}${it.html || ""}</div>${it.keys ? `<span class="k">${it.keys}</span>` : ""}</div>`;
    }).join("")}`).join("");
  }

  proposalChips(p) {
    const today = this.hooks.today();
    const chips = [];
    if (p.kind === "create" && p.title) chips.push(`<span class="chip">${icon("plus", "s")}${esc(p.title)}</span>`);
    if (p.target && p.kind !== "create") chips.push(`<span class="chip">#${p.target}</span>`);
    for (const c of p.changes || []) {
      const d = describeChange({ ...c, from: "" }, today);
      chips.push(`<span class="chip">${esc(d.name)} <b>${esc(d.to)}</b></span>`);
    }
    if (p.kind === "route") chips.push(`<span class="chip agent">${icon("sparkle", "s")}${esc(p.agentText || "エージェントに頼む")} <span class="route">${esc(p.route)}</span></span>`);
    return chips.length ? `<div class="chips">${chips.join("")}</div>` : "";
  }
}
