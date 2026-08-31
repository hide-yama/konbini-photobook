#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""src/ のソースから ../photobook.html を組み立てる。

  python3 src/assemble.py

photobook.html は成果物なので直接編集しないこと。
差し込み先は shell.html の /*__CSS__*/ 等のマーカー。
"""
import json, pathlib

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
r = lambda p: pathlib.Path(p).read_text(encoding="utf-8")

html = r(HERE / "shell.html")
cfg = json.dumps({k: v for k, v in json.loads(r(ROOT / "config.json")).items()
                  if not k.startswith("_")}, ensure_ascii=False)
tplraw = json.loads(r(ROOT / "templates.json"))
# _ で始まる注記だけ落として、版面と対応表はすべて埋め込む
tpl = json.dumps({k: v for k, v in tplraw.items() if not k.startswith("_")}, ensure_ascii=False)

for tag, val in [("/*__CSS__*/", r(HERE / "style.css")),
                 ("/*__CFG__*/", cfg),
                 ("/*__TPL__*/", tpl),
                 ("/*__PDFLIB__*/", r(HERE / "pdf-lib.min.js")),
                 ("/*__APP__*/", r(HERE / "app.js")),
                 ("/*__EXPORT__*/", r(HERE / "export.js"))]:
    assert tag in html, f"差し込み位置が見つかりません: {tag}"
    html = html.replace(tag, val, 1)

out = ROOT / "photobook.html"
out.write_text(html, encoding="utf-8")
print(f"{out}  {len(html.encode())/1024:.0f} KB")
