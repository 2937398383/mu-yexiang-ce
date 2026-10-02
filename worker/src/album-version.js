// 相册数据版本号：任何照片/相册变更自增，用于相册列表与照片列表的 ETag 失效
// （原先在 index/trash/backfill/ai-tags/video-thumb 各复制一份，统一收敛到这里）
'use strict';

export async function bumpAlbumVersion(env, albumId) {
  try {
    await env.DB.prepare(
      `INSERT INTO album_version(album_id, v) VALUES(?, 1)
       ON CONFLICT(album_id) DO UPDATE SET v = v + 1`
    ).bind(albumId).run();
  } catch { /* 版本递增失败不影响主流程 */ }
}

export async function getAlbumVersion(env, albumId) {
  const row = await env.DB.prepare(
    'SELECT v FROM album_version WHERE album_id = ?'
  ).bind(albumId).first();
  return row?.v ?? 0;
}
