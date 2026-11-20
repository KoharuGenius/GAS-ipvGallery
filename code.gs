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
 * 指定フォルダから .ipv ファイル一覧を取得
 * @param {string} folderId - 空文字の場合はマイドライブ全体から検索
 */
function getIpvFileList(folderId) {
  const folder = DriveApp.getFolderById(folderId);
  const files = folder.getFiles(); // ゴミ箱内のファイルは自動的に除外される
  const list = [];

  while (files.hasNext()) {
    const file = files.next();
    if (file.getName().toLowerCase().endsWith('.ipv')) {
      const id = file.getId();
      const lastUpdated = file.getLastUpdated();
      list.push({
        id: id,
        name: file.getName(),
        updated: Utilities.formatDate(lastUpdated, 'Asia/Tokyo', 'yyyy/MM/dd HH:mm'),
        updatedTime: lastUpdated.getTime(),
        sizeKB: Math.round(file.getSize() / 1024),
        url: file.getUrl(),
        downloadUrl: `https://drive.google.com/uc?export=download&id=${id}`
      });
    }
  }

  // デフォルトは更新日時の新しい順
  list.sort((a, b) => b.updatedTime - a.updatedTime);
  return list;
}

/**
 * キャッシュを確認し、未作成または .ipv が更新されている場合のみ再抽出して保存する
 * @param {string} fileId
 */
function extractPreviewPngBase64(fileId, folderID) {
  try {
    const ipvFile = DriveApp.getFileById(fileId);
    const ipvUpdatedTime = ipvFile.getLastUpdated().getTime();

    // 排他ロック付きの関数で確実に単一のキャッシュフォルダを取得
    const cacheFolder = getOrCreateCacheFolder(folderID);
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
    const totalSize = ipvFile.getSize();
    if(totalSize < 24){
      return { success: false, error: 'ファイルサイズが小さすぎます' };   
    }
    const pngBytes = extractPngBytesFromIpvTail(fileId, totalSize);
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
function getOrCreateCacheFolder(folderID) {
  const parentFolder = DriveApp.getFolderById(folderID);

  // 1. ロック前の高速チェック（親フォルダー直下のみ検索）
  const fastCheck = parentFolder.getFoldersByName(CACHE_FOLDER_NAME);
  if (fastCheck.hasNext()) {
    return fastCheck.next();
  }

  // 2. 同時実行による重複作成を防ぐためのロック
  const lock = LockService.getUserLock();
  lock.waitLock(15000);

  try {
    // ロック取得後に再確認
    const folders = parentFolder.getFoldersByName(CACHE_FOLDER_NAME);
    if (folders.hasNext()) {
      return folders.next();
    }
    // 親フォルダー直下に新規作成
    return parentFolder.createFolder(CACHE_FOLDER_NAME);
  } finally {
    lock.releaseLock();
  }
}

/**
 * .ipv ファイルの末尾から逆走査してプレビューPNGのバイト配列を抽出する（50MB超対応）
 */
function extractPngBytesFromIpvTail(fileId,totalSize) {
  // PNGシグネチャ
  const PNG_SIG = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

  try {
    const token = ScriptApp.getOAuthToken();
    const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;

    // まず末尾 256KB を取得（フッター + プレビューPNGが収まることが多いサイズ）
    const initialChunkSize = Math.min(totalSize, 262144);
    let bufferStart = totalSize - initialChunkSize;
    let buffer = fetchRangeBytes(url, token, bufferStart, totalSize - 1);

    let cursor = totalSize; // ファイル全体の末尾からスタート

    // 末尾から最大15レコード分だけ遡って (1,5) のプレビューを探す
    for (let i = 0; i < 15 && cursor >= 12; i++) {
      // 末尾4バイト [-(8+length) i32] を読むためにバッファ範囲を確認
      if (cursor - 4 < bufferStart) {
        bufferStart = Math.max(0, cursor - 65536);
        buffer = fetchRangeBytes(url, token, bufferStart, cursor - 1);
      }

      const negRecordLen = readInt32BE(buffer, (cursor - 4) - bufferStart);
      // ★修正点: 末尾4バイトの値は -(8 + payloadLen) なので、レコード全体長は + 4 する
      const recordLen = -negRecordLen + 4;

      if (recordLen <= 12 || cursor - recordLen < 0) {
        break; // 構造が想定外の場合は中断
      }

      const recordStart = cursor - recordLen;
      let headBuf, headOffset;

      // レコードの先頭ヘッダ(8B) + (1,5)のメタデータ(22B) = 30バイトを読む
      if (recordStart < bufferStart) {
        // バッファ外にまたがる場合、先頭30バイトだけピンポイント取得
        headBuf = fetchRangeBytes(url, token, recordStart, Math.min(totalSize - 1, recordStart + 30));
        headOffset = 0;
      } else {
        // すでに取得済みの末尾バッファ内に収まっている場合（通信追加なし）
        headBuf = buffer;
        headOffset = recordStart - bufferStart;
      }

      const kind = headBuf[headOffset] & 0xFF;
      const type = headBuf[headOffset + 2] & 0xFF;

      if (kind === 1 && type === 5) {
        const layerId = readInt32BE(headBuf, headOffset + 16); // 8(hdr) + 8(t)
        const imgKind = readInt32BE(headBuf, headOffset + 20); // 8(hdr) + 12
        const pngLen = readUint32BE(headBuf, headOffset + 26); // 8(hdr) + 18

        if (layerId === -1 && imgKind === 0 && pngLen > 0) {
          const pngStart = recordStart + 30;
          let pngBytes;

          if (pngStart >= bufferStart && pngStart + pngLen <= bufferStart + buffer.length) {
            const localPngStart = pngStart - bufferStart;
            pngBytes = buffer.slice(localPngStart, localPngStart + pngLen);
          } else {
            pngBytes = fetchRangeBytes(url, token, pngStart, pngStart + pngLen - 1);
          }

          // PNGシグネチャ検証
          const isValidPng = PNG_SIG.every((b, idx) => (pngBytes[idx] & 0xFF) === b);
          if (!isValidPng) {
            return null;
          }

          return pngBytes;
        }
      }

      // 1つ前のレコードの末尾へ移動
      cursor = recordStart;
    }

    return { success: false, error: '末尾付近にプレビュー画像が見つかりませんでした' };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

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

function readUint32BE(bytes, pos) {
  return (
    ((bytes[pos] & 0xFF) * 0x1000000) +
    (((bytes[pos + 1] & 0xFF) << 16) |
     ((bytes[pos + 2] & 0xFF) << 8) |
     (bytes[pos + 3] & 0xFF))
  );
}

function readInt32BE(bytes, pos) {
  return (
    ((bytes[pos] & 0xFF) << 24) |
    ((bytes[pos + 1] & 0xFF) << 16) |
    ((bytes[pos + 2] & 0xFF) << 8) |
    (bytes[pos + 3] & 0xFF)
  );
}
