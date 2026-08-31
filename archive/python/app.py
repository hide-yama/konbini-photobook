#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""写真集エディタ — ブラウザで版面を選び、並べ替え、PDFを書き出す。

  python3 app.py                                  写真フォルダは photos/
  python3 app.py --src ~/Pictures/20250301_多摩湖
  python3 app.py --port 8765 --no-browser
"""
import argparse, io, json, os, subprocess, sys, threading, time, traceback, urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(ROOT, "lib"))

try:
    from PIL import Image                                     # noqa: F401
    import reportlab                                          # noqa: F401
    import pypdf                                              # noqa: F401
except ImportError as e:
    sys.exit(f"""
必要なパッケージが足りません（{e.name}）。

  python3 -m pip install -r "{os.path.join(ROOT, 'requirements.txt')}"

を実行してから、もう一度起動してください。
""")

import book, preview
from build import list_photos, auto_plan

OUT = os.path.join(ROOT, "out")
MANIFEST = os.path.join(ROOT, "manifest.json")

STATE = {"src": "", "pages": [], "cfg": {}, "tpl": {}, "photos": []}
JOB = {"running": False, "log": "", "done": False, "ok": False, "files": []}
_lock = threading.Lock()


# ---------- 状態 ----------
def reload_config():
    STATE["cfg"] = book.load_json(os.path.join(ROOT, "config.json"))
    STATE["tpl"] = book.load_json(os.path.join(ROOT, "templates.json"))
    book.register_fonts(STATE["cfg"]["fonts"])
    book.set_rotate_direction(STATE["cfg"].get("rotate_direction"))


def scan_photos(src):
    out = []
    for p in list_photos(src):
        try:
            o = book.orientation_of(p)
        except Exception:
            continue
        out.append({"name": os.path.basename(p), "orientation": o})
    return out


def save_manifest():
    data = {
        "_usage": "写真集エディタ（app.py）が書き出したものです。手で編集しても構いません。",
        "_rule": "ページ総数は必ず4の倍数（中綴じの制約）。",
        "pages": STATE["pages"],
    }
    tmp = MANIFEST + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, MANIFEST)


def load_manifest():
    if os.path.exists(MANIFEST):
        try:
            return book.load_json(MANIFEST).get("pages", [])
        except Exception:
            pass
    return []


# ---------- ビルド ----------
WANTED = [("", "print_A3_shortedge.pdf", "面付け済み・短辺とじ"),
          ("", "print_A3_longedge.pdf", "面付け済み・長辺とじ"),
          ("", "pages_A4.pdf", "ページ順（確認用）")]


def collect_outputs():
    """今回の書き出し分だけを拾う（過去の試作ファイルや空ファイルは除く）"""
    files = []
    for d, name, label in WANTED:
        p = os.path.join(OUT, d, name)
        if os.path.exists(p) and os.path.getsize(p) > 0:
            files.append({"name": name, "label": label,
                          "mb": round(os.path.getsize(p) / 1e6, 1)})
    for d, label in (("sheets_shortedge", "用紙1枚ずつ・短辺とじ"),
                     ("sheets_longedge", "用紙1枚ずつ・長辺とじ")):
        dd = os.path.join(OUT, d)
        if not os.path.isdir(dd):
            continue
        for f in sorted(os.listdir(dd)):
            p = os.path.join(dd, f)
            if f.startswith("sheet") and f.endswith(".pdf") and os.path.getsize(p) > 0:
                files.append({"name": f"{d}/{f}", "label": label,
                              "mb": round(os.path.getsize(p) / 1e6, 1)})
    return files



def run_build(src, mode=None):
    with _lock:
        if JOB["running"]:
            return
        JOB.update(running=True, log="", done=False, ok=False, files=[])
    def worker():
        try:
            cmd = [sys.executable, "-u", os.path.join(ROOT, "make.py"), "--src", src]
            if mode:
                cmd += ["--mode", mode]
            pr = subprocess.Popen(cmd, cwd=ROOT, stdout=subprocess.PIPE,
                                  stderr=subprocess.STDOUT, text=True, bufsize=1)
            for line in pr.stdout:
                with _lock:
                    JOB["log"] += line
            pr.wait()
            files = collect_outputs()
            with _lock:
                JOB.update(running=False, done=True, ok=(pr.returncode == 0), files=files)
        except Exception:
            with _lock:
                JOB["log"] += "\n" + traceback.format_exc()
                JOB.update(running=False, done=True, ok=False)
    threading.Thread(target=worker, daemon=True).start()


# ---------- HTTP ----------
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _send(self, code, body=b"", ctype="application/json; charset=utf-8", extra=None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj, ensure_ascii=False))

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    # ---- GET ----
    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        try:
            if u.path in ("/", "/index.html"):
                with open(os.path.join(ROOT, "static", "index.html"), "rb") as f:
                    return self._send(200, f.read(), "text/html; charset=utf-8")

            if u.path == "/api/state":
                tl = []
                for k, v in STATE["tpl"]["templates"].items():
                    tl.append({"name": k, "label": v.get("label", k),
                               "slots": v.get("slots", 0),
                               "side": v.get("page_side", "any")})
                return self._json({
                    "src": STATE["src"], "photos": STATE["photos"], "pages": STATE["pages"],
                    "templates": tl,
                    "rotate_pairs": STATE["tpl"].get("rotate_pairs", {}),
                    "title": STATE["cfg"].get("title", ""),
                    "rotate_direction": STATE["cfg"].get("rotate_direction", "ccw"),
                })

            if u.path == "/api/thumb":
                name = (q.get("f") or [""])[0]
                p = os.path.join(STATE["src"], os.path.basename(name))
                if not os.path.exists(p):
                    return self._send(404, b"")
                im = preview.thumbnail(p, int((q.get("s") or ["260"])[0]))
                b = io.BytesIO(); im.save(b, "JPEG", quality=78)
                return self._send(200, b.getvalue(), "image/jpeg")

            if u.path == "/api/preview":
                i = int((q.get("i") or ["0"])[0])
                sc = float((q.get("s") or ["2.4"])[0])
                if not (0 <= i < len(STATE["pages"])):
                    return self._send(404, b"")
                im = preview.render_page(STATE["pages"][i], STATE["cfg"], STATE["tpl"],
                                         STATE["src"], page_no=i + 1, scale=sc)
                b = io.BytesIO(); im.save(b, "JPEG", quality=80)
                return self._send(200, b.getvalue(), "image/jpeg")

            if u.path == "/api/build_status":
                with _lock:
                    return self._json(dict(JOB))

            if u.path == "/api/download":
                rel = (q.get("f") or [""])[0]
                p = os.path.normpath(os.path.join(OUT, rel))
                if not p.startswith(OUT) or not os.path.exists(p):
                    return self._send(404, b"")
                with open(p, "rb") as f:
                    data = f.read()
                fn = urllib.parse.quote(os.path.basename(p))
                return self._send(200, data, "application/pdf",
                                  {"Content-Disposition": f"attachment; filename*=UTF-8''{fn}"})

            return self._send(404, b"not found", "text/plain; charset=utf-8")
        except Exception:
            return self._send(500, traceback.format_exc(), "text/plain; charset=utf-8")

    # ---- POST ----
    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        try:
            if u.path == "/api/pages":
                STATE["pages"] = self._body().get("pages", [])
                save_manifest()
                return self._json({"ok": True, "count": len(STATE["pages"])})

            if u.path == "/api/src":
                p = os.path.expanduser(self._body().get("path", ""))
                if not os.path.isdir(p):
                    return self._json({"ok": False, "error": f"フォルダが見つかりません: {p}"}, 400)
                ph = scan_photos(p)
                if not ph:
                    return self._json({"ok": False, "error": "写真が1枚もありません"}, 400)
                STATE["src"] = p; STATE["photos"] = ph
                return self._json({"ok": True, "photos": ph})

            if u.path == "/api/autoplan":
                mode = self._body().get("mode", "simple")
                cfg = dict(STATE["cfg"]); cfg["rhythm_mode"] = mode
                paths = [os.path.join(STATE["src"], p["name"]) for p in STATE["photos"]]
                STATE["pages"] = auto_plan(paths, cfg)["pages"]
                save_manifest()
                return self._json({"ok": True, "pages": STATE["pages"]})

            if u.path == "/api/reload":
                reload_config()
                return self._json({"ok": True})

            if u.path == "/api/build":
                if len(STATE["pages"]) % 4:
                    return self._json({"ok": False,
                                       "error": "ページ数が4の倍数ではありません"}, 400)
                save_manifest()
                run_build(STATE["src"], self._body().get("mode"))
                return self._json({"ok": True})

            return self._send(404, b"not found", "text/plain; charset=utf-8")
        except Exception:
            return self._send(500, traceback.format_exc(), "text/plain; charset=utf-8")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=os.path.join(ROOT, "photos"))
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-browser", action="store_true")
    a = ap.parse_args()

    reload_config()
    src = os.path.expanduser(a.src)
    STATE["src"] = src
    STATE["photos"] = scan_photos(src) if os.path.isdir(src) else []
    STATE["pages"] = load_manifest()
    os.makedirs(OUT, exist_ok=True)

    srv = ThreadingHTTPServer(("127.0.0.1", a.port), Handler)
    url = f"http://127.0.0.1:{a.port}/"
    print(f"""
  写真集エディタを起動しました

    {url}

  写真フォルダ : {src}（{len(STATE['photos'])}枚）
  台割         : {len(STATE['pages'])}ページ

  終了するには Control-C
""")
    if not a.no_browser:
        try:
            import webbrowser; webbrowser.open(url)
        except Exception:
            pass
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n  終了しました")


if __name__ == "__main__":
    main()
