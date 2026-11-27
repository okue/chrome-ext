# HTML Clipboard

開いている HTML を、ファイルとしてクリップボードにコピーする Chrome 拡張 (macOS 専用)。Slack やメールに `⌘V` で貼ると、本文に展開されずにファイルとして添付される。Finder でファイルを `⌘C` したときと同じ状態になる。

- 外部通信なし
- 依存ライブラリなし (補助ツールは macOS 標準の `osascript` で動く)
- 権限は `activeTab` / `scripting` / `nativeMessaging` のみ。アイコンを押したタブにしかアクセスしない

## インストール

1. [ルートの README](../README.md#インストール-共通) の手順で、このディレクトリ (`html-clipboard/`) を読み込む
2. `chrome://extensions` に表示される HTML Clipboard の ID (32 文字の英字) をコピーする
3. リポジトリのルートで、補助ツールを Chrome に登録する

   ```sh
   ./html-clipboard/native-host/install.sh <拡張の ID>
   ```

補助ツールを登録していない状態でアイコンを押すと、実行すべきコマンド (ID 入り) がポップアップに出る。

## 使い方

1. コピーしたい HTML を Chrome で開く (ChatGPT からダウンロードした HTML なら、ダウンロード一覧からクリック)
2. ツールバーの HTML Clipboard を押す。すぐにコピーされ、ポップアップに結果が出る
3. Slack などで `⌘V`

| 開いているページ | コピーされるファイル |
|---|---|
| ローカルの HTML (`file://`) | 元のファイルそのもの (名前もそのまま) |
| Web ページ | 表示中の HTML を `<ページタイトル>.html` として一時フォルダに保存したもの |

## 仕組み

```
popup.js ──(Native Messaging)──▶ native-host/host.js ──▶ macOS のクリップボード
  { path }       ローカルファイル       osascript (JXA) で動く       public.file-url
  { name, html } Web ページ             Web ページは一時ファイルに保存
```

Chrome 拡張から使えるクリップボード API (`navigator.clipboard`) はテキスト・HTML・画像しか書けず、ファイルを置けない。そこで Native Messaging で Mac 側の補助スクリプトを起動し、`NSPasteboard` にファイルの URL を書き込んでもらう。

- 補助スクリプトはアイコンを押したときだけ起動し、常駐しない
- 呼び出せるのは、`install.sh` で登録した ID の拡張だけ (`allowed_origins`)
- クリップボードに置くのは実在する通常のファイルだけ
- Web ページの一時ファイルは `$TMPDIR/html-clipboard/` に 1 つだけ置く (次のコピーで前のファイルは消える)

`install.sh` が作るファイル:

| パス | 中身 |
|---|---|
| `~/Library/Application Support/html-clipboard/host` | `native-host/host.js` のコピー |
| `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/html_clipboard.json` | Chrome への登録 (補助スクリプトのパスと、呼び出しを許す拡張の ID) |

`install.sh --uninstall` で両方削除できる。

## 制限

- macOS 専用 (補助ツールが `osascript` と `NSPasteboard` を使うため)
- 拡張を別のディレクトリから読み込み直すと ID が変わる。そのときは新しい ID で `install.sh` を再実行する
- `native-host/host.js` を変更したら、`install.sh` を再実行してコピーし直す
- 選択範囲には関係なく、常にページ全体が対象
- Web ページは、JavaScript で書き換わったあとの表示中の HTML を保存する。画像や CSS ファイルは含まない。ログイン中のサイトでは、画面に見えない個人情報やトークンが含まれることがある
- `chrome://` や Chrome ウェブストアなど、拡張がスクリプトを注入できないページは対象外
