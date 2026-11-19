// キャッシュを保存するフォルダ名（マイドライブ直下に自動作成されます）
const CACHE_FOLDER_NAME = '_ipv_thumbnail_cache';

/**
 * Webアプリのエントリーポイント
 */
function doGet() {
  return HtmlService.createTemplateFromFile('index')
    .evaluate()
    .setTitle('ibisPaint (.ipv) ギャラリー')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * 指定フォルダ（またはマイドライブ全体）から .ipv ファイル一覧を取得
 * @param {string} folderId - 空文字の場合はマイドライブ全体から検索
 */
function getIpvFileList(folderId) {
  const query = folderId
    ? `'${folderId}' in parents and name contains '.ipv' and trashed = false`
    : `name contains '.ipv' and trashed = false`;

  const files = DriveApp.searchFiles(query);
  const list = [];

  while (files.hasNext()) {
    const file = files.next();
    if (file.getName().toLowerCase().endsWith('.ipv')) {
      list.push({
        id: file.getId(),
        name: file.getName(),
        updated: Utilities.formatDate(file.getLastUpdated(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm'),
        sizeKB: Math.round(file.getSize() / 1024),
        url: file.getUrl()
      });
    }
  }

  // 更新日時の新しい順にソート
  list.sort((a, b) => (a.updated < b.updated ? 1 : -1));
  return list;
}

/**
 * キャッシュを確認し、未作成または .ipv が更新されている場合のみ再抽出して保存する
 * @param {string} fileId
 */
function extractPreviewPngBase64(fileId) {
  try {
    const ipvFile = DriveApp.getFileById(fileId);
    const ipvUpdatedTime = ipvFile.getLastUpdated().getTime();

    // 排他ロック付きの関数で確実に単一のキャッシュフォルダを取得
    const cacheFolder = getOrCreateCacheFolder();
    const cacheFileName = `${fileId}.png`;
    const existingCaches = cacheFolder.getFilesByName(cacheFileName);

    let existingCacheFile = null;

    // 1. キャッシュが存在するか確認し、タイムスタンプを比較
    if (existingCaches.hasNext()) {
      existingCacheFile = existingCaches.next();
      const cacheUpdatedTime = existingCacheFile.getLastUpdated().getTime();

      // キャッシュの作成・更新日時が .ipv ファイル以降であればキャッシュを利用
      if (cacheUpdatedTime >= ipvUpdatedTime) {
        const cachedBytes = existingCacheFile.getBlob().getBytes();
        return {
          success: true,
          cached: true,
          dataUrl: 'data:image/png;base64,' + Utilities.base64Encode(cachedBytes)
        };
      }
    }

    // 2. キャッシュがない、または .ipv の方が新しい場合は末尾から再抽出
    const pngBytes = extractPngBytesFromIpvTail(ipvFile);
    if (!pngBytes) {
      return { success: false, error: 'プレビュー画像が見つかりませんでした' };
    }

    // 3. 古いキャッシュがあればゴミ箱へ移動し、新しいPNGをキャッシュとして保存
    if (existingCacheFile) {
      existingCacheFile.setTrashed(true);
    }
    const pngBlob = Utilities.newBlob(pngBytes, 'image/png', cacheFileName);
    cacheFolder.createFile(pngBlob);

    return {
      success: true,
      cached: false,
      dataUrl: 'data:image/png;base64,' + Utilities.base64Encode(pngBytes)
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * 排他ロック＋ダブルチェックでキャッシュフォルダを1つだけ取得・作成する
 */
function getOrCreateCacheFolder() {
  // 1. すでにフォルダがある場合はロックを取らずに即座に返す（高速パス）
  const fastCheck = DriveApp.searchFolders(`title = '${CACHE_FOLDER_NAME}' and trashed = false`);
  if (fastCheck.hasNext()) {
    return fastCheck.next();
  }

  // 2. 見つからない場合のみロックを取得して順番に処理
  const lock = LockService.getUserLock();
  lock.waitLock(15000);

  try {
    // 先行スレッドが作成済みか再確認
    const folders = DriveApp.searchFolders(`title = '${CACHE_FOLDER_NAME}' and trashed = false`);
    if (folders.hasNext()) {
      return folders.next();
    }
    return DriveApp.createFolder(CACHE_FOLDER_NAME);
  } finally {
    lock.releaseLock();
  }
}

/**
 * .ipv ファイルの末尾から逆走査してプレビューPNGのバイト配列を抽出する（50MB超対応）
 * @param {GoogleAppsScript.Drive.File} ipvFile
 * @return {number[]|null}
 */
function extractPngBytesFromIpvTail(ipvFile) {
  const fileId = ipvFile.getId();
  const totalSize = ipvFile.getSize();
  if (totalSize < 24) return null;

  const token = ScriptApp.getOAuthToken();
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;

  // まず末尾 256KB を取得（フッター + プレビューPNGが収まることが多いサイズ）
  const initialChunkSize = Math.min(totalSize, 262144);
  let bufferStart = totalSize - initialChunkSize;
  let buffer = fetchRangeBytes(url, token, bufferStart, totalSize - 1);

  let cursor = totalSize; // ファイル全体の末尾からスタート

  // 末尾から最大15レコード分遡って (1,5) のプレビューを探す
  for (let i = 0; i < 15 && cursor > 12; i++) {
    // 末尾4バイト [-(8+length) i32] を読むためにバッファ範囲を確認
    if (cursor - 4 < bufferStart) {
      bufferStart = Math.max(0, cursor - 65536);
      buffer = fetchRangeBytes(url, token, bufferStart, cursor - 1);
    }

    const negRecordLen = readInt32BE(buffer, (cursor - 4) - bufferStart);
    const recordLen = -negRecordLen; // レコード全体のバイト数 (8 + payloadLen + 4)

    if (recordLen <= 12 || cursor - recordLen < 0) {
      break; // 構造が想定外の場合は中断
    }

    const recordStart = cursor - recordLen;

    if (recordStart < bufferStart) {
      // レコードが初期バッファより前にまたがる場合はヘッダ32バイトを取得
      const headBuf = fetchRangeBytes(url, token, recordStart, Math.min(totalSize - 1, recordStart + 32));
      const kind = headBuf[0] & 0xFF;
      const type = headBuf[2] & 0xFF;

      if (kind === 1 && type === 5) {
        const layerId = readInt32BE(headBuf, 16); // 8(hdr) + 8(t)
        const imgKind = readInt32BE(headBuf, 20); // 8(hdr) + 12
        const pngLen = readUint32BE(headBuf, 26); // 8(hdr) + 18

        if (layerId === -1 && imgKind === 0 && pngLen > 0) {
          const pngStart = recordStart + 30;
          return fetchRangeBytes(url, token, pngStart, pngStart + pngLen - 1);
        }
      }
    } else {
      // すでに取得済みの末尾バッファ内にレコード全体が収まっている場合
      const localPos = recordStart - bufferStart;
      const kind = buffer[localPos] & 0xFF;
      const type = buffer[localPos + 2] & 0xFF;

      if (kind === 1 && type === 5) {
        const layerId = readInt32BE(buffer, localPos + 16);
        const imgKind = readInt32BE(buffer, localPos + 20);
        const pngLen = readUint32BE(buffer, localPos + 26);

        if (layerId === -1 && imgKind === 0 && pngLen > 0) {
          const pngLocalStart = localPos + 30;
          return buffer.slice(pngLocalStart, pngLocalStart + pngLen);
        }
      }
    }

    // 1つ前のレコードの末尾へ移動
    cursor = recordStart;
  }

  return null;
}

/**
 * 指定バイト範囲だけを Google Drive API から取得する
 */
function fetchRangeBytes(url, token, start, end) {
  const res = UrlFetchApp.fetch(url, {
    headers: {
      Authorization: 'Bearer ' + token,
      Range: `bytes=${start}-${end}`
    },
    muteHttpExceptions: true
  });

  const code = res.getResponseCode();
  if (code !== 206 && code !== 200) {
    throw new Error(`HTTP ${code}: 部分取得に失敗しました`);
  }
  return res.getContent();
}

/**
 * ビッグエンディアン符号なし32ビット整数を読み取る
 */
function readUint32BE(bytes, pos) {
  return (
    ((bytes[pos] & 0xFF) * 0x1000000) +
    (((bytes[pos + 1] & 0xFF) << 16) |
     ((bytes[pos + 2] & 0xFF) << 8) |
     (bytes[pos + 3] & 0xFF))
  );
}

/**
 * ビッグエンディアン符号付き32ビット整数を読み取る
 */
function readInt32BE(bytes, pos) {
  return (
    ((bytes[pos] & 0xFF) << 24) |
    ((bytes[pos + 1] & 0xFF) << 16) |
    ((bytes[pos + 2] & 0xFF) << 8) |
    (bytes[pos + 3] & 0xFF)
  );
}
