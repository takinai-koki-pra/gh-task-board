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
- キーボード: カードにフォーカスして `←` `→` で列移動、`Enter` で詳細

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

## ローカルで動かす

```bash
python -m http.server 8787
```

`http://127.0.0.1:8787/` を開く。`?demo=1` を付けるとサンプルデータで動作確認できる（GitHub には書き込まない）。

## デプロイ

静的ファイルをそのまま置けばよい。Cloudflare Pages / GitHub Pages のどちらでも動く。

- Cloudflare Pages: このディレクトリをそのままアップロード（ビルドコマンド無し、出力ディレクトリ `/`）
- GitHub Pages: リポジトリの root を公開

URL は自分だけが知っていればよいが、アプリ自体には秘密情報を含まないので公開されても実害は無い（トークンは各端末のブラウザ内にしか無い）。

## ファイル構成

```
index.html            画面
style.css             スタイル（ライト / ダーク）
app.js                状態管理・描画・ドラッグ&ドロップ・ダイアログ
api.js                GitHub REST API ラッパー（+ デモ用のメモリ実装）
sw.js                 Service Worker（アプリシェルのキャッシュ）
manifest.webmanifest  PWA マニフェスト
icons/                アイコン
demo-data.json        デモモード用データ
```

## 今後の拡張候補

- GitHub Projects v2 の Status フィールドと同期（GraphQL）
- 複数リポジトリの横断ビュー
- 期限（due）や優先度ラベルの入力 UI
