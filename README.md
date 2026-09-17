# Task Board

GitHub Issues をカンバンで操作する個人用タスクボード。Web と iOS（PWA・ホーム画面追加）で動く。
ビルド不要の静的サイト（HTML / CSS / ES modules）で、ブラウザから GitHub REST API を直接呼ぶ。バックエンドは無い。

## 設計

データモデルと設計思想は [docs/data-model.md](docs/data-model.md) にまとめている。
タスク = 1 Issue、列は `status:*` ラベル、案件・優先度・次に動く主体はラベルの名前空間、期限・再浮上日・元の文脈は本文先頭の `task` ブロック、履歴はコメント。UI はこの文書に従属する。

v2（PC 版・受信箱 + AI への指示）の実装指示書は [docs/implementation-plan.md](docs/implementation-plan.md)、最終モックは [docs/mock/final-mock.html](docs/mock/final-mock.html)。

## 画面と操作（v2）

PC 優先の 2 ペイン + 右パネル。起動画面は受信箱。

| ビュー | 出るもの |
|---|---|
| 受信箱 | 列も再表示日も無い未仕分けの Issue と、最新コメントが `報告:` の Issue。「対応必須 / その他」は Gemini の判定（無ければ期限・優先の規則） |
| 今日 | 期限切れ / Doing / 今日やる（`status:todo`・期限が今日以前・優先）。相手待ちとエージェント行きは出さない |
| 相手待ち / エージェント / 後で | `waiting` / `agent*` / 再表示日が未来 |
| ボード | Backlog / Todo / Doing / Done の 4 列。ドラッグか `←` `→` で列移動 |
| 案件・環境 | `client:*` / `ctx:*` ごと |

| キー | 動作 |
|---|---|
| `J` `K` `↑` `↓` | 移動 |
| `1` `2` `3` `4` | 今日（Todo）/ 後で（+7 日）/ 相手待ち / エージェント |
| `E` / `Delete` | 完了 / やらない（not_planned） |
| `I` | 右パネルの指示欄。自然文を送ると Gemini が差分をチップで返し、`Enter` で適用 |
| `Y` / `R` | エージェント報告の承認 / 差し戻し |
| `N` | 一覧の先頭に入力行（「金曜」「9/19」「来週」→ 期限、`#dbj` → 案件、`!` → 優先） |
| `Ctrl+K` | コマンド・タスク検索。文を打つと Gemini が操作を提案 |
| `Ctrl+Z` | 直前の変更を元に戻す（10 件まで） |
| `/` `B` `G`+`T/I/W/A/L/B` `Tab` `Esc` | 絞り込み / ボード / ビュー移動 / 受信箱のタブ / 戻る |

- 変更は楽観的に反映し、失敗したら戻す。確認ダイアログは出さない
- 指示を適用すると `指示: 「原文」 → 変更の要約` を Issue に 1 行残す。エージェントへの依頼は `agent:<route>` を付けて `指示: 依頼文（agent:<route>）` を書く
- 複数行を入力行に貼るか「まとめて」ボタンで、テキストをタスクに分解して取り込む
- 狭い画面（iPhone）ではサイドバーと詳細が重なって出て、詳細の上部に仕分けボタンが付く

## セットアップ

1. タスク用のリポジトリを用意する（private 推奨）
2. Fine-grained personal access token を発行する
   - GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens
   - Repository access: 上記リポジトリのみ
   - Permissions: **Issues: Read and write**（Metadata は自動で Read-only が付く）
3. アプリを開き、右上の歯車から `owner/repo` とトークンを入力して「接続して保存」
   - 初回接続時に `status:*` `priority:high` `waiting` `agent` `agent:*` ラベルを自動作成する（`client:*` `ctx:*` は使った時に作る）
   - トークンは `localStorage` にのみ保存され、GitHub 以外には送信しない

## iOS で使う

Safari でアプリの URL を開き、共有メニュー →「ホーム画面に追加」。スタンドアロン表示になり、アプリのように起動できる。

## PC で動かす（トークン不要）

GitHub CLI（`gh auth login` 済み）があれば、トークンを貼らずにそのまま使える。

```bash
python serve.py
```

ブラウザが `http://127.0.0.1:8790/` で開く（`--no-browser` で開かない）。既定のリポジトリは `takinai-koki-pra/tasks`。変えるときは `python serve.py owner/repo`。
`serve.py` は静的ファイル配信に加え、`/gh/...` を `gh auth token` 付きで api.github.com へ転送する。
指示欄・`Ctrl+K`・受信箱の振り分け・「まとめて追加」には Gemini API（既定 `gemini-3.8-flash`、`GEMINI_MODEL` で変更可）を使う。プロンプトとスキーマは `ai-spec.json` にあり、`serve.py` と `_worker.js` が同じものを読む。キーは次のどちらかで渡す。

- 環境変数 `GEMINI_API_KEY`
- 1Password に入れている場合: `GEMINI_API_KEY_OP=op://<vault>/<item>/<field>` を設定しておくと起動時に `op read` で解決する。
  または `op run --env-file .env -- python serve.py`（`.env` に `GEMINI_API_KEY=op://...`）でもよい

`?demo=1` を付けるとサンプルデータで動作確認できる（GitHub には書き込まない。AI は規則ベースの疑似応答）。

## 本番運用（Cloudflare Pages + Access）

PC も iPhone も同じ URL を開くだけで使える構成。`_worker.js` が `serve.py` と同じ 3 つの役割を担う。

| パス | 役割 |
|---|---|
| `/__config` | アプリに「プロキシ経由で繋げる」ことを伝える（repo 名、Gemini の有無） |
| `/gh/*` | GitHub API へ転送。`TASKS_REPO` 配下のパスだけ許可。トークンは secret |
| `/ai/tasks` `/ai/instruct` `/ai/interpret` `/ai/triage` | Gemini に提案を JSON で出させる（`ai-spec.json`） |
| それ以外 | 静的ファイル |

認証は Cloudflare Access（GitHub ログイン、自分のメールアドレスだけ許可）に任せる。アプリ側にはログイン処理を持たない。

### 初回デプロイ

```bash
wrangler login
wrangler pages project create gh-task-board --production-branch main
wrangler pages deploy . --project-name gh-task-board --commit-dirty=true
```

### secret の登録（値は画面に出さない）

秘密の値は 1Password（vault `個人API Key`）を正本にし、`op read` で流し込む。vault 名に日本語が含まれると
`op://` 参照に使えないので、vault は ID（`khhtmawmi6te3i64k3s34jne44`）で指定する。

| 項目 | 1Password のタイトル | 用途 |
|---|---|---|
| `gh-task-board` | fine-grained PAT（`takinai-koki-pra/tasks` のみ、Issues: Read and write） | Worker の `GITHUB_TOKEN` |
| `Gemini API` | Gemini API キー | Worker の `GEMINI_API_KEY` |
| `ai-agent-access` | Cloudflare API トークン（Access 編集・Pages 編集） | Access 設定・CI 用 |

```bash
op read "op://khhtmawmi6te3i64k3s34jne44/gh-task-board/credential" | wrangler pages secret put GITHUB_TOKEN --project-name gh-task-board
op read "op://khhtmawmi6te3i64k3s34jne44/Gemini API/credential"     | wrangler pages secret put GEMINI_API_KEY --project-name gh-task-board
```

secret は **次のデプロイから有効**になるので、登録後に `wrangler pages deploy` を一度実行する。
`TASKS_REPO` と `GEMINI_MODEL` は `wrangler.toml` の `[vars]` にある。

### Access（GitHub ログインで自分だけに制限）

wrangler は Zero Trust を扱えないので Cloudflare API で設定した（トークンは `ai-agent-access`）。

- Application「Task Board」: `gh-task-board.pages.dev` と `*.gh-task-board.pages.dev`（プレビュー URL も保護）
- Policy `gh-task-board-owner`: allow = 自分のメールアドレス 1 件、require = GitHub IdP でのログイン
- IdP は既存の GitHub のみ、自動リダイレクト、セッション 720h（iPhone で毎回ログインしないため）

### 更新

```bash
wrangler pages deploy . --project-name gh-task-board --commit-dirty=true
```

secret は保持される。

### 開発・オフライン用

`python serve.py` はそのまま残している（gh CLI の認証、Gemini は環境変数）。
GitHub Pages 版（PAT をブラウザに入れる方式）はプロキシが無い環境向けのフォールバックとして動く。

## ファイル構成

```
index.html            画面（2 ペイン + 右パネル + パレット + トースト）
style.css             配色 B のトークンと部品（行・ピル・チップ・パレット）。ライト / ダーク
app.js                起動、状態、描画の振り分け、操作（楽観的更新 + Undo）、キー操作
views/inbox.js        受信箱
views/list.js         今日 / 相手待ち / エージェント / 後で / 案件 / 環境
views/board.js        ボード（4 列、ドラッグ）
panel.js              右パネル（プロパティ、履歴、報告の承認 / 差し戻し、指示欄、ポップオーバー）
palette.js            Ctrl+K
model.js              Issue ⇔ タスクの変換、task ブロックのパーサ、派生ビュー（DOM 非依存）
ui.js                 アイコン読み込み、エスケープ、簡易 Markdown、行部品
undo.js               Undo スタックとトースト
intake.js             まとめて追加
api.js                GitHub REST（Issues・コメント・ラベル）+ デモ用のメモリ実装
ai.js                 /ai/* のクライアントと提案の正規化、デモ用の疑似応答
ai-spec.json          Gemini のプロンプトとスキーマ（serve.py と _worker.js で共有）
_worker.js            Cloudflare Pages Functions（GitHub 代行・Gemini）
serve.py              PC ローカル用サーバー（同じ役割を Python で）
tests/                node --test（model・worker）
sw.js                 Service Worker（アプリシェルのキャッシュ）
icons/phosphor/       Phosphor Light（使う分だけ同梱、MIT）
demo-data.json        デモモード用データ（日付は起動日からの相対指定）
```

テストは `npm test`（Node 22 以上、依存パッケージなし）。

## 今後の拡張候補

- GitHub Projects v2 の Status フィールドと同期（GraphQL）
- 複数リポジトリの横断ビュー
