# Task Board

GitHub Issues をカンバンで操作する個人用タスクボード。Web と iOS（PWA・ホーム画面追加）で動く。
ビルド不要の静的サイト（HTML / CSS / ES modules）で、ブラウザから GitHub REST API を直接呼ぶ。バックエンドは無い。

## 仕組み

| 列 | GitHub 上の状態 |
|---|---|
| Backlog | open で status ラベル無し |
| Todo | open + `status:todo` |
| Doing | open + `status:doing` |
| Done | closed |

- カードを別の列にドラッグ（PC: そのまま、iOS: 長押ししてから移動）すると、ラベルの付け替えと open/closed の切り替えを行う
- カードをタップすると詳細（タイトル・本文・列）を編集できる
- `status:*` 以外のラベルはカードにチップ表示する（付け外しは GitHub 側で行う）
- 直近の Issue 一覧は端末内にキャッシュし、起動直後はキャッシュを表示してから更新する
- カード右上の ✓ でワンクリック完了（完了済みなら Todo に戻す）
- キーボード: `/` で入力欄へ、カードにフォーカスして `←` `→` で列移動、`Enter` で詳細
- **まとめて追加**: 入力欄に複数行を貼る（または「まとめて」ボタン）と、テキストをタスクに分解して一括登録できる
  - PC（`serve.py`）では Gemini が整理する: 重複をまとめ、動詞で終わる短いタイトルに書き換え、期日などは本文へ
  - Gemini が使えない環境（公開版、キー未設定）では行ごとに分割し、箇条書き記号や番号を取り除く

## セットアップ

1. タスク用のリポジトリを用意する（private 推奨）
2. Fine-grained personal access token を発行する
   - GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens
   - Repository access: 上記リポジトリのみ
   - Permissions: **Issues: Read and write**（Metadata は自動で Read-only が付く）
3. アプリを開き、右上の歯車から `owner/repo` とトークンを入力して「接続して保存」
   - 初回接続時に `status:todo` / `status:doing` ラベルを自動作成する
   - トークンは `localStorage` にのみ保存され、GitHub 以外には送信しない

## iOS で使う

Safari でアプリの URL を開き、共有メニュー →「ホーム画面に追加」。スタンドアロン表示になり、アプリのように起動できる。

## PC で動かす（トークン不要）

GitHub CLI（`gh auth login` 済み）があれば、トークンを貼らずにそのまま使える。

```bash
python serve.py
```

ブラウザが `http://127.0.0.1:8790/` で開く。既定のリポジトリは `takinai-koki-pra/tasks`。変えるときは `python serve.py owner/repo`。
`serve.py` は静的ファイル配信に加え、`/gh/...` を `gh auth token` 付きで api.github.com へ転送する。
「まとめて追加」の整形には Gemini API（既定 `gemini-3.8-flash`、`GEMINI_MODEL` で変更可）を使う。キーは次のどちらかで渡す。

- 環境変数 `GEMINI_API_KEY`
- 1Password に入れている場合: `GEMINI_API_KEY_OP=op://<vault>/<item>/<field>` を設定しておくと起動時に `op read` で解決する。
  または `op run --env-file .env -- python serve.py`（`.env` に `GEMINI_API_KEY=op://...`）でもよい

`?demo=1` を付けるとサンプルデータで動作確認できる（GitHub には書き込まない）。

## 本番運用（Cloudflare Pages + Access）

PC も iPhone も同じ URL を開くだけで使える構成。`_worker.js` が `serve.py` と同じ 3 つの役割を担う。

| パス | 役割 |
|---|---|
| `/__config` | アプリに「プロキシ経由で繋げる」ことを伝える（repo 名、Gemini の有無） |
| `/gh/*` | GitHub API へ転送。`TASKS_REPO` 配下のパスだけ許可。トークンは secret |
| `/ai/tasks` | Gemini でテキストをタスクに整形 |
| それ以外 | 静的ファイル |

認証は Cloudflare Access（GitHub ログイン、自分のメールアドレスだけ許可）に任せる。アプリ側にはログイン処理を持たない。

### 初回デプロイ

```bash
wrangler login
wrangler pages project create gh-task-board --production-branch main
wrangler pages deploy . --project-name gh-task-board --commit-dirty=true
```

### secret の登録（値は画面に出さない）

```bash
# tasks リポの Issues: Read and write だけを持つ fine-grained PAT
op read "op://<vault>/<item>/<field>" | wrangler pages secret put GITHUB_TOKEN --project-name gh-task-board
# Gemini API キー
op read "op://<vault>/<item>/<field>" | wrangler pages secret put GEMINI_API_KEY --project-name gh-task-board
```

`TASKS_REPO` と `GEMINI_MODEL` は `wrangler.toml` の `[vars]` にある。

### Access（GitHub ログインで自分だけに制限）

wrangler は Zero Trust を扱えないので Cloudflare API（またはダッシュボード）で設定する。
Application のドメインは `gh-task-board.pages.dev`、Policy は自分のメールアドレス 1 件の allow、
IdP は GitHub のみ。セッション期間を長め（例: 720h）にすると iPhone で毎回ログインせずに済む。

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
index.html            画面
style.css             スタイル（ライト / ダーク）
app.js                状態管理・描画・ドラッグ&ドロップ・ダイアログ
api.js                GitHub REST API ラッパー（+ デモ用のメモリ実装）
_worker.js            Cloudflare Pages Functions（GitHub 代行・Gemini 整形）
wrangler.toml         Pages 設定（vars。secret は含めない）
serve.py              PC ローカル用サーバー（同じ役割を Python で）
sw.js                 Service Worker（アプリシェルのキャッシュ）
manifest.webmanifest  PWA マニフェスト
icons/                アイコン
demo-data.json        デモモード用データ
```

## 今後の拡張候補

- GitHub Projects v2 の Status フィールドと同期（GraphQL）
- 複数リポジトリの横断ビュー
- 期限（due）や優先度ラベルの入力 UI
