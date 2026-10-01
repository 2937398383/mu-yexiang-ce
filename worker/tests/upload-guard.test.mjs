// 上传白名单 / MIME 权威映射（服务端 Content-Type 锁定的判定核心）
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveUploadExt, EXT_MIME } from '../src/index.js';

describe('resolveUploadExt', () => {
  test('常见图片扩展名 → 权威 MIME', () => {
    for (const [ext, mime] of [
      ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['png', 'image/png'],
      ['gif', 'image/gif'], ['webp', 'image/webp'], ['avif', 'image/avif'],
      ['heic', 'image/heic'], ['bmp', 'image/bmp'], ['tiff', 'image/tiff'],
    ]) {
      const r = resolveUploadExt(`IMG_0001.${ext}`);
      assert.ok(r, `${ext} 应在白名单`);
      assert.equal(r.ext, ext);
      assert.equal(r.kind, 'image');
      assert.equal(r.mime, mime);
    }
  });

  test('视频扩展名 → kind=video', () => {
    for (const ext of ['mp4', 'webm', 'mov', 'm4v']) {
      const r = resolveUploadExt(`clip.${ext}`);
      assert.ok(r, `${ext} 应在白名单`);
      assert.equal(r.kind, 'video');
      assert.ok(r.mime.startsWith('video/'));
    }
  });

  test('SVG 被拒绝（可携带脚本，防存储型 XSS）', () => {
    assert.equal(resolveUploadExt('evil.svg'), null);
    assert.equal(resolveUploadExt('evil.SVG'), null);
  });

  test('白名单外扩展名一律拒绝（html/可执行/无扩展名）', () => {
    assert.equal(resolveUploadExt('page.html'), null);
    assert.equal(resolveUploadExt('shell.sh'), null);
    assert.equal(resolveUploadExt('payload.exe'), null);
    assert.equal(resolveUploadExt('encrypted'), null);  // 无扩展名
    assert.equal(resolveUploadExt('.hidden'), null);
    assert.equal(resolveUploadExt('archive.tar.gz'), null);
  });

  test('扩展名大小写不敏感', () => {
    assert.equal(resolveUploadExt('photo.JPG')?.ext, 'jpg');
    assert.equal(resolveUploadExt('video.MP4')?.ext, 'mp4');
  });

  test('映射表与白名单一一对应（无未知扩展名）', () => {
    for (const ext of ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'heif', 'tif', 'tiff', 'avif',
      'mp4', 'webm', 'mov', 'm4v']) {
      assert.ok(EXT_MIME[ext], `${ext} 必须有权威 MIME`);
      assert.match(EXT_MIME[ext], /^(image|video)\//);
    }
  });
});
