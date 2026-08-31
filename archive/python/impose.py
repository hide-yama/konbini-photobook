#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""A4ページ順のPDF → A3横・中綴じ面付けPDF（両面プリント用）

中綴じの並び（全Nページ・s枚目の用紙, 0始まり）:
    表 = [ N-2s | 2s+1 ]
    裏 = [ 2s+2 | N-2s-1 ]
  例) 8ページ → 表8|1・裏2|7 / 表6|3・裏4|5

両面の「とじ方向」はプリンタ次第なので2種類とも書き出す。
テスト印刷して正しく綴じられた方を採用してください。
"""
import argparse, os, sys
from pypdf import PdfReader, PdfWriter, PageObject, Transformation

MM = 72.0 / 25.4


def spreads(n):
    """(表左,表右,裏左,裏右) を用紙ごとに返す"""
    out = []
    for s in range(n // 4):
        out.append((n - 2 * s, 2 * s + 1, 2 * s + 2, n - 2 * s - 1))
    return out


def place(sheet, page, x_mm, sheet_h_mm, rotate180):
    """A3用紙の (x_mm, 0) 位置にA4ページを貼る"""
    w = float(page.mediabox.width)
    h = float(page.mediabox.height)
    if rotate180:
        t = Transformation().rotate(180).translate(x_mm * MM + w, h)
    else:
        t = Transformation().translate(x_mm * MM, 0)
    sheet.merge_transformed_page(page, t)


def impose(src, out, flip, binding="left", sheet_w_mm=420.0, sheet_h_mm=297.0, half_mm=210.0):
    r = PdfReader(src)
    n = len(r.pages)
    if n % 4:
        raise SystemExit(f"ページ数が {n} です。中綴じは4の倍数が必要です。")
    w = PdfWriter()
    for (fl, fr, bl, br) in spreads(n):
        if binding == "right":      # 右開き（縦書き・和書スタイル）は左右を入れ替える
            fl, fr, bl, br = fr, fl, br, bl
        for (left, right, is_back) in ((fl, fr, False), (bl, br, True)):
            sheet = PageObject.create_blank_page(width=sheet_w_mm * MM, height=sheet_h_mm * MM)
            rot = is_back and flip == "long"
            if rot:
                # 用紙ごと180°回すので左右も入れ替わる
                place(sheet, r.pages[right - 1], 0.0, sheet_h_mm, True)
                place(sheet, r.pages[left - 1], half_mm, sheet_h_mm, True)
            else:
                place(sheet, r.pages[left - 1], 0.0, sheet_h_mm, False)
                place(sheet, r.pages[right - 1], half_mm, sheet_h_mm, False)
            w.add_page(sheet)
    with open(out, "wb") as f:
        w.write(f)
    return n, n // 4


def main():
    root = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=os.path.join(root, "out", "pages_A4.pdf"))
    ap.add_argument("--outdir", default=os.path.join(root, "out"))
    a = ap.parse_args()
    cfgp = os.path.join(root, "config.json")
    binding = "left"
    if os.path.exists(cfgp):
        import json
        binding = json.load(open(cfgp, encoding="utf-8")).get("binding", "left")
    if not os.path.exists(a.src):
        raise SystemExit(f"入力がありません: {a.src}  先に build.py を実行してください。")
    os.makedirs(a.outdir, exist_ok=True)
    for flip, label in (("short", "短辺とじ"), ("long", "長辺とじ")):
        out = os.path.join(a.outdir, f"print_A3_{flip}edge.pdf")
        n, sheets = impose(a.src, out, flip, binding)
        print(f"  {label}用: {out}  ({os.path.getsize(out)/1e6:.1f} MB)")
    print(f"\n  {n}ページ → A3用紙 {sheets}枚（両面）／{'左開き' if binding=='left' else '右開き'}")
    print("  ※ 面付けの並び:")
    for i, (fl, fr, bl, br) in enumerate(spreads(n), 1):
        print(f"      {i}枚目  表 [{fl:>2} | {fr:>2}]   裏 [{bl:>2} | {br:>2}]")


if __name__ == "__main__":
    main()
