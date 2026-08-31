#!/bin/bash
# ダブルクリックで写真集エディタを起動します
cd "$(dirname "$0")" || exit 1
echo "写真集エディタを起動します…"
if ! python3 -c "import PIL, reportlab, pypdf" 2>/dev/null; then
  echo
  echo "必要なパッケージを入れます（初回のみ・1〜2分）"
  python3 -m pip install --user -r requirements.txt || {
    echo "インストールに失敗しました。手動で次を実行してください:"
    echo "  python3 -m pip install --user -r requirements.txt"
    read -r -p "Enterで閉じます"; exit 1; }
fi
SRC="${1:-$HOME/Pictures}"
python3 app.py --src "$SRC"
read -r -p "Enterで閉じます"
