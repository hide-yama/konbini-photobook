# Python実装（アーカイブ・凍結）

2026-08-31 に開発を停止しました。**このフォルダは参照専用です。動かしません。**
以降の開発は HTML 版（リポジトリ直下の `photobook.html` / `src/`）だけで行います。

このフォルダごと削除しても、HTML版の動作には一切影響しません。

---

## 何が入っているか

| ファイル | 役割 |
|---|---|
| `make.py` | CLI一括：build → impose → 分割 → プレビュー。10MBに収まるまで dpi を段階的に下げる |
| `build.py` | 台割にそって reportlab で A4 通し PDF を組む＋自動台割エンジン |
| `impose.py` | A4 → A3 中綴じ面付け（短辺とじ／長辺とじの2種を出力） |
| `sample.py` | テンプレート見本を1種類1ページで書き出す |
| `app.py` | ローカルWebサーバー（標準ライブラリのみ）。`static/index.html` が画面 |
| `lib/book.py` | フォント登録・画像配置・テキスト描画（reportlab側） |
| `lib/preview.py` | Pillowでページ画像を描く（Ghostscript不要） |
| `lib/fonts/` | Noto Serif/Sans JP。TrueType outline に変換済みのもの |
| `manifest.json` | 停止時点の台割（47ページ＝4の倍数でない作業途中の状態） |
| `out/` | 停止時点の生成物。`pages_A4.pdf` は4ページの小テスト分で manifest とは対応していない |

依存：`pillow>=10.0` / `reportlab>=4.0` / `pypdf>=4.0`（`requirements.txt`）

---

## 復活させる場合に必要な情報

### 参照先が変わっている

`config.json` と `templates.json` はリポジトリ直下に残してあり、いまも HTML 版が
同じものを読んでいます。Python側のコードはこれらを `ROOT/config.json` として
探すので、`archive/python/` から実行すると見つかりません。パスを直すか、
2つのJSONをこのフォルダにコピーしてください。

### 停止時点で残っていた既知のバグ

- **`build.py:151` の `RHYTHM` が未定義**（`EDITORIAL_RHYTHM` の誤り）。
  `--mode editorial` で「偶数ページ かつ 横写真」の条件が揃うと `NameError` で落ちる。
  simple / portrait モードでは通らない行なので表面化していなかった。
- **ノンブル除外リストの食い違い**。`build.py:261` は `("cover", "back-cover", "blank")`、
  `lib/preview.py:139` は `cover-quiet` も含む。`cover-quiet` を3ページ目以降に
  置いたときだけ、PDFとプレビューでノンブルの有無がずれる。

### 引き継がなかった機能（HTML版にないもの）

- **`editorial` モードの自動台割**（見開き→非対称→静かな1点…と変化をつける台割）。
  HTML版の自動台割は `simple` / `portrait` の2つだけ。
  ロジックは `build.py` の `auto_plan_editorial()` と `EDITORIAL_RHYTHM` にある。
- **ベクター文字**。Python版は日本語フォントをPDFに埋め込んでいた。
  HTML版は Canvas で描いた透過PNGを貼るのでラスタになる。
- **写真フォルダを常時参照する運用**。ブラウザはフォルダを覚えられないため、
  HTML版は起動のたびに写真を選び直す必要がある。
