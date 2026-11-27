# chrome-ext

自分用の小さな Chrome 拡張 (Manifest V3) をまとめたリポジトリ。各ディレクトリが独立した 1 つの拡張になっている。ビルド不要・依存ライブラリなし。

| 拡張 | 概要 | ショートカット |
|---|---|---|
| [copy-url](copy-url/README.md) | 選択中のタブの URL を、そのまま / Markdown リンクでコピー | `⌘⇧C` / `⌘⇧K` |
| [fullpage-capture](fullpage-capture/README.md) | ページ全体をスクロールキャプチャし、切り抜き・注釈・黒塗りをしてから保存 / コピー | `⌘⇧S` / `⌘⇧E` |
| [html-clipboard](html-clipboard/README.md) | 開いている HTML をファイルとしてクリップボードにコピー (Slack に貼ると添付される)。macOS 専用・補助ツールの登録が必要 | — |
| [pr-viewed](pr-viewed/README.md) | GitHub PR の lock / 生成ファイルなどを [difit](https://github.com/yoshiko-pg/difit) と同じルールで自動 Viewed にする | — |

## インストール (共通)

1. `chrome://extensions` を開く
2. 右上の「デベロッパーモード」を ON
3. 「パッケージ化されていない拡張機能を読み込む」で、使いたい拡張のディレクトリ (例: `copy-url/`) を選ぶ

- コードを変更したら、`chrome://extensions` でその拡張の更新ボタン (↻) を押す
- ショートカットは初回インストール時にだけ自動で割り当てられる。他の拡張とぶつかって効かないときや変えたいときは `chrome://extensions/shortcuts` で設定する

## ディレクトリ構成

```
copy-url/           タブ URL コピー
fullpage-capture/   フルページキャプチャ + 画像編集
html-clipboard/     HTML をファイルとしてコピー (native-host/ に macOS 用の補助ツール)
pr-viewed/          GitHub PR の自動 Viewed
```

各拡張の使い方・仕組み・制限は、それぞれの README を参照。
