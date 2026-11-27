#!/bin/bash
# Registers the native messaging host that lets HTML Clipboard copy files.
#
# Usage: ./install.sh <extension ID>
#        ./install.sh --uninstall
set -euo pipefail

name=html_clipboard
host_dir="$HOME/Library/Application Support/html-clipboard"
manifest="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/$name.json"

if [[ ${1:-} == --uninstall ]]; then
  rm -f "$manifest"
  rm -rf "$host_dir"
  echo "アンインストールしました。"
  exit 0
fi

id=${1:-}
if [[ ! $id =~ ^[a-p]{32}$ ]]; then
  echo "使い方: $0 <拡張機能のID>" >&2
  echo "ID は chrome://extensions の HTML Clipboard に表示される 32 文字の英字です。" >&2
  exit 1
fi

mkdir -p "$host_dir" "$(dirname "$manifest")"
install -m 755 "$(dirname "$0")/host.js" "$host_dir/host"
cat > "$manifest" <<EOF
{
  "name": "$name",
  "description": "Copies HTML files to the clipboard for HTML Clipboard",
  "path": "$host_dir/host",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$id/"]
}
EOF
echo "インストールしました。ツールバーの HTML Clipboard を押すと、開いている HTML をファイルとしてコピーできます。"
