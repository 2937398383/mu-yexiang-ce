// js/auth.js — 相册密码/口令弹窗（供 AI 工具页与主应用共用）
// 从 app.js 抽出（S5 拆分）；登录/解锁主弹窗依赖路由级回调，S5-Batch3 一并迁入

import { promptModal, $modalRoot, toast } from './ui.js';
import { api, saveToken, ADMIN_KEY, turnstileToken, renderTurnstileInto } from './api.js';
import { encUnlockAndStore } from './enc.js';

// 工具页（证件照 / 换风格）使用的相册解锁：弹密码框，成功后只存 token 并 resolve(true)，不跳转；取消返回 false
export function promptAlbumPassword(albumId, albumName) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => { if (!settled) { settled = true; resolve(ok); } };
    const m = promptModal(`输入「${albumName}」的密码`, `
      <div class="field">
        <input class="pw" id="f-pw" type="tel" inputmode="numeric" maxlength="6" placeholder="••••••" autocomplete="off">
      </div>
      <div id="turnstile-unlock"></div>`, async (mm) => {
      const pw = mm.querySelector('#f-pw').value;
      if (!/^\d{6}$/.test(pw)) throw { message: '请输入6位数字密码' };
      const ttoken = turnstileToken('turnstile-unlock');
      const r = await api('POST', `/albums/${albumId}/unlock`, { password: pw, turnstileToken: ttoken });
      saveToken(sessionStorage, 'unlock_' + albumId, r.token, r.expiresIn);
      finish(true);
    }, '解锁');
    m.querySelector('[data-r="cancel"]').addEventListener('click', () => finish(false));
    $modalRoot.querySelector('.modal-mask').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) finish(false);
    });
    m.querySelector('#f-pw').focus();
    renderTurnstileInto('turnstile-unlock');
  });
}

// ==================== 登录 / 相册解锁弹窗（主应用共用） ====================

export function showLoginModal() {
  const m = promptModal('管理员登录', `
    <div class="field">
      <label>管理密码</label>
      <input id="f-pw" type="password" autocomplete="current-password">
    </div>
    <div id="turnstile-login"></div>`, async (m) => {
    const pw = m.querySelector('#f-pw').value;
    const ttoken = turnstileToken('turnstile-login');
    const r = await api('POST', '/login', { password: pw, turnstileToken: ttoken });
    saveToken(localStorage, ADMIN_KEY, r.token, r.expiresIn);
    window.renderAuthArea(); window.render();
    toast('已登录');
  }, '登录');
  m.querySelector('#f-pw').focus();
  renderTurnstileInto('turnstile-login');
}


export function showUnlockModal(albumId, albumName, isEnc = false) {
  const fieldHtml = isEnc
    ? `<div class="field">
         <label>加密口令（解密相册内容）</label>
         <input id="f-pw" type="password" autocomplete="current-password" placeholder="输入创建时设置的口令">
         <div class="hint">口令错误无法解密；口令丢失将永久无法恢复。</div>
       </div>`
    : `<div class="field">
         <input class="pw" id="f-pw" type="tel" inputmode="numeric" maxlength="6" placeholder="••••••" autocomplete="off">
       </div>`;
  const m = promptModal(`输入「${albumName}」的${isEnc ? '口令' : '密码'}`, fieldHtml + `
    <div id="turnstile-unlock"></div>`, async (m) => {
    const pw = m.querySelector('#f-pw').value;
    const ttoken = turnstileToken('turnstile-unlock');
    if (isEnc) {
      if (!pw) throw { message: '请输入口令' };
      await encUnlockAndStore(albumId, pw, ttoken);
    } else {
      if (!/^\d{6}$/.test(pw)) throw { message: '请输入6位数字密码' };
      const r = await api('POST', `/albums/${albumId}/unlock`, { password: pw, turnstileToken: ttoken });
      saveToken(sessionStorage, 'unlock_' + albumId, r.token, r.expiresIn);
    }
    location.hash = '#/album/' + albumId;
    window.render();
  }, '解锁');
  m.querySelector('#f-pw').focus();
  renderTurnstileInto('turnstile-unlock');
}
