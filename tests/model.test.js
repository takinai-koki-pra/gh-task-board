import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseBody, getMeta, setMeta, newBody, checklist, toggleChecklist, columnOf, toTask, VIEWS, patchFor,
  applyPatch, snapshot, restorePatch, resolveDateWord, parseQuickInput, isSentence, normalizeChanges, changesToChange,
  mustHandle, sourceKind, summarizeChanges, addDays, formatDate,
} from "../model.js";

const TODAY = "2026-09-18"; // 金曜
const issue = (o = {}) => ({ number: 1, title: "t", body: "", state: "open", labels: [], html_url: "#", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z", ...o });
const L = (...names) => names.map((name) => ({ name }));

test("parseBody: task ブロックを読み、未知のキーと複数行 source を保持する", () => {
  const body = "```task\ndue: 2026-09-19\nwake:\nsource: https://a.slack.com/x\nhttps://b.example/y\nowner: me\n```\n- [ ] a\n- [x] b\n\nメモ";
  const p = parseBody(body);
  assert.equal(getMeta(p, "due"), "2026-09-19");
  assert.equal(getMeta(p, "wake"), "");
  assert.equal(getMeta(p, "source"), "https://a.slack.com/x\nhttps://b.example/y");
  assert.equal(getMeta(p, "owner"), "me");
  assert.equal(p.rest, "- [ ] a\n- [x] b\n\nメモ");
});

test("parseBody: ブロックが無ければ meta は null、CRLF も読む", () => {
  assert.deepEqual(parseBody("hello"), { meta: null, rest: "hello" });
  assert.equal(getMeta(parseBody("```task\r\ndue: 2026-01-02\r\n```\r\nx"), "due"), "2026-01-02");
  assert.equal(parseBody(null).rest, "");
});

test("parseBody: 先頭以外の task ブロックは無視する", () => {
  assert.equal(parseBody("x\n```task\ndue: 2026-01-02\n```").meta, null);
});

test("setMeta: 往復で本文と未知のキーを壊さない", () => {
  const body = "```task\ndue:\nowner: me\nsource: https://a\n```\n本文";
  const out = setMeta(body, { due: "2026-10-01", wake: "2026-09-25" });
  const p = parseBody(out);
  assert.equal(getMeta(p, "due"), "2026-10-01");
  assert.equal(getMeta(p, "wake"), "2026-09-25");
  assert.equal(getMeta(p, "owner"), "me");
  assert.equal(getMeta(p, "source"), "https://a");
  assert.equal(p.rest, "本文");
  assert.equal(setMeta(out, {}), out);
});

test("setMeta: ブロックが無い本文には先頭に足す", () => {
  const out = setMeta("メモだけ", { due: "2026-10-01" });
  assert.match(out, /^```task\ndue: 2026-10-01\nwake:\nsource:\n```\nメモだけ$/);
  assert.equal(newBody({ due: "2026-01-01" }), "```task\ndue: 2026-01-01\nwake:\nsource:\n```\n");
});

test("checklist: 進捗を数え、個別に反転できる", () => {
  const t = "- [ ] a\n- [x] b\n  - [X] c\n* [ ] d";
  assert.deepEqual(checklist(t), { done: 2, total: 4 });
  assert.equal(toggleChecklist(t, 0), "- [x] a\n- [x] b\n  - [X] c\n* [ ] d");
  assert.equal(toggleChecklist(t, 1), "- [ ] a\n- [ ] b\n  - [X] c\n* [ ] d");
});

test("columnOf", () => {
  assert.equal(columnOf(issue()), "backlog");
  assert.equal(columnOf(issue({ labels: L("status:todo") })), "todo");
  assert.equal(columnOf(issue({ labels: ["status:doing"] })), "doing");
  assert.equal(columnOf(issue({ state: "closed", labels: L("status:doing") })), "done");
});

test("toTask: 次に動く主体・案件・メタ・報告を読む", () => {
  const t = toTask(issue({ labels: L("agent:claude", "client:dbj", "ctx:pc2", "priority:high"), body: newBody({ due: "2026-09-20", source: "https://x.slack.com/p1" }) }), [
    { created_at: "2026-09-17T00:00:00Z", body: "着手: https://claude.ai/code/session_1 で開始" },
    { created_at: "2026-09-18T00:00:00Z", body: "報告: 3 案をまとめました" },
  ]);
  assert.equal(t.next, "agent");
  assert.equal(t.route, "claude");
  assert.deepEqual(t.clients, ["dbj"]);
  assert.deepEqual(t.ctx, ["pc2"]);
  assert.equal(t.priority, true);
  assert.equal(t.due, "2026-09-20");
  assert.deepEqual(t.sources, ["https://x.slack.com/p1"]);
  assert.equal(t.reportPending, true);
  assert.equal(t.sessionUrl, "https://claude.ai/code/session_1");
  assert.equal(sourceKind(t), "agent");
  assert.equal(toTask(issue({ labels: L("waiting", "agent") })).next, "waiting");
});

test("VIEWS: 受信箱", () => {
  assert.ok(VIEWS.inbox(toTask(issue())));
  assert.ok(VIEWS.inbox(toTask(issue({ labels: L("waiting") }))), "起票時の waiting は未仕分け");
  assert.ok(!VIEWS.inbox(toTask(issue({ labels: L("status:todo") }))));
  assert.ok(!VIEWS.inbox(toTask(issue({ body: newBody({ wake: "2026-09-25" }) }))));
  assert.ok(!VIEWS.inbox(toTask(issue({ state: "closed" }))));
  const reported = toTask(issue({ labels: L("status:doing") }), [{ created_at: "2026-09-18T00:00:00Z", body: "報告: 済" }]);
  assert.ok(VIEWS.inbox(reported));
  const approved = toTask(issue({ labels: L("status:doing") }), [
    { created_at: "2026-09-18T00:00:00Z", body: "報告: 済" },
    { created_at: "2026-09-18T01:00:00Z", body: "指示: 承認" },
  ]);
  assert.ok(!VIEWS.inbox(approved));
});

test("VIEWS: Today / 相手待ち / エージェント / 後で / 期限切れ", () => {
  const T = (o, c) => toTask(issue(o), c);
  assert.ok(VIEWS.today(T({ labels: L("status:todo") }), TODAY));
  assert.ok(VIEWS.today(T({ labels: L("status:doing") }), TODAY));
  assert.ok(VIEWS.today(T({ labels: L("priority:high") }), TODAY));
  assert.ok(VIEWS.today(T({ body: newBody({ due: TODAY }) }), TODAY));
  assert.ok(!VIEWS.today(T({ body: newBody({ due: "2026-09-19" }) }), TODAY));
  assert.ok(!VIEWS.today(T({ labels: L("status:todo", "waiting") }), TODAY));
  assert.ok(!VIEWS.today(T({ labels: L("status:todo", "agent:local") }), TODAY));
  assert.ok(!VIEWS.today(T({ labels: L("status:todo"), body: newBody({ wake: "2026-09-19" }) }), TODAY));
  assert.ok(VIEWS.today(T({ labels: L("status:todo"), body: newBody({ wake: TODAY }) }), TODAY));
  assert.ok(!VIEWS.today(T({ labels: L("status:todo"), state: "closed" }), TODAY));
  assert.ok(VIEWS.waiting(T({ labels: L("waiting") })));
  assert.ok(VIEWS.agent(T({ labels: L("agent") })));
  assert.ok(VIEWS.agent(T({ labels: L("agent:codex") })));
  assert.ok(VIEWS.later(T({ body: newBody({ wake: "2026-09-19" }) }), TODAY));
  assert.ok(!VIEWS.later(T({ body: newBody({ wake: TODAY }) }), TODAY));
  assert.ok(VIEWS.overdue(T({ body: newBody({ due: "2026-09-17" }) }), TODAY));
  assert.ok(!VIEWS.overdue(T({ body: newBody({ due: TODAY }) }), TODAY));
});

test("patchFor: 列の移動と完了・再オープン", () => {
  assert.deepEqual(patchFor(issue({ labels: L("status:todo", "x") }), { column: "doing" }), { labels: ["x", "status:doing"] });
  assert.deepEqual(patchFor(issue({ labels: L("status:todo") }), { column: "done" }), { labels: [], state: "closed", state_reason: "completed" });
  assert.deepEqual(patchFor(issue({ labels: [] }), { column: "not_planned" }), { state: "closed", state_reason: "not_planned" });
  assert.deepEqual(patchFor(issue({ state: "closed" }), { column: "todo" }), { state: "open", state_reason: "reopened", labels: ["status:todo"] });
  assert.deepEqual(patchFor(issue({ labels: L("status:todo") }), { column: "todo" }), {});
});

test("patchFor: 次に動く主体は排他", () => {
  assert.deepEqual(patchFor(issue({ labels: L("waiting", "client:a") }), { next: "agent", route: "local" }), { labels: ["client:a", "agent:local"] });
  assert.deepEqual(patchFor(issue({ labels: L("agent:claude") }), { next: "waiting" }), { labels: ["waiting"] });
  assert.deepEqual(patchFor(issue({ labels: L("agent") }), { next: "self" }), { labels: [] });
  assert.deepEqual(patchFor(issue({ labels: L("agent:x") }), { next: "agent" }), { labels: ["agent:x", "agent"] });
});

test("patchFor: 案件・優先・メタ・タイトル", () => {
  const p = patchFor(issue({ labels: L("client:a", "status:todo") }), { clients: ["b"], priority: true, due: "2026-09-22", title: "新しい" });
  assert.deepEqual(p.labels, ["status:todo", "priority:high", "client:b"]);
  assert.equal(p.title, "新しい");
  assert.equal(getMeta(parseBody(p.body), "due"), "2026-09-22");
  assert.deepEqual(patchFor(issue({ body: newBody({ due: "2026-09-22" }) }), { due: "2026-09-22" }), {});
});

test("snapshot + applyPatch で元に戻せる", () => {
  const before = issue({ labels: L("status:todo", "waiting"), body: newBody({ due: "2026-09-20" }) });
  const after = applyPatch(before, patchFor(before, { column: "done", due: "" }));
  assert.equal(after.state, "closed");
  assert.equal(after.state_reason, "completed");
  const restored = applyPatch(after, snapshot(before));
  assert.equal(restored.state, "open");
  assert.equal(restored.state_reason, null);
  assert.deepEqual(restored.labels.map((l) => l.name), ["status:todo", "waiting"]);
  assert.equal(restored.body, before.body);
});

test("restorePatch: 変わった所だけ戻す", () => {
  const before = issue({ labels: L("status:todo", "waiting"), body: newBody({ due: "2026-09-20" }) });
  const after = applyPatch(before, patchFor(before, { column: "done" }));
  assert.deepEqual(restorePatch(after, before), { labels: ["status:todo", "waiting"], state: "open", state_reason: "reopened" });
  assert.deepEqual(restorePatch(before, before), {});
  const reordered = { ...before, labels: L("waiting", "status:todo") };
  assert.deepEqual(restorePatch(reordered, before), {});
  const dropped = applyPatch(before, patchFor(before, { column: "not_planned" }));
  const closed = applyPatch(before, patchFor(before, { column: "done" }));
  assert.deepEqual(restorePatch(dropped, closed), { state: "closed", state_reason: "completed" });
});

test("resolveDateWord", () => {
  assert.equal(resolveDateWord("今日", TODAY), TODAY);
  assert.equal(resolveDateWord("明日", TODAY), "2026-09-19");
  assert.equal(resolveDateWord("金曜", TODAY), TODAY);
  assert.equal(resolveDateWord("月曜", TODAY), "2026-09-21");
  assert.equal(resolveDateWord("水曜日", TODAY), "2026-09-23");
  assert.equal(resolveDateWord("来週", TODAY), "2026-09-21");
  assert.equal(resolveDateWord("来週金曜", TODAY), "2026-09-25");
  assert.equal(resolveDateWord("9/19", TODAY), "2026-09-19");
  assert.equal(resolveDateWord("10月1日", TODAY), "2026-10-01");
  assert.equal(resolveDateWord("1/5", TODAY), "2027-01-05");
  assert.equal(resolveDateWord("+7", TODAY), "2026-09-25");
  assert.equal(resolveDateWord("13/1", TODAY), null);
  assert.equal(resolveDateWord("そのうち", TODAY), null);
  assert.equal(resolveDateWord("来週", "2026-09-21"), "2026-09-28", "月曜の来週は翌週月曜");
});

test("parseQuickInput", () => {
  assert.deepEqual(parseQuickInput("見積を返す 金曜 #dbj !", TODAY), { title: "見積を返す", due: TODAY, clients: ["dbj"], priority: true });
  assert.deepEqual(parseQuickInput("議事録を共有する 9/19まで", TODAY), { title: "議事録を共有する", due: "2026-09-19", clients: [], priority: false });
  assert.deepEqual(parseQuickInput("来週 資料を読む", TODAY), { title: "資料を読む", due: "2026-09-21", clients: [], priority: false });
  assert.deepEqual(parseQuickInput("急ぎ!", TODAY), { title: "急ぎ", due: "", clients: [], priority: true });
  assert.equal(parseQuickInput("C#の本を読む", TODAY).title, "C#の本を読む");
  assert.equal(parseQuickInput("金曜日の会議資料を作る", TODAY).due, "", "語の一部は日付にしない");
});

test("isSentence", () => {
  assert.ok(isSentence("これを来週の金曜までに"));
  assert.ok(isSentence("DBJ の案件で今日やる"));
  assert.ok(isSentence("山田さんに転送して"));
  assert.ok(!isSentence("ボード"));
  assert.ok(!isSentence("今日"));
  assert.ok(!isSentence("見積"));
});

test("normalizeChanges: 不正値と変化なしを捨て、from を現在値で埋める", () => {
  const task = toTask(issue({ title: "NDA を待つ", labels: L("waiting", "client:shinetsu") }));
  const out = normalizeChanges([
    { field: "next", from: "?", to: "自分" },
    { field: "due", to: "2026-09-22" },
    { field: "wake", to: "来週" },
    { field: "client", to: "shinetsu" },
    { field: "title", to: "山田さんへ NDA を転送する" },
    { field: "priority", to: "none" },
    { field: "column", to: "doing" },
    { field: "bogus", to: "x" },
  ], task);
  assert.deepEqual(out.map((c) => c.field), ["next", "due", "title", "column"]);
  assert.equal(out[0].from, "waiting");
  assert.equal(out[0].to, "self");
  const change = changesToChange(out);
  assert.deepEqual(change, { next: "self", due: "2026-09-22", title: "山田さんへ NDA を転送する", column: "doing" });
  assert.equal(summarizeChanges(out, TODAY), "次に動く: 自分、期限: 9/22 火、タイトル: 山田さんへ NDA を転送する、列: Doing");
});

test("mustHandle", () => {
  const t = (o) => toTask(issue(o));
  assert.ok(mustHandle(t({ labels: L("priority:high") }), TODAY));
  assert.ok(mustHandle(t({ body: newBody({ due: addDays(TODAY, 2) }) }), TODAY));
  assert.ok(!mustHandle(t({ body: newBody({ due: addDays(TODAY, 3) }) }), TODAY));
  assert.ok(mustHandle(t({}), TODAY, "must"));
  assert.ok(!mustHandle(t({ labels: L("priority:high") }), TODAY, "other"));
});

test("formatDate / isYmd", () => {
  assert.equal(toTask(issue({ body: newBody({ due: "2026-02-31" }) })).due, "", "存在しない日付は無視");
  assert.equal(formatDate(TODAY, TODAY), "今日");
  assert.equal(formatDate("2026-09-19", TODAY), "明日");
  assert.equal(formatDate("2026-09-22", TODAY), "9/22 火");
  assert.equal(formatDate("", TODAY), "");
});
