#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""テンプレート見本を1種類1ページで書き出す。

  python3 sample.py --src ~/Pictures/20250301_多摩湖
  python3 sample.py --src ... --all      # ［応用］も含めて全部
"""
import argparse, os, sys

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(ROOT, "lib"))
import book
from build import list_photos, render

STANDARD = ["portrait-fill", "landscape-wide", "portrait-one", "landscape-one", "landscape-duo"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=os.path.join(ROOT, "photos"))
    ap.add_argument("--out", default=os.path.join(ROOT, "out", "template_samples.pdf"))
    ap.add_argument("--all", action="store_true", help="［応用］テンプレートも出す")
    ap.add_argument("--dpi", type=int, default=160)
    a = ap.parse_args()

    cfg = book.load_json(os.path.join(ROOT, "config.json"))
    tpl = book.load_json(os.path.join(ROOT, "templates.json"))
    book.register_fonts(cfg["fonts"])
    book.set_rotate_direction(cfg.get("rotate_direction"))
    src = os.path.expanduser(a.src)
    photos = list_photos(src)
    if not photos:
        raise SystemExit(f"写真がありません: {src}")

    tall = [p for p in photos if book.orientation_of(p) == "portrait"]
    wide = [p for p in photos if book.orientation_of(p) != "portrait"]
    if not tall:
        print("  ! 縦位置の写真がないので、縦用の版面にも横写真を流します")
        tall = wide

    names = STANDARD if not a.all else [
        k for k, v in tpl["templates"].items() if k not in ("blank",)]

    pages = []
    for name in names:
        t = tpl["templates"].get(name)
        if t is None:
            continue
        need = t.get("slots", 0)
        pool = tall if "portrait" in name or "tall" in name else wide
        pool = pool or photos
        sel = [pool[i % len(pool)] for i in range(need)]
        pages.append({"template": name,
                      "photos": [os.path.basename(x) for x in sel],
                      "caption": name, "caption2": ""})

    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    print(f"見本を書き出します（{len(pages)}種類）")
    render({"pages": pages}, cfg, tpl, src, a.out, a.dpi, 78)
    print(f"\n完成: {a.out}")
    for n in names:
        t = tpl["templates"].get(n)
        if t:
            print(f"    {n:<16} {t.get('label','')}")


if __name__ == "__main__":
    main()
