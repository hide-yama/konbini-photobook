# -*- coding: utf-8 -*-
"""冊子生成の共通ロジック（フォント登録・画像配置・テキスト描画）"""
import io, json, os, sys
from PIL import Image, ImageOps
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.utils import ImageReader
from reportlab.lib.colors import toColor

MM = 72.0 / 25.4  # 1mm を PDF ポイントに


def load_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


# ---------- フォント ----------
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def register_fonts(fontcfg):
    registered = []
    for alias, spec in fontcfg.items():
        path = spec[0] if isinstance(spec, list) else spec
        if not os.path.isabs(path):
            path = os.path.join(ROOT, path)
        if not os.path.exists(path):
            print(f"  ! フォント未検出: {path}", file=sys.stderr); continue
        try:
            pdfmetrics.registerFont(TTFont(alias, path))
            registered.append(alias)
        except Exception as e:
            print(f"  ! フォント登録失敗 {alias}: {e}", file=sys.stderr)
    for base in ("serif", "sans"):
        if base in registered and base + "-bold" in registered:
            pdfmetrics.registerFontFamily(base, normal=base, bold=base + "-bold")
    return registered


def font_or_default(name):
    try:
        pdfmetrics.getFont(name)
        return name
    except Exception:
        return "Helvetica"


# ---------- 画像 ----------
_exif_cache = {}
ROTATE_OVERRIDE = None       # config の rotate_direction ("cw"/"ccw") で上書きされる


def set_rotate_direction(d):
    global ROTATE_OVERRIDE
    ROTATE_OVERRIDE = d if d in ("cw", "ccw") else None


def open_upright(path):
    """EXIF の回転情報を適用して開く（Lumix等の縦位置撮影に必須）"""
    im = Image.open(path)
    im = ImageOps.exif_transpose(im)
    if im.mode not in ("RGB", "L"):
        im = im.convert("RGB")
    return im


def orientation_of(path):
    """縦横の判定。EXIFヘッダだけ読むので画素は展開しない（43枚でも一瞬）。"""
    key = (path, os.path.getmtime(path))
    if key in _exif_cache:
        return _exif_cache[key]
    with Image.open(path) as im:
        w, h = im.size
        try:
            o = im.getexif().get(274, 1)      # 274 = Orientation
        except Exception:
            o = 1
    if o in (5, 6, 7, 8):                     # 90/270度回転しているものは幅高を入れ替える
        w, h = h, w
    r = "portrait" if h > w else ("square" if h == w else "landscape")
    _exif_cache[key] = r
    return r


def fit_image(im, box_w_px, box_h_px, mode):
    """mode=contain: 全体を収める / cover: 敷き詰めて中央トリミング"""
    iw, ih = im.size
    if mode == "cover":
        s = max(box_w_px / iw, box_h_px / ih)
        nw, nh = max(1, round(iw * s)), max(1, round(ih * s))
        im = im.resize((nw, nh), Image.LANCZOS)
        left, top = (nw - box_w_px) // 2, (nh - box_h_px) // 2
        return im.crop((left, top, left + box_w_px, top + box_h_px))
    s = min(box_w_px / iw, box_h_px / ih)
    return im.resize((max(1, round(iw * s)), max(1, round(ih * s))), Image.LANCZOS)


def draw_image_frame(c, path, frame, page_h_mm, dpi, quality):
    """frame: {x,y,w,h,fit,src_crop} 単位mm・原点ページ左上

    src_crop=[x0,y0,x1,y1] は元画像の使う範囲を 0〜1 で指定する。
    見開き（1枚を左右ページに分けて置く）はこれで実現している。
    """
    fw_mm, fh_mm = frame["w"], frame["h"]
    box_w = max(1, round(fw_mm / 25.4 * dpi))
    box_h = max(1, round(fh_mm / 25.4 * dpi))
    src = open_upright(path)
    try:
        rot = frame.get("rotate")
        if rot and ROTATE_OVERRIDE:
            rot = ("auto-" if rot.startswith("auto") else "") + ROTATE_OVERRIDE
        if rot:
            wide = src.width > src.height
            if rot in ("cw", "ccw") or (rot.startswith("auto") and wide):
                ccw = rot.endswith("ccw")
                src = src.transpose(Image.ROTATE_90 if ccw else Image.ROTATE_270)
        cr = frame.get("src_crop")
        if cr:
            iw, ih = src.size
            src = src.crop((round(cr[0] * iw), round(cr[1] * ih),
                            round(cr[2] * iw), round(cr[3] * ih)))
        out = fit_image(src, box_w, box_h, frame.get("fit", "contain"))
    finally:
        src.close()
    buf = io.BytesIO()
    out.convert("RGB").save(buf, "JPEG", quality=quality, optimize=True, progressive=True)
    buf.seek(0)
    ow, oh = out.size
    draw_w_mm = ow / dpi * 25.4
    draw_h_mm = oh / dpi * 25.4
    x_mm = frame["x"] + (fw_mm - draw_w_mm) / 2.0
    y_top_mm = frame["y"] + (fh_mm - draw_h_mm) / 2.0
    c.drawImage(ImageReader(buf), x_mm * MM, (page_h_mm - y_top_mm - draw_h_mm) * MM,
                width=draw_w_mm * MM, height=draw_h_mm * MM, mask=None)


# ---------- テキスト ----------
def wrap_cjk(text, font, size, width_mm):
    """日本語向け：文字幅を測りながら折り返す。改行は尊重する。"""
    limit = width_mm * MM
    lines = []
    for para in str(text).split("\n"):
        cur = ""
        for ch in para:
            if pdfmetrics.stringWidth(cur + ch, font, size) > limit and cur:
                lines.append(cur)
                cur = ch
            else:
                cur += ch
        lines.append(cur)
    return lines


def draw_text_block(c, spec, page_w_mm, page_h_mm, values):
    content = str(spec.get("content", ""))
    for k, v in values.items():
        content = content.replace("{%s}" % k, "" if v is None else str(v))
    if not content.strip():
        return
    font = font_or_default(spec.get("font", "sans"))
    size = float(spec.get("size", 9))
    leading = float(spec.get("leading", size * 1.5))
    align = spec.get("align", "left")
    x_mm, y_mm = spec["x"], spec["y"]
    w_mm = spec.get("w", page_w_mm - x_mm * 2)
    rot = float(spec.get("rotate", 0) or 0)

    c.saveState()
    c.setFillColor(toColor(spec.get("color", "#000000")))
    c.setFont(font, size)
    if rot:
        # 回転ページ用。(x,y) を起点に、回した座標系で通常どおり組む
        c.translate(x_mm * MM, (page_h_mm - y_mm) * MM)
        c.rotate(rot)
        for i, line in enumerate(wrap_cjk(content, font, size, w_mm)):
            ly = -i * leading
            if align == "center":
                c.drawCentredString(w_mm / 2 * MM, ly, line)
            elif align == "right":
                c.drawRightString(w_mm * MM, ly, line)
            else:
                c.drawString(0, ly, line)
    else:
        for i, line in enumerate(wrap_cjk(content, font, size, w_mm)):
            ly = (page_h_mm - (y_mm + i * leading / MM)) * MM
            if align == "center":
                c.drawCentredString((x_mm + w_mm / 2) * MM, ly, line)
            elif align == "right":
                c.drawRightString((x_mm + w_mm) * MM, ly, line)
            else:
                c.drawString(x_mm * MM, ly, line)
    c.restoreState()
