# -*- coding: utf-8 -*-
"""PDFと同じテンプレート定義から、ページのプレビュー画像を直接描く。

Ghostscript を使わないので追加インストール不要で、表示も速い。
"""
import os, threading
from collections import OrderedDict
from PIL import Image, ImageDraw, ImageFont

import book

PT_MM = 25.4 / 72.0          # 1pt = 0.3528mm
_src_cache = OrderedDict()   # 元画像を縮小して持っておく
_font_cache = {}
_lock = threading.Lock()
SRC_CACHE_MAX = 40
SRC_MAX_PX = 1800


def _cached_source(path):
    key = (path, os.path.getmtime(path))
    with _lock:
        if key in _src_cache:
            _src_cache.move_to_end(key)
            return _src_cache[key].copy()
    im = book.open_upright(path)
    im.thumbnail((SRC_MAX_PX, SRC_MAX_PX), Image.LANCZOS)
    im = im.convert("RGB")
    with _lock:
        _src_cache[key] = im
        while len(_src_cache) > SRC_CACHE_MAX:
            _src_cache.popitem(last=False)
    return im.copy()


def _font(cfg, name, px):
    px = max(1, int(round(px)))
    spec = cfg["fonts"].get(name) or cfg["fonts"].get("sans")
    path = spec[0] if isinstance(spec, list) else spec
    if not os.path.isabs(path):
        path = os.path.join(book.ROOT, path)
    key = (path, px)
    if key not in _font_cache:
        try:
            _font_cache[key] = ImageFont.truetype(path, px)
        except Exception:
            _font_cache[key] = ImageFont.load_default()
    return _font_cache[key]


def _wrap(text, font, limit_px):
    lines = []
    for para in str(text).split("\n"):
        cur = ""
        for ch in para:
            if font.getlength(cur + ch) > limit_px and cur:
                lines.append(cur); cur = ch
            else:
                cur += ch
        lines.append(cur)
    return lines


def _fit(im, bw, bh, mode):
    iw, ih = im.size
    if bw < 1 or bh < 1:
        return im
    if mode == "cover":
        s = max(bw / iw, bh / ih)
        im = im.resize((max(1, round(iw * s)), max(1, round(ih * s))), Image.LANCZOS)
        nw, nh = im.size
        l, t = (nw - bw) // 2, (nh - bh) // 2
        return im.crop((l, t, l + bw, t + bh))
    s = min(bw / iw, bh / ih)
    return im.resize((max(1, round(iw * s)), max(1, round(ih * s))), Image.LANCZOS)


def render_page(page, cfg, tpl, src_dir, page_no=1, scale=3.0):
    """1ページを PIL 画像で返す。scale は 1mm あたりのピクセル数。"""
    pw = cfg["page"]["width_mm"]; ph = cfg["page"]["height_mm"]
    W, H = int(round(pw * scale)), int(round(ph * scale))
    canvas = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(canvas)

    name = page.get("template", "blank")
    t = tpl["templates"].get(name)
    if t is None:
        d.text((10, 10), f"不明なテンプレート: {name}", fill="#cc0000", font=_font(cfg, "sans", 14))
        return canvas

    half_g = float(cfg.get("gutter_mm", 0)) / 2.0
    dx = 0.0
    if t.get("gutter", True) and half_g:
        dx = half_g if page_no % 2 == 1 else -half_g

    plist = page.get("photos") or []
    pg_rot = page.get("rotate")

    for fr in t.get("images", []):
        idx = fr.get("slot", 0)
        if idx >= len(plist):
            continue
        rel = plist[idx]
        path = rel if os.path.isabs(rel) else os.path.join(src_dir, rel)
        if not os.path.exists(path):
            continue
        try:
            im = _cached_source(path)
        except Exception:
            continue
        rot = pg_rot or fr.get("rotate")
        if rot:
            if book.ROTATE_OVERRIDE:
                rot = ("auto-" if str(rot).startswith("auto") else "") + book.ROTATE_OVERRIDE
            if rot in ("cw", "ccw") or (str(rot).startswith("auto") and im.width > im.height):
                im = im.transpose(Image.ROTATE_90 if str(rot).endswith("ccw") else Image.ROTATE_270)
        cr = fr.get("src_crop")
        if cr:
            iw, ih = im.size
            im = im.crop((round(cr[0] * iw), round(cr[1] * ih),
                          round(cr[2] * iw), round(cr[3] * ih)))
        bw = int(round(fr["w"] * scale)); bh = int(round(fr["h"] * scale))
        out = _fit(im, bw, bh, fr.get("fit", "contain"))
        ox = int(round((fr["x"] + dx) * scale + (bw - out.width) / 2))
        oy = int(round(fr["y"] * scale + (bh - out.height) / 2))
        canvas.paste(out, (ox, oy))

    vals = {
        "title": page.get("title") or cfg.get("title", ""),
        "subtitle": page.get("subtitle") or cfg.get("subtitle", ""),
        "credit": page.get("credit") or cfg.get("credit", ""),
        "caption": page.get("caption", ""),
        "caption2": page.get("caption2", ""),
        "pageno": page_no,
    }

    texts = list(t.get("texts", []))
    if cfg.get("page_numbers", True) and page_no >= int(cfg.get("page_number_start", 3)) \
            and name not in ("cover", "cover-quiet", "back-cover", "blank"):
        sm = float(cfg.get("safe_margin_mm", 7))
        texts.append({"content": "{pageno}", "x": sm if page_no % 2 == 0 else pw - sm - 20,
                      "y": ph - 6, "w": 20, "size": 7.5, "font": "sans",
                      "align": "left" if page_no % 2 == 0 else "right", "color": "#999999"})

    for ts in texts:
        if pg_rot and not ts.get("rotate"):
            ts = dict(ts, rotate=90 if str(pg_rot).endswith("ccw") else 270)
        content = str(ts.get("content", ""))
        for k, v in vals.items():
            content = content.replace("{%s}" % k, "" if v is None else str(v))
        if not content.strip():
            continue
        size_px = float(ts.get("size", 9)) * PT_MM * scale
        f = _font(cfg, ts.get("font", "sans"), size_px)
        lead = float(ts.get("leading", float(ts.get("size", 9)) * 1.5)) * PT_MM * scale
        w_px = float(ts.get("w", pw - ts["x"] * 2)) * scale
        lines = _wrap(content, f, w_px)
        color = ts.get("color", "#000000")
        rot = float(ts.get("rotate", 0) or 0)
        if rot:
            bw = int(w_px) + 4
            bh = int(lead * len(lines)) + int(size_px) + 4
            layer = Image.new("RGBA", (max(1, bw), max(1, bh)), (255, 255, 255, 0))
            ld = ImageDraw.Draw(layer)
            for i, line in enumerate(lines):
                lw = f.getlength(line)
                lx = 0 if ts.get("align") == "left" else (bw - lw if ts.get("align") == "right" else (bw - lw) / 2)
                ld.text((lx, i * lead), line, fill=color, font=f)
            layer = layer.rotate(rot, expand=True)
            px = int(round((ts["x"] + dx) * scale))
            py = int(round(ts["y"] * scale))
            canvas.paste(layer, (px, py - layer.height), layer)
        else:
            for i, line in enumerate(lines):
                lw = f.getlength(line)
                x0 = (ts["x"] + dx) * scale
                lx = x0 if ts.get("align") == "left" else (
                    x0 + w_px - lw if ts.get("align") == "right" else x0 + (w_px - lw) / 2)
                d.text((lx, ts["y"] * scale + i * lead - size_px), line, fill=color, font=f)

    d.rectangle([0, 0, W - 1, H - 1], outline="#dddddd")
    return canvas


def thumbnail(path, max_px=260):
    im = _cached_source(path)
    im.thumbnail((max_px, max_px), Image.LANCZOS)
    return im
