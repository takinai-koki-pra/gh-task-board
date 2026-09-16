"""PC 用のローカル起動スクリプト。

  python serve.py [owner/repo] [port]

静的ファイルを配信しつつ、/gh/... への呼び出しを api.github.com に転送する。
認証には `gh auth token`（GitHub CLI のログイン）を使うので、ブラウザにトークンを貼る必要が無い。
「まとめて追加」の整形は Gemini API（環境変数 GEMINI_API_KEY、または GEMINI_API_KEY_OP=op://... を 1Password CLI で解決）。
"""
import json
import os
import shutil
import subprocess
import sys
import time
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
実行すべきタスクを抽出してください。

ルール:
- title は 40 字以内の自然な日本語で、動詞で終える（例: 「山田さんに NDA を返送する」）
- 重複や言い換えは 1 つにまとめる
- 挨拶・雑談・単なる事実の記述はタスクにしない
- 期日・締切・リンク・補足は title ではなく body に書く（無ければ空文字）
- 今すぐ着手すべきものは column を "todo"、いつかやる・検討中は "backlog"
- 何も抽出できなければ空配列

--- テキスト ---
"""

GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.8-flash")
GEMINI_SCHEMA = {
    "type": "ARRAY",
    "items": {
        "type": "OBJECT",
        "properties": {
            "title": {"type": "STRING"},
            "body": {"type": "STRING"},
            "column": {"type": "STRING", "enum": ["todo", "backlog"]},
        },
        "required": ["title", "body", "column"],
    },
}


def gemini_key() -> str:
    """GEMINI_API_KEY を環境変数から読む。無ければ GEMINI_API_KEY_OP（op:// 参照）を 1Password CLI で解決する。"""
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if key:
        return key
    ref = os.environ.get("GEMINI_API_KEY_OP", "").strip()
    if ref and shutil.which("op"):
        out = subprocess.run(["op", "read", ref], capture_output=True, text=True)
        if out.returncode == 0:
            return out.stdout.strip()
    return ""


GEMINI_KEY = gemini_key()


def ai_tasks(text: str):
    """Gemini API でテキストをタスク配列に変換する（JSON スキーマ指定）。"""
    if not GEMINI_KEY:
        raise RuntimeError("GEMINI_API_KEY が設定されていません")
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"
    payload = {
        "contents": [{"role": "user", "parts": [{"text": AI_PROMPT + text}]}],
        "generationConfig": {"responseMimeType": "application/json", "responseSchema": GEMINI_SCHEMA, "temperature": 0.2},
    }
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(), method="POST",
        headers={"Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY},
    )
    data = None
    for attempt in range(3):  # 429 / 503（混雑）は少し待って再試行
        try:
            with urllib.request.urlopen(req, timeout=60) as res:
                data = json.loads(res.read())
            break
        except urllib.error.HTTPError as e:
            try:
                msg = json.loads(e.read()).get("error", {}).get("message", "")
            except Exception:  # noqa: BLE001
                msg = ""
            if e.code in (429, 503) and attempt < 2:
                time.sleep(2 * (attempt + 1))
                continue
            raise RuntimeError(f"Gemini API {e.code}: {msg or e.reason}") from None
    parts = data.get("candidates", [{}])[0].get("content", {}).get("parts", [])
    raw = "".join(p.get("text", "") for p in parts)
    tasks = json.loads(raw or "[]")
    return [
        {"title": str(t.get("title", "")).strip()[:120], "body": str(t.get("body", "")).strip(),
         "column": t.get("column") if t.get("column") in ("todo", "backlog") else "todo"}
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
            return self._json(200, {"repo": REPO, "ai": bool(GEMINI_KEY)})
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
    print(f"Task Board: {url}  (repo: {REPO})  AI: {'Gemini ' + GEMINI_MODEL if GEMINI_KEY else 'off (GEMINI_API_KEY 未設定)'}  Ctrl+C で終了")
    webbrowser.open(url)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
