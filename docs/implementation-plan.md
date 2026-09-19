# 実装指示書 — Task Board v2（PC 版）

別セッションで実装する人（またはエージェント）向けの指示書。設計の正本は `docs/data-model.md`、見た目と操作の正本は `docs/mock/final-mock.html`。この文書は「何をどの順で作るか」と「完了の判定」だけを書く。

## 0. 前提と決定事項（変えない）

| 項目 | 決定 |
|---|---|
| 対象 | PC（Windows）優先。iPhone は後回しだが、同じコードが崩れず動く程度の配慮はする |
| 構成 | 静的 PWA（HTML / CSS / ES modules、ビルド無し）+ Cloudflare Pages の `_worker.js`。ローカルは `serve.py` |
| データ | GitHub Issues（`takinai-koki-pra/tasks`）。列・ラベル・本文メタ・コメントの規則は `docs/data-model.md` |
| 画面 | 2 ペイン + 右パネル。起動画面は受信箱。`docs/mock/final-mock.html` の 4 状態 |
| 書体 | Inter（見出しは opsz 32）+ Noto Sans JP。Google Fonts から配信 |
| アイコン | Phosphor Light。**SVG をリポジトリに同梱**する（CDN 依存にしない。使う 30 個程度だけ `icons/phosphor/` に置く） |
| 配色 | `docs/mock/color-sample.html` の **B（黒アクセント）**。無彩色 + 意味色 4 つ（赤・琥珀・紫・黒） |
| キー | Windows 前提。`Ctrl` と単キー。`Ctrl+N` `Ctrl+T` `Ctrl+W` は使わない。IME 変換中は単キーを無視 |
| AI | Gemini は提案だけ（JSON）。適用はボードのコード。エージェントとのやり取りは `指示:` `着手:` `報告:` の 3 種のコメントとラベルだけ |
| 作らないもの | チャット窓、カレンダー連携、所要時間の見積、Projects v2、親子 Issue、優先度の段階 |

## 1. 成果物

既存ファイルを置き換える形で進める。ファイル構成は次に揃える。

```
index.html            画面（2 ペイン + 右パネル + パレット + トースト）
style.css             配色 B のトークン、行・ピル・チップ・パレットの部品
app.js                起動、状態、キー操作、ビュー切替
views/inbox.js        受信箱（対応必須 / その他）、行の描画
views/list.js         今日 / 相手待ち / エージェント / 後で / 案件（同じ行部品）
views/board.js        ボード（4 列、ドラッグ）
panel.js              右パネル（プロパティ、履歴、指示欄、報告の承認 / 差し戻し）
palette.js            Ctrl+K（コマンド検索 + 文の解釈）
model.js              Issue ⇔ タスクの変換。task ブロックのパーサ、ラベル名前空間、派生ビューの条件
undo.js               直前の変更の逆操作を積む。トースト
api.js                GitHub REST（既存）+ コメント取得 / 投稿
ai.js                 Gemini 呼び出しのクライアント側（/ai/* を叩く）
_worker.js            /gh/* 転送、/ai/tasks、/ai/instruct、/ai/interpret、/ai/triage
serve.py              同上のローカル版
icons/phosphor/*.svg  使うアイコンだけ
docs/                 設計・モック（変更しない）
```

## 2. マイルストーン

各マイルストーンは「動く状態」で終える。順番は入れ替えない。

### M1. 部品と書体・アイコン・配色

- `style.css` を配色 B のトークンで書き直す。既存の暖色・角丸 10px 以上・影は捨てる
- 行部品 `.row`（22px の丸、タイトル、`#タグ`、補助行、右端の期限 / 進捗）を 1 種類に統一。受信箱・一覧・ボードで共用
- ピル、チップ（差分表示用: `old → new`）、`kbd`、トースト、パレットの見た目
- Phosphor Light の SVG を同梱し、`<i data-icon="circle">` で差し込むローダーを `app.js` に置く

完了判定: `?demo=1` で今のボードが新しい部品で崩れず表示される。Windows の Edge で Inter と Noto Sans JP が当たっている。

### M2. モデルとパーサ

- `model.js`: Issue → タスク（列、案件、次に動く主体、優先、ctx、due、wake、source[]、チェックリスト進捗、最新コメント）。逆方向（変更 → PATCH の labels / state / body）
- `task` ブロックのパーサ（`docs/data-model.md` 第 5 節）。無い場合は空。未知のキーは保持して書き戻す
- 派生ビューの条件（第 6 節）を純関数で。Today / 相手待ち / エージェント / 後で / 期限切れ / 受信箱（`status:*` 無し かつ 起票から未仕分け、または `報告:` が最新コメント）
- ラベルの自動作成（`status:` `client:` `priority:` `ctx:` `waiting` `agent` `agent:claude` `agent:codex` `agent:local`）を接続時に行う。色は第 4 節

完了判定: モデルの単体テスト（Node で `node --test`）が通る。`demo-data.json` を新モデルの形（task ブロック、コメント）に更新する。

### M3. 受信箱と右パネル、キー操作

- サイドバー（受信箱 / 今日 / 相手待ち / エージェント / 後で / ボード、案件、環境）に件数
- 受信箱: 「対応必須」→「その他」を 1 本のリストで並べる（タブにしない。空のタブが起動画面になるのを避けるため）。各グループの中はソース別（Slack / 貼り付け / エージェント）のセクション。行は 38px
- 右パネル: 選択行の詳細（引用 = source の抜粋があれば、プロパティ、履歴）。プロパティはクリックでポップオーバー編集（期限 / 再表示はカレンダー、案件は選択、次に動くは 3 択）
- キー: `J` `K` `↑` `↓` 移動、`Enter` 右パネルにフォーカス、`1` 今日（`status:todo`）、`2` 後で（`wake` +7 日、Backlog）、`3` 相手待ち、`4` エージェント（振り分けは M5 まではラベル `agent` のみ）、`E` 完了、`/` 検索、`B` ボード、`G T` 今日ビューへ、`N` 新規行、`Esc` 戻る
- 下部のステータス行に現在使えるキーを表示
- 変更はすべて楽観的更新 + 失敗時ロールバック（既存の `mutate` を流用）

完了判定: マウスなしで、受信箱の 7 件を仕分けて空にできる。

### M4. 入力行と Undo

- `N` で一覧先頭に入力行。「金曜」「来週」「9/19」「#dbj」「!」をクライアント側で解釈してヒント行に出す（Gemini は使わない）。`Enter` で作成、続けて入力
- `undo.js`: 直前 10 件の逆操作。完了 / 列移動 / wake / waiting / 削除相当（not_planned）を対象。トーストに「元に戻す `Ctrl+Z`」、8 秒で消える
- 確認ダイアログは 1 つも出さない

完了判定: 完了 → `Ctrl+Z` で GitHub 上も元に戻る。

### M5. 指示欄（Gemini → 差分チップ → 適用）

- `_worker.js` / `serve.py` に `/ai/instruct` を追加。入力: 指示文 + 対象タスクの現在値（title, labels, task メタ, 直近コメント 3 件）。出力スキーマ:

```json
{
  "changes": [{ "field": "next|due|wake|title|client|priority|column", "from": "…", "to": "…" }],
  "agent_requests": [{ "text": "転送メールの下書きを作る", "route": "claude|codex|local" }],
  "note": "1 行の補足（無ければ空）"
}
```

- 右パネル下の指示欄（`I`）。送信すると「こう変えます」をチップで表示し、上のプロパティにも `old → new` を先に映す。`Enter` で適用、チップは個別に外せる、`Esc` で破棄
- 適用時: 属性を PATCH、`指示: <原文> → <適用した変更の要約>` をコメントに 1 行、`agent_requests` があれば `agent:<route>` を付けて `指示:` コメントに依頼文を書く
- 適用は Undo の対象（エージェント依頼の取り消しは `指示: 取り消し` コメント + ラベル除去）

完了判定: モックの 1 枚目と同じ操作が実データで通り、Issue のコメントに 1 行残る。

### M6. Ctrl+K

- 1 つの入力。単語ならコマンド検索（移動、ビュー切替、選択中タスクへの操作、タスク検索）。文（12 文字以上で助詞を含む、または末尾が「て」「で」「して」）なら `/ai/interpret` に投げて提案を出す
- 提案は `proposals[]`（kind: create / change / route）。それぞれチップで内容を見せ、`Enter` で実行。実行後は受信箱に反映
- 会話は続かない。パレットは閉じる

完了判定: 「田中さんの昨日のメッセージからタスク拾って」は範囲外（Slack 取得はエージェント側）。代わりに「これを来週の金曜までに」「DBJ の案件で今日やる」のような選択中タスクへの文が通ればよい。

### M7. エージェント報告の承認 / 差し戻し

- 受信箱の「エージェントから」セクション: 最新コメントが `報告:` の Issue
- 右パネルに報告の本文（Markdown 描画）、`Y` 承認（`次に動く: 自分`、受信箱から外す）、`R` 差し戻し（指示欄にフォーカス → `指示:` コメント + `agent:*` 再付与）
- `着手:` コメントにセッション URL があれば「Claude で開く ↗」を出す

完了判定: 手で `報告:` コメントを書いた Issue が受信箱に出て、`Y` / `R` が動く。

### M8. ランナー（ボードの外。別作業でよい）

- `agent:local`: Agent Ops に `AgentOps-Tick-Board` を追加。`agent:local` の open Issue を拾い、最新の `指示:` を読んで `claude -p`（または `codex exec`）を該当リポで実行、`着手:` → `報告:` を書き、ラベルを外す。lock / stop.flag / run_log は既存 tick と同じ
- `agent:claude`: Claude Code のルーチンを 1 本作り、`tasks` リポの `labeled` イベント（`agent:claude`）で起動。ルーチンの手順は「`着手:`（セッション URL 付き）→ 作業 → `報告:` → ラベル除去」
- `agent:codex`: Worker が `@codex` を含むコメントを投稿するだけ（Codex 側の不具合が解消するまで保留可）

完了判定: それぞれ 1 件、往復が通る。

## 3. 作業のルール

- 既存の `docs/` は変更しない（モックは参照物）。設計の変更が必要になったら `docs/data-model.md` を先に直し、コミットメッセージに理由を書く
- 各マイルストーンごとにコミットし、`wrangler pages deploy` で本番に出す（secret は登録済み。`README.md` の手順）
- Gemini のプロンプトとスキーマは `_worker.js` と `serve.py` で同一にする（片方だけ直さない）
- 秘密情報は 1Password から `op read` で流し込む。値をファイルやログに出さない
- iPhone 幅で致命的に崩れていないかだけ、M3 と M7 の後に確認する（横スクロールで受信箱が使える程度でよい）

## 4. 検証の手順

```bash
# ローカル（gh CLI 認証 + Gemini は環境変数）
python serve.py
# デモデータ
http://127.0.0.1:8790/?demo=1
# モデルの単体テスト
node --test tests/
# 本番
wrangler pages deploy . --project-name gh-task-board --commit-dirty=true
```

本番の確認は `https://gh-task-board.pages.dev/`（Cloudflare Access の GitHub ログイン）。

## 5. 参照

- 設計: `docs/data-model.md`
- 最終モック: `docs/mock/final-mock.html`（4 状態）
- 部品の見た目: `docs/mock/pc-mock.html`（展開行・入力行・トースト・パレット）、`docs/mock/type-sample.html`、`docs/mock/icon-sample.html`、`docs/mock/color-sample.html`
- 4 つの型の比較（なぜこの形か）: `docs/mock/types-mock.html`
- 運用: `README.md`
