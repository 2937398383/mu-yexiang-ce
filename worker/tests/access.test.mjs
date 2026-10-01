// 访问控制矩阵：加密相册在任何情况下都不可被匿名/无关 token 访问
// （回归用例：GET /api/photos/:id/url 曾因漏查 encrypted 被判定为公开相册）
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { canAccessAlbum } from '../src/index.js';
import { timingSafeEqualStr } from '../src/auth.js';

const ALBUM_ID = 'album-1';

describe('canAccessAlbum', () => {
  const cases = [
    // [说明, auth, album, 期望]
    ['匿名 + 公开相册 → 允许', null, { id: ALBUM_ID, password_hash: null, encrypted: 0 }, true],
    ['匿名 + 数字密码相册 → 拒绝', null, { id: ALBUM_ID, password_hash: 'x', encrypted: 0 }, false],
    ['匿名 + 加密相册 → 拒绝', null, { id: ALBUM_ID, password_hash: null, encrypted: 1 }, false],
    ['匿名 + 加密相册（无数字密码）→ 拒绝', null, { id: ALBUM_ID, password_hash: null, encrypted: 1 }, false],
    ['管理员 + 加密相册 → 允许', { role: 'admin' }, { id: ALBUM_ID, password_hash: null, encrypted: 1 }, true],
    ['解锁 token + 对应加密相册 → 允许', { role: 'album', albumId: ALBUM_ID }, { id: ALBUM_ID, password_hash: null, encrypted: 1 }, true],
    ['解锁 token + 其他加密相册 → 拒绝', { role: 'album', albumId: 'other' }, { id: ALBUM_ID, password_hash: null, encrypted: 1 }, false],
    ['分享 token + 对应相册 → 允许', { role: 'share', albumId: ALBUM_ID }, { id: ALBUM_ID, password_hash: 'x', encrypted: 0 }, true],
    ['分享 token + 其他相册 → 拒绝', { role: 'share', albumId: 'other' }, { id: ALBUM_ID, password_hash: 'x', encrypted: 0 }, false],
    ['collect token + 对应相册 → 拒绝（只可上传不可读）', { role: 'collect', albumId: ALBUM_ID }, { id: ALBUM_ID, password_hash: 'x', encrypted: 0 }, false],
  ];

  for (const [label, auth, album, expected] of cases) {
    test(label, () => {
      assert.equal(canAccessAlbum(auth, album), expected);
    });
  }
});

describe('timingSafeEqualStr（常量时间比较）', () => {
  test('相同内容 → true', async () => {
    assert.equal(await timingSafeEqualStr('abc123', 'abc123'), true);
  });

  test('不同内容 → false', async () => {
    assert.equal(await timingSafeEqualStr('abc123', 'abc124'), false);
    assert.equal(await timingSafeEqualStr('', 'x'), false);
  });

  test('不同长度 → false（不抛异常，SHA-256 归一化后比较）', async () => {
    assert.equal(await timingSafeEqualStr('short', 'a-much-longer-value'), false);
  });

  test('空字符串两侧相等 → true', async () => {
    assert.equal(await timingSafeEqualStr('', ''), true);
  });
});
