/**
 * 指定された .ipv ファイルの末尾から逆走査し、50MB超でもプレビューPNGを抽出する
 * @param {string} fileId
 */
function extractPreviewPngBase64(fileId) {
  const PNG_SIG = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

  try {
    const file = DriveApp.getFileById(fileId);
    const totalSize = file.getSize();
    if (totalSize < 24) {
      return { success: false, error: 'ファイルサイズが小さすぎます' };
    }

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
            return { success: false, error: '抽出したデータが有効なPNGシグネチャと一致しません' };
          }

          return {
            success: true,
            dataUrl: 'data:image/png;base64,' + Utilities.base64Encode(pngBytes)
          };
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
