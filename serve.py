"""PC 用のローカル起動スクリプト。

  python serve.py [owner/repo] [port]

静的ファイルを配信しつつ、/gh/... への呼び出しを api.github.com に転送する。
認証には `gh auth token`（GitHub CLI のログイン）を使うので、ブラウザにトークンを貼る必要が無い。
"""
import json
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

REPO = sys.argv[1] if len(sys.argv) > 1 else "takinai-koki-pra/tasks"
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8790
API = "https://api.github.com"


def gh_token() -> str:
    try:
        out = subprocess.run(["gh", "auth", "token"], capture_output=True, text=True, check=True)
        return out.stdout.strip()
    except Exception as e:  # noqa: BLE001
        sys.exit(f"gh auth token に失敗しました。`gh auth login` 済みか確認してください: {e}")


TOKEN = gh_token()

AI_PROMPT = """あなたはタスク整理アシスタントです。ユーザーが貼り付けたテキスト（メモ・メール・議事録・箇条書きなど）から、
実行すべきタスクを抽出し、JSON 配列だけを出力してください。説明文やコードフェンスは不要です。

各要素の形式:
{"title": "40字以内・動詞で終わる日本語のタスク名", "body": "補足（元テキストの関連部分・期日・リンク。無ければ空文字）", "column": "todo" または "backlog"}

ルール:
- 重複や言い換えは 1 つにまとめる
- 挨拶・雑談・単なる事実の記述はタスクにしない
- 期日や締切が明示されていれば title の末尾ではなく body に書く
- 今すぐ着手すべきものは "todo"、いつかやる・検討中は "backlog"
- 何も抽出できなければ []

--- テキスト ---
"""


def ai_tasks(text: str):
    """claude CLI（Claude Code のログイン）でテキストをタスク配列に変換する。"""
    exe = shutil.which("claude") or "claude"
    cmd = [exe, "-p", "--output-format", "json", "--model", "haiku"]
    # プロンプトは stdin で渡す（Windows の引数エンコーディング問題を避ける）
    out = subprocess.run(cmd, input=AI_PROMPT + text, capture_output=True, text=True, encoding="utf-8", timeout=90)
    if out.returncode != 0 and not out.stdout.strip():
        raise RuntimeError(out.stderr.strip() or "claude CLI の起動に失敗しました")
    res = json.loads(out.stdout)
    if res.get("is_error"):
        raise RuntimeError(res.get("result") or "claude CLI がエラーを返しました")
    body = res.get("result", "")
    m = re.search(r"\[.*\]", body, re.S)
    tasks = json.loads(m.group(0) if m else body)
    return [
        {"title": str(t.get("title", "")).strip()[:120], "body": str(t.get("body", "")).strip(), "column": t.get("column") if t.get("column") in ("todo", "backlog", "doing") else "todo"}
        for t in tasks if isinstance(t, dict) and str(t.get("title", "")).strip()
    ]


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):  # 静かに
        if self.path.startswith("/gh/"):
            super().log_message(fmt, *args)

    def _json(self, code: int, obj) -> None:
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _proxy(self) -> None:
        length = int(self.headers.get("Content-Length") or 0)
        data = self.rfile.read(length) if length else None
        req = urllib.request.Request(
            API + self.path[len("/gh"):],
            data=data,
            method=self.command,
            headers={
                "Accept": "application/vnd.github+json",
                "Authorization": f"Bearer {TOKEN}",
                "X-GitHub-Api-Version": "2022-11-28",
                "User-Agent": "gh-task-board-local",
                **({"Content-Type": "application/json"} if data else {}),
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as res:
                body = res.read()
                self.send_response(res.status)
                for k in ("Content-Type", "Link"):
                    if res.headers.get(k):
                        self.send_header(k, res.headers[k])
        except urllib.error.HTTPError as e:
            body = e.read()
            self.send_response(e.code)
            self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/__local":
            return self._json(200, {"repo": REPO, "ai": True})
        if self.path.startswith("/gh/"):
            return self._proxy()
        return super().do_GET()

    def do_POST(self):
        if self.path == "/ai/tasks":
            length = int(self.headers.get("Content-Length") or 0)
            try:
                text = json.loads(self.rfile.read(length) or b"{}").get("text", "")
                return self._json(200, {"tasks": ai_tasks(text)})
            except Exception as e:  # noqa: BLE001
                return self._json(502, {"message": str(e)})
        return self._proxy() if self.path.startswith("/gh/") else self.send_error(404)

    def do_PATCH(self):
        return self._proxy() if self.path.startswith("/gh/") else self.send_error(404)


if __name__ == "__main__":
    url = f"http://127.0.0.1:{PORT}/"
    print(f"Task Board: {url}  (repo: {REPO})  Ctrl+C で終了")
    webbrowser.open(url)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
