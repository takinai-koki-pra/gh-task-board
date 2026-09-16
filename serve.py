"""PC 用のローカル起動スクリプト。

  python serve.py [owner/repo] [port]

静的ファイルを配信しつつ、/gh/... への呼び出しを api.github.com に転送する。
認証には `gh auth token`（GitHub CLI のログイン）を使うので、ブラウザにトークンを貼る必要が無い。
"""
import json
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
            return self._json(200, {"repo": REPO})
        if self.path.startswith("/gh/"):
            return self._proxy()
        return super().do_GET()

    def do_POST(self):
        return self._proxy() if self.path.startswith("/gh/") else self.send_error(404)

    def do_PATCH(self):
        return self._proxy() if self.path.startswith("/gh/") else self.send_error(404)


if __name__ == "__main__":
    url = f"http://127.0.0.1:{PORT}/"
    print(f"Task Board: {url}  (repo: {REPO})  Ctrl+C で終了")
    webbrowser.open(url)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
