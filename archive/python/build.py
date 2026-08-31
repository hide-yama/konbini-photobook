#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""写真フォルダ → A4ページ順のPDF（冊子の中身）を組む。

  python3 build.py --plan            写真から台割(manifest.json)を作るだけ
  python3 build.py                   台割にそってPDFを組む
  python3 build.py --src ~/写真/多摩湖   写真フォルダを指定
"""
import argparse, json, os, sys

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(ROOT, "lib"))
import book
from reportlab.pdfgen import canvas

IMG_EXT = {".jpg", ".jpeg", ".png", ".tif", ".tiff", ".webp"}


def list_photos(src):
    out = []
    for f in sorted(os.listdir(src)):
        if f.startswith(".") or os.path.splitext(f)[1].lower() not in IMG_EXT:
            continue
        out.append(os.path.join(src, f))
    return out


EDITORIAL_RHYTHM = ["spread", "out", "quiet", "out-low", "duo", "out", "full",
          "spread", "out-low", "triptych", "out", "quiet", "duo", "out",
          "spread", "out", "grid", "out-low", "quiet", "out"]


def _b(p):
    return os.path.basename(p)


SIMPLE_RHYTHM = ["big", "one", "one", "duo", "one", "big", "one", "duo"]


def auto_plan_simple(photos, cfg):
    """標準の5種類だけを使う素直な台割。

      big → 縦: portrait-fill(ページいっぱい) / 横: landscape-wide(上下中央・幅いっぱい)
      one → 縦: portrait-one / 横: landscape-one
      duo → 横写真が2枚続けば landscape-duo、なければ one
    """
    if not photos:
        raise SystemExit("写真が1枚もありません")
    pages = [
        {"template": cfg.get("cover_template", "cover"), "photos": [_b(photos[0])]},
        {"template": "blank", "_note": "表紙の裏"},
    ]
    queue = list(photos[1:])
    step = 0
    while queue:
        kind = SIMPLE_RHYTHM[step % len(SIMPLE_RHYTHM)]
        step += 1
        if kind == "duo":
            if len(queue) >= 2 and all(book.orientation_of(q) != "portrait" for q in queue[:2]):
                a, b = queue.pop(0), queue.pop(0)
                pages.append({"template": "landscape-duo",
                              "photos": [_b(a), _b(b)], "caption": "", "caption2": ""})
                continue
            kind = "one"
        ph = queue.pop(0)
        tall = book.orientation_of(ph) == "portrait"
        if kind == "big":
            t = "portrait-fill" if tall else "landscape-wide"
        else:
            t = "portrait-one" if tall else "landscape-one"
        pages.append({"template": t, "photos": [_b(ph)], "caption": ""})

    pages.append({"template": "back-cover"})
    while len(pages) % 4:
        pages.insert(len(pages) - 1, {"template": "blank"})
    return {
        "_usage": "template を差し替え・行を並べ替え・photos を編集して再実行すれば反映されます。",
        "_templates": "portrait-fill / landscape-wide / portrait-one / landscape-one / landscape-duo",
        "_rule": "ページ総数は必ず4の倍数（中綴じの制約）。",
        "pages": pages,
    }


PORTRAIT_RHYTHM = ["fill", "one", "one", "fill", "one", "one"]


def auto_plan_all_portrait(photos, cfg):
    """全ページを縦位置に揃える。横写真は90度回して縦にする。"""
    if not photos:
        raise SystemExit("写真が1枚もありません")
    pages = [
        {"template": cfg.get("cover_template", "cover"), "photos": [_b(photos[0])]},
        {"template": "blank", "_note": "表紙の裏"},
    ]
    for i, ph in enumerate(photos[1:]):
        kind = PORTRAIT_RHYTHM[i % len(PORTRAIT_RHYTHM)]
        tall = book.orientation_of(ph) == "portrait"
        if tall:
            t = "portrait-fill" if kind == "fill" else "portrait-one"
        else:
            t = "rot-fill" if kind == "fill" else "rot-one"
        pages.append({"template": t, "photos": [_b(ph)], "caption": ""})
    pages.append({"template": "back-cover"})
    while len(pages) % 4:
        pages.insert(len(pages) - 1, {"template": "blank"})
    return {
        "_usage": "template を差し替え・行を並べ替え・photos を編集して再実行すれば反映されます。",
        "_templates": "portrait-fill / portrait-one / rot-fill / rot-one（すべて縦位置）",
        "_rule": "ページ総数は必ず4の倍数（中綴じの制約）。",
        "pages": pages,
    }


def auto_plan(photos, cfg):
    mode = cfg.get("rhythm_mode", "simple")
    if mode in ("portrait", "all-portrait"):
        return auto_plan_all_portrait(photos, cfg)
    if mode == "editorial":
        return auto_plan_editorial(photos, cfg)
    return auto_plan_simple(photos, cfg)


def auto_plan_editorial(photos, cfg):
    """全ページ同じ組み方にせず、見開き→非対称→静かな1点…と変化をつける。

    ページの左右（奇数=右ページ/偶数=左ページ）と写真の縦横を見て、
    小口寄せの版面は自動でL/Rを選ぶ。見開きは必ず偶数ページから始める。
    """
    if not photos:
        raise SystemExit("写真が1枚もありません")
    pages = [
        {"template": cfg.get("cover_template", "cover"), "photos": [_b(photos[0])]},
        {"template": "blank", "_note": "表紙の裏"},
    ]
    queue = list(photos[1:])
    step = 0
    guard = 0
    while queue:
        guard += 1
        if guard > 10000:
            break
        n = len(pages) + 1                 # これから置くページ番号
        odd = n % 2 == 1
        side = "R" if odd else "L"
        kind = EDITORIAL_RHYTHM[step % len(EDITORIAL_RHYTHM)]

        # --- 見開き：偶数ページ始まり かつ 横写真のときだけ ---
        if kind == "spread":
            if not odd and book.orientation_of(queue[0]) != "portrait":
                ph = queue.pop(0)
                variant = "spread-band" if (step // len(RHYTHM)) % 2 else "spread"
                pages.append({"template": variant + "-L", "photos": [_b(ph)]})
                pages.append({"template": variant + "-R", "photos": [_b(ph)], "caption": ""})
                step += 1
                continue
            kind = "out"                   # 条件が揃うまで単ページを挟む（stepは進めない）
        else:
            step += 1

        # --- 3点の帯：横写真が3枚そろうときだけ ---
        if kind == "triptych":
            land = [q for q in queue[:8] if book.orientation_of(q) != "portrait"][:3]
            if len(land) == 3:
                for q in land:
                    queue.remove(q)
                pages.append({"template": "triptych", "photos": [_b(q) for q in land]})
                continue
            kind = "out"

        if kind == "grid":
            if len(queue) >= 4:
                sel = [queue.pop(0) for _ in range(4)]
                pages.append({"template": "grid-4", "photos": [_b(q) for q in sel]})
                continue
            kind = "out"

        if kind == "duo":
            if len(queue) >= 2:
                a, b = queue.pop(0), queue.pop(0)
                pages.append({"template": f"duo-offset-{side}",
                              "photos": [_b(a), _b(b)], "caption": ""})
                continue
            kind = "out"

        ph = queue.pop(0)
        o = book.orientation_of(ph)
        if kind == "quiet":
            t = f"quiet-{side}"
        elif kind == "full":
            t = "full-page"
        elif kind == "out-low":
            t = f"tall-out-{side}" if o == "portrait" else f"low-wide-{side}"
        else:
            t = f"tall-out-{side}" if o == "portrait" else f"edge-out-{side}"
        pages.append({"template": t, "photos": [_b(ph)], "caption": ""})

    pages.append({"template": "back-cover"})
    while len(pages) % 4:                  # 中綴じは4の倍数
        pages.insert(len(pages) - 1, {"template": "blank"})
    return {
        "_usage": "template を差し替え・行を並べ替え・photos を編集して再実行すれば反映されます。",
        "_rule": "ページ総数は必ず4の倍数。-L は偶数ページ(左)、-R は奇数ページ(右)に置くこと。",
        "_spread": "spread-L と spread-R は同じ写真を指定し、必ず偶数→奇数の順に隣り合わせる。",
        "pages": pages,
    }


def render(plan, cfg, tpl, src, out_path, dpi, quality):
    pw, ph = cfg["page"]["width_mm"], cfg["page"]["height_mm"]
    c = canvas.Canvas(out_path, pagesize=(pw * book.MM, ph * book.MM))
    c.setTitle(cfg.get("title", "")); c.setAuthor(cfg.get("credit", ""))
    half_gutter = float(cfg.get("gutter_mm", 0)) / 2.0
    sm = float(cfg.get("safe_margin_mm", 7))
    pn_on = bool(cfg.get("page_numbers", True))
    pn_start = int(cfg.get("page_number_start", 3))
    missing = []
    warns = []

    for i, pg in enumerate(plan["pages"]):
        n = i + 1
        name = pg.get("template", "blank")
        t = tpl["templates"].get(name)
        if t is None:
            raise SystemExit(f"不明なテンプレート: {name}（{n}ページ目）")
        side_req = t.get("page_side", "any")
        if side_req != "any" and side_req != ("odd" if n % 2 else "even"):
            warns.append(f"p{n}: {name} は{'右' if side_req=='odd' else '左'}ページ専用です"
                         f"（いまは{'右' if n%2 else '左'}ページ）")
        c.saveState()
        if t.get("gutter", True) and half_gutter:
            # 奇数ページ=右頁(ノドは左) / 偶数ページ=左頁(ノドは右)
            c.translate((half_gutter if n % 2 == 1 else -half_gutter) * book.MM, 0)

        plist = pg.get("photos") or []
        pg_rot = pg.get("rotate")        # ページ単位の回転指定（どの版面にも効く）
        for fr in t.get("images", []):
            idx = fr.get("slot", 0)
            if idx >= len(plist):
                continue
            rel = plist[idx]
            path = rel if os.path.isabs(rel) else os.path.join(src, rel)
            if not os.path.exists(path):
                missing.append((n, rel)); continue
            if pg_rot:
                fr = dict(fr, rotate=pg_rot)
            book.draw_image_frame(c, path, fr, ph, dpi, quality)

        vals = {
            "title": pg.get("title") or cfg.get("title", ""),
            "subtitle": pg.get("subtitle") or cfg.get("subtitle", ""),
            "credit": pg.get("credit") or cfg.get("credit", ""),
            "caption": pg.get("caption", ""),
            "caption2": pg.get("caption2", ""),
            "pageno": n,
        }
        for ts in t.get("texts", []):
            if pg_rot and not ts.get("rotate"):
                ts = dict(ts, rotate=90 if pg_rot.endswith("ccw") else 270)
            book.draw_text_block(c, ts, pw, ph, vals)

        if pn_on and n >= pn_start and name not in ("cover", "back-cover", "blank"):
            book.draw_text_block(c, {
                "content": "{pageno}", "x": sm if n % 2 == 0 else pw - sm - 20,
                "y": ph - 6, "w": 20, "size": 7.5, "font": "sans",
                "align": "left" if n % 2 == 0 else "right", "color": "#999999",
            }, pw, ph, vals)

        c.restoreState()
        c.showPage()
        print(f"  p{n:>3} {name:<15} {plist[0] if plist else ''}")
    c.save()
    if warns:
        print("\n  ! 左右ページの指定ずれ:")
        for w in warns:
            print(f"      {w}")
    if missing:
        print("\n  ! 見つからなかった写真:")
        for n, r in missing:
            print(f"      p{n}: {r}")
    return len(plan["pages"])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=os.path.join(ROOT, "photos"))
    ap.add_argument("--manifest", default=os.path.join(ROOT, "manifest.json"))
    ap.add_argument("--out", default=os.path.join(ROOT, "out", "pages_A4.pdf"))
    ap.add_argument("--plan", action="store_true", help="台割を作り直して終了")
    ap.add_argument("--mode", choices=["simple", "portrait", "editorial"],
                    help="台割の作り方をその場で上書き（config を書き換えない）")
    ap.add_argument("--dpi", type=int)
    ap.add_argument("--quality", type=int)
    a = ap.parse_args()

    cfg = book.load_json(os.path.join(ROOT, "config.json"))
    if a.mode:
        cfg["rhythm_mode"] = a.mode
    tpl = book.load_json(os.path.join(ROOT, "templates.json"))
    book.register_fonts(cfg["fonts"])
    book.set_rotate_direction(cfg.get("rotate_direction"))
    src = os.path.expanduser(a.src)

    if a.plan or not os.path.exists(a.manifest):
        if not os.path.isdir(src):
            raise SystemExit(f"写真フォルダがありません: {src}")
        photos = list_photos(src)
        if not photos:
            raise SystemExit(f"写真が1枚もありません: {src}")
        plan = auto_plan(photos, cfg)
        with open(a.manifest, "w", encoding="utf-8") as f:
            json.dump(plan, f, ensure_ascii=False, indent=2)
        print(f"台割を書き出しました: {a.manifest}（{len(plan['pages'])}ページ / 写真{len(photos)}枚）")
        if a.plan:
            return

    plan = book.load_json(a.manifest)
    npages = len(plan["pages"])
    if npages % 4:
        raise SystemExit(f"ページ数が {npages} です。中綴じでは4の倍数にしてください。")
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    dpi = a.dpi or cfg["image_dpi"]
    q = a.quality or cfg["jpeg_quality"]
    print(f"\n組版中… {npages}ページ / {dpi}dpi / JPEG品質{q}")
    render(plan, cfg, tpl, src, a.out, dpi, q)
    mb = os.path.getsize(a.out) / 1e6
    print(f"\n完成: {a.out}  ({mb:.1f} MB)")


if __name__ == "__main__":
    main()
