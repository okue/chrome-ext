#!/usr/bin/osascript -l JavaScript
// Native messaging host for HTML Clipboard (macOS).
// Chrome extensions cannot put files on the clipboard, so the extension asks
// this script to do it. Pasting then attaches the file, as after ⌘C in Finder.
//
// Request:  { path }        an existing local file
//           { name, html }  HTML to save as <name>.html in a temporary folder
// Response: { ok: true, path } or { ok: false, error }
ObjC.import('AppKit');

function run() {
  let response;
  try {
    const path = filePath(readMessage());
    copyFileToClipboard(path);
    response = { ok: true, path };
  } catch (error) {
    response = { ok: false, error: String(error.message || error) };
  }
  writeMessage(response);
}

// A message is UTF-8 JSON preceded by its length as a 32-bit integer in native
// (little-endian) byte order.
function readMessage() {
  const stdin = $.NSFileHandle.fileHandleWithStandardInput;
  const header = bytes(stdin.readDataOfLength(4));
  if (header.length < 4) throw new Error('メッセージを受け取れませんでした。');
  const length = header.reduce((sum, byte, i) => sum + byte * 2 ** (8 * i), 0);
  const body = stdin.readDataOfLength(length);
  return JSON.parse($.NSString.alloc.initWithDataEncoding(body, $.NSUTF8StringEncoding).js);
}

function writeMessage(message) {
  const body = $(JSON.stringify(message)).dataUsingEncoding($.NSUTF8StringEncoding);
  const header = [0, 8, 16, 24].map(shift => (body.length >>> shift) & 0xff);
  const stdout = $.NSFileHandle.fileHandleWithStandardOutput;
  stdout.writeData($(String.fromCharCode(...header)).dataUsingEncoding($.NSISOLatin1StringEncoding));
  stdout.writeData(body);
}

// Latin-1 maps each byte to one character, which gives the byte values.
function bytes(data) {
  const text = $.NSString.alloc.initWithDataEncoding(data, $.NSISOLatin1StringEncoding).js;
  return [...text].map(char => char.charCodeAt(0));
}

function filePath(request) {
  const files = $.NSFileManager.defaultManager;
  if (typeof request.path === 'string') {
    const isDirectory = Ref();
    if (!files.fileExistsAtPathIsDirectory(request.path, isDirectory) || isDirectory[0]) {
      throw new Error('ファイルが見つかりません: ' + request.path);
    }
    return request.path;
  }
  if (typeof request.html !== 'string') throw new Error('不正なメッセージです。');

  // The folder is emptied first, so it holds only the latest copied file.
  const folder = $.NSTemporaryDirectory().js + 'html-clipboard';
  files.removeItemAtPathError(folder, null);
  if (!files.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(folder, true, $(), null)) {
    throw new Error('一時フォルダを作れませんでした。');
  }
  const path = folder + '/' + fileName(request.name);
  if (!$(request.html).writeToFileAtomicallyEncodingError(path, true, $.NSUTF8StringEncoding, null)) {
    throw new Error('一時ファイルを書き込めませんでした。');
  }
  return path;
}

function fileName(title) {
  const base = String(title ?? '')
    .replace(/[\/\\:\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+/, '')
    .slice(0, 100)
    .trim() || 'page';
  return /\.html?$/i.test(base) ? base : base + '.html';
}

function copyFileToClipboard(path) {
  const pasteboard = $.NSPasteboard.generalPasteboard;
  pasteboard.clearContents;
  if (!pasteboard.writeObjects($.NSArray.arrayWithObject($.NSURL.fileURLWithPath(path)))) {
    throw new Error('クリップボードに書き込めませんでした。');
  }
}
