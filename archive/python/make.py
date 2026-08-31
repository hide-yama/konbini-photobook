#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""写真フォルダ → コンビニ入稿用PDF まで一気に作る。

  python3 make.py --src ~/Pictures/20250301_多摩湖

ネットプリントの1ファイル10MB制限に収まるまで dpi/画質を自動で下げ、
それでも超える場合は用紙1枚ごとの分割ファイルを使ってください。
"""
import argparse, json, os, shutil, subprocess, sys

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, "out")
LADDER = [(250, 82), (220, 78), (200, 74), (180, 70), (160, 66), (144, 62)]


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode:
        print(r.stdout); print(r.stderr, file=sys.stderr)
        raise SystemExit(f"失敗: {' '.join(cmd)}")
    return r.stdout


def mb(p):
    return os.path.getsize(p) / 1e6


def clean_dir(d):
    """作り直す前に空にする。削除できない環境では中身を0バイトにして凌ぐ。"""
    try:
        if os.path.isdir(d):
            shutil.rmtree(d)
    except OSError:
        for f in os.listdir(d):
            try:
                os.remove(os.path.join(d, f))
            except OSError:
                try: open(os.path.join(d, f), "wb").close()
                except OSError: pass
    os.makedirs(d, exist_ok=True)


def split_sheets(src, outdir):
    """用紙1枚（表+裏の2ページ）ごとにファイルを分ける"""
    from pypdf import PdfReader, PdfWriter
    clean_dir(outdir)
    r = PdfReader(src)
    made = []
    for i in range(0, len(r.pages), 2):
        w = PdfWriter()
        w.add_page(r.pages[i])
        if i + 1 < len(r.pages):
            w.add_page(r.pages[i + 1])
        p = os.path.join(outdir, f"sheet{i//2+1:02d}.pdf")
        with open(p, "wb") as f:
            w.write(f)
        made.append(p)
    return made


def previews(src, outdir, dpi=60):
    if not shutil.which("gs"):
        return 0
    clean_dir(outdir)
    subprocess.run(["gs", "-q", "-dNOPAUSE", "-dBATCH", "-sDEVICE=png16m",
                    f"-r{dpi}", f"-sOutputFile={outdir}/p%02d.png", src],
                   capture_output=True)
    return len([f for f in os.listdir(outdir) if f.endswith(".png")])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=os.path.join(ROOT, "photos"), help="写真フォルダ")
    ap.add_argument("--replan", action="store_true", help="台割を作り直す（手編集は消えます）")
    ap.add_argument("--mode", choices=["simple", "portrait", "editorial"],
                    help="台割の作り方: simple=標準5種 / portrait=全ページ縦 / editorial=凝った版")
    ap.add_argument("--no-shrink", action="store_true", help="10MBに合わせた自動縮小をしない")
    ap.add_argument("--dpi", type=int, help="解像度を固定（自動縮小をやめる）")
    ap.add_argument("--quality", type=int, help="JPEG品質を固定")
    a = ap.parse_args()

    cfg = json.load(open(os.path.join(ROOT, "config.json"), encoding="utf-8"))
    limit = float(cfg.get("max_filesize_mb", 10))
    src = os.path.expanduser(a.src)
    a_dpi, a_quality, a_no_shrink = a.dpi, a.quality, a.no_shrink
    manifest = os.path.join(ROOT, "manifest.json")

    if a.replan or not os.path.exists(manifest):
        cmd = [sys.executable, os.path.join(ROOT, "build.py"), "--src", src, "--plan"]
        if a.mode:
            cmd += ["--mode", a.mode]
        run(cmd)

    print(f"■ 写真フォルダ: {src}")
    print(f"■ 判定基準: 用紙1枚あたり {limit:.0f} MB 以内（ネットプリントの1ファイル上限）\n")

    ladder = LADDER if not a_no_shrink else LADDER[:1]
    if a_dpi:
        ladder = [(a_dpi, a_quality or 82)]

    chosen = None
    for dpi, q in ladder:
        print(f"■ 組版 ({dpi}dpi / JPEG品質{q})")
        cmd = [sys.executable, os.path.join(ROOT, "build.py"),
               "--src", src, "--dpi", str(dpi), "--quality", str(q)]
        if a.mode:
            cmd += ["--mode", a.mode]
        run(cmd)
        print("■ 面付け")
        print(run([sys.executable, os.path.join(ROOT, "impose.py")]))
        sheets = split_sheets(os.path.join(OUT, "print_A3_shortedge.pdf"),
                              os.path.join(OUT, "sheets_shortedge"))
        split_sheets(os.path.join(OUT, "print_A3_longedge.pdf"),
                     os.path.join(OUT, "sheets_longedge"))
        worst = max(mb(x) for x in sheets)
        whole = mb(os.path.join(OUT, "print_A3_shortedge.pdf"))
        print(f"■ 用紙1枚あたり最大 {worst:.1f} MB / 全ページ1ファイルなら {whole:.1f} MB")
        chosen = (dpi, q, worst, whole, sheets)
        if worst <= limit or a_no_shrink or a_dpi:
            break
        print("   → 1枚でも上限超過。解像度を下げて組み直します。\n")

    npng = previews(os.path.join(OUT, "pages_A4.pdf"), os.path.join(OUT, "preview"))
    dpi, q, worst, whole, sheets = chosen

    print("\n" + "=" * 60)
    print("できあがり")
    print("=" * 60)
    print(f"  確認用（ページ順）  out/pages_A4.pdf")
    print(f"  プレビューPNG       out/preview/  ({npng}枚)")
    print(f"  採用設定            {dpi}dpi / JPEG品質 {q}")
    print()
    if whole <= limit:
        print("  ★ 入稿はこれ1本でOK")
        print(f"     out/print_A3_shortedge.pdf   {whole:.1f} MB")
        print(f"     out/print_A3_longedge.pdf    {mb(os.path.join(OUT,'print_A3_longedge.pdf')):.1f} MB")
    else:
        print(f"  ★ 入稿は【用紙1枚ずつ】{len(sheets)}ファイルを登録してください")
        print(f"     out/sheets_shortedge/  各 {worst:.1f} MB以下")
        print("     out/sheets_longedge/   （とじ方向がもう一方だった場合）")
        print(f"     ※ 全ページ1ファイル版は {whole:.1f} MB あり10MBに収まりません。")
    print()
    print("  ▸ 初回はテスト印刷を: sheets_shortedge/sheet01.pdf を両面プリントし、")
    print("    二つ折りして 表紙 → 2 → 3 … と並べば短辺とじが正解。")
    print("    ズレていれば sheets_longedge/ の方を使ってください。")
    print("  ▸ 直したいページは manifest.json の template を差し替えて再実行。")


if __name__ == "__main__":
    main()
