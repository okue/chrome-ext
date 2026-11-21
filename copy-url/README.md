# Copy Tab URLs

現在のタブ (Shift / ⌘ クリックで複数選択していれば選択中のすべてのタブ) の URL をクリップボードにコピーする Chrome 拡張。Markdown リンク形式でもコピーできる。

- 外部通信なし
- 依存ライブラリなし

## インストール

[ルートの README](../README.md#インストール-共通) の手順で、このディレクトリ (`copy-url/`) を読み込む。

## 使い方

| 操作 | 結果 |
|---|---|
| `⌘⇧C` | URL をコピー |
| `⌘⇧K` | Markdown リンク `[タイトル](URL)` でコピー |
| ツールバーアイコンをクリック | URL をコピー |
| 右クリック →「タブの URL をコピー」/「タブを Markdown リンクでコピー」 | それぞれの形式でコピー |

- 複数タブを選択しているときは 1 行 1 タブで改行区切りになる
- Markdown 形式では、タイトル中の `[` `]` をエスケープする (タイトルが空なら URL を使う)
- コピーに成功するとバッジに `✓` (複数タブならその数)、失敗すると `!` が 1.5 秒出る

出力例 (Markdown):

```
[Google](https://www.google.com/)
[GitHub](https://github.com/)
```

## 仕組み

```
background.js   選択中タブを取得 → 文字列を組み立て → クリップボードへ書き込み
offscreen.html  スクリプトを注入できないページ用のフォールバック (offscreen document)
offscreen.js
```

MV3 の service worker はクリップボードに直接書けないため、次の順で試す。

1. アクティブタブにスクリプトを注入してコピー (`navigator.clipboard.writeText`、だめなら `copy` イベント + `execCommand`)
2. `chrome://` ページなど注入できないタブでは、offscreen document を作ってそこでコピー

## 制限

- 対象は「現在のウィンドウ」で選択中のタブだけ
