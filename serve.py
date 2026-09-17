"""PC 用のローカル起動スクリプト（_worker.js と同じ役割）。

  python serve.py [owner/repo] [port] [--no-browser]

静的ファイルを配信しつつ、/gh/... への呼び出しを api.github.com に転送する。
認証には `gh auth token`（GitHub CLI のログイン）を使うので、ブラウザにトークンを貼る必要が無い。
/ai/<kind>（tasks / instruct / interpret / triage）は Gemini API に提案を JSON で出させる。
プロンプトとスキーマは ai-spec.json（_worker.js と共有）。
キーは環境変数 GEMINI_API_KEY、または GEMINI_API_KEY_OP=op://... を 1Password CLI で解決する。
"""
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
NO_BROWSER = "--no-browser" in sys.argv or bool(os.environ.get("NO_BROWSER"))
REPO = ARGS[0] if len(ARGS) > 0 else "takinai-koki-pra/tasks"
PORT = int(ARGS[1]) if len(ARGS) > 1 else 8790
API = "https://api.github.com"
AI_KINDS = ("tasks", "instruct", "interpret", "triage")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.8-flash")


def gh_token() -> str:
    try:
        out = subprocess.run(["gh", "auth", "token"], capture_output=True, text=True, check=True)
        return out.stdout.strip()
    except Exception as e:  # noqa: BLE001
        sys.exit(f"gh auth token に失敗しました。`gh auth login` 済みか確認してください: {e}")


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


TOKEN = ""
GEMINI_KEY = ""


def call_gemini(kind: str, payload_input) -> dict:
    """ai-spec.json の kind のプロンプトとスキーマで Gemini を呼び、JSON を返す。"""
    if not GEMINI_KEY:
        raise RuntimeError("GEMINI_API_KEY が設定されていません")
    spec = json.loads((ROOT / "ai-spec.json").read_text(encoding="utf-8"))["endpoints"][kind]
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"
    # JSON.stringify と同じ形（空白なし・非 ASCII はそのまま）
    text = spec["prompt"] + json.dumps(payload_input, ensure_ascii=False, separators=(",", ":"))
    payload = {
        "contents": [{"role": "user", "parts": [{"text": text}]}],
        "generationConfig": {"responseMimeType": "application/json", "responseSchema": spec["schema"], "temperature": 0.2},
    }
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(), method="POST",
        headers={"Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY},
    )
    for attempt in range(3):  # 429 / 503（混雑）は少し待って再試行
        try:
            with urllib.request.urlopen(req, timeout=60) as res:
                data = json.loads(res.read())
            parts = data.get("candidates", [{}])[0].get("content", {}).get("parts", [])
            return json.loads("".join(p.get("text", "") for p in parts) or "{}")
        except urllib.error.HTTPError as e:
            try:
                msg = json.loads(e.read()).get("error", {}).get("message", "")
            except Exception:  # noqa: BLE001
                msg = ""
            if e.code in (429, 503) and attempt < 2:
                time.sleep(2 * (attempt + 1))
                continue
            raise RuntimeError(f"Gemini API {e.code}: {msg or e.reason}") from None
    raise RuntimeError("Gemini API: 再試行の上限")


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt, *args):  # 静かに
        if self.path.startswith(("/gh/", "/ai/")):
            super().log_message(fmt, *args)

    def end_headers(self):
        if not self.path.startswith(("/gh/", "/ai/", "/__config")):
            self.send_header("Cache-Control", "no-cache")  # 開発中は常に再検証
        super().end_headers()

    def _json(self, code: int, obj) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
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

    def _allowed(self) -> bool:
        path = self.path[len("/gh"):].split("?")[0]
        return path == f"/repos/{REPO}" or path.startswith(f"/repos/{REPO}/")

    def _gh_or_404(self):
        if not self.path.startswith("/gh/"):
            return self.send_error(404)
        if not self._allowed():
            return self._json(403, {"message": "forbidden path"})
        return self._proxy()

    def do_GET(self):
        if self.path == "/__config":
            return self._json(200, {"repo": REPO, "ai": bool(GEMINI_KEY)})
        if self.path.startswith("/gh/"):
            return self._gh_or_404()
        return super().do_GET()

    def do_POST(self):
        m = re.fullmatch(r"/ai/([a-z]+)", self.path)
        if m and m.group(1) in AI_KINDS:
            length = int(self.headers.get("Content-Length") or 0)
            try:
                payload_input = json.loads(self.rfile.read(length) or b"{}")
            except ValueError:
                return self._json(400, {"message": "JSON を送ってください"})
            try:
                return self._json(200, call_gemini(m.group(1), payload_input))
            except Exception as e:  # noqa: BLE001
                return self._json(502, {"message": str(e)})
        return self._gh_or_404()

    def do_PATCH(self):
        return self._gh_or_404()

    def do_DELETE(self):
        return self._gh_or_404()


if __name__ == "__main__":
    TOKEN = gh_token()
    GEMINI_KEY = gemini_key()
    url = f"http://127.0.0.1:{PORT}/"
    print(f"Task Board: {url}  (repo: {REPO})  AI: {'Gemini ' + GEMINI_MODEL if GEMINI_KEY else 'off (GEMINI_API_KEY 未設定)'}  Ctrl+C で終了")
    if not NO_BROWSER:
        webbrowser.open(url)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
