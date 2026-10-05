// js/auth.js — 相册密码/口令弹窗（供 AI 工具页与主应用共用）
// 从 app.js 抽出（S5 拆分）；登录/解锁主弹窗依赖路由级回调，S5-Batch3 一并迁入

import { promptModal, $modalRoot } from './ui.js';
import { api, saveToken, turnstileToken, renderTurnstileInto } from './api.js';

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
