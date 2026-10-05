// js/ui.js — UI 原语：DOM 根引用、提示、模态框、格式化（全站共用，无业务依赖）
// 从 app.js 抽出（S5 拆分），函数体与原实现保持一致

export const $view = document.getElementById('view');
export const $authArea = document.getElementById('auth-area');
export const $modalRoot = document.getElementById('modal-root');
export const $toastRoot = document.getElementById('toast-root');

export function toast(msg, isErr = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (isErr ? ' err' : '');
  el.textContent = msg;
  $toastRoot.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function fmtSize(n) {
  if (!n) return '';
  if (n > 1 << 30) return (n / (1 << 30)).toFixed(1) + ' GB';
  if (n > 1 << 20) return (n / (1 << 20)).toFixed(1) + ' MB';
  return Math.max(1, Math.round(n / 1024)) + ' KB';
}

// AI 批量任务进度展示：文本 + 进度条
export function renderAiProgress(tipEl, { action, total, done, failed, remaining, quotaLeft, failReasons }) {
  const processed = done + failed;
  const pct = total ? Math.min(100, Math.round((processed / total) * 100)) : 0;
  const text = `${action} ${done} 张${failed ? ` · ${failed} 张失败` : ''} · 剩余 ${remaining} 张 · 今日额度剩 ${quotaLeft}`;
  const reasonsHtml = (failReasons?.length ? `<div class="ai-progress-reasons">失败原因：${esc(failReasons.join(' · '))}</div>` : '');
  tipEl.innerHTML = `
    <div class="ai-progress-text">${esc(text)}</div>
    <div class="ai-progress-bar"><div class="ai-progress-fill" style="width:${pct}%"></div></div>
    <div class="ai-progress-pct">${processed}/${total}（${pct}%）</div>
    ${reasonsHtml}`;
}

// 视频时长：125 → "2:05"
export function fmtDuration(s) {
  s = Math.max(0, Math.round(Number(s) || 0));
  const m = Math.floor(s / 60), sec = s % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

// ==================== 模态框 ====================

export function closeModal() { $modalRoot.innerHTML = ''; }
export function openModal(html) {
  $modalRoot.innerHTML = `<div class="modal-mask"><div class="modal">${html}</div></div>`;
  $modalRoot.querySelector('.modal-mask').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal();
  });
  return $modalRoot.querySelector('.modal');
}

export function confirmModal(title, text, okLabel = '确定', danger = false) {
  return new Promise((resolve) => {
    const m = openModal(`
      <h2>${esc(title)}</h2>
      ${text ? `<div class="warn">${esc(text)}</div>` : ''}
      <div class="actions">
        <button class="btn" data-r="0">取消</button>
        <button class="btn ${danger ? 'danger' : 'primary'}" data-r="1">${esc(okLabel)}</button>
      </div>`);
    m.querySelectorAll('[data-r]').forEach((b) =>
      b.addEventListener('click', () => { closeModal(); resolve(b.dataset.r === '1'); }));
  });
}

export function promptModal(title, fieldsHtml, onOk, okLabel = '确定') {
  const m = openModal(`
    <h2>${esc(title)}</h2>
    ${fieldsHtml}
    <div class="form-err" hidden></div>
    <div class="actions">
      <button class="btn" data-r="cancel">取消</button>
      <button class="btn primary" data-r="ok">${esc(okLabel)}</button>
    </div>`);
  m.querySelector('[data-r="cancel"]').addEventListener('click', closeModal);
  const okBtn = m.querySelector('[data-r="ok"]');
  const errEl = m.querySelector('.form-err');
  okBtn.addEventListener('click', async () => {
    try {
      errEl.hidden = true;
      okBtn.disabled = true;
      await onOk(m);
      closeModal();
    } catch (err) {
      okBtn.disabled = false;
      errEl.textContent = err.message || '操作失败';
      errEl.hidden = false;
      // 429 失败锁定：按钮倒计时禁用（弹框关闭后定时器自动清理）
      if (err.status === 429 && err.data?.retryAfterMinutes) {
        let left = Math.max(1, err.data.retryAfterMinutes) * 60;
        okBtn.disabled = true;
        const timer = setInterval(() => {
          if (!okBtn.isConnected) { clearInterval(timer); return; }
          left -= 1;
          const mm = Math.floor(left / 60);
          const ss = String(left % 60).padStart(2, '0');
          okBtn.textContent = `已锁定 ${mm}:${ss}`;
          if (left <= 0) {
            clearInterval(timer);
            okBtn.disabled = false;
            okBtn.textContent = okLabel;
          }
        }, 1000);
      }
    }
  });
  return m;
}

export const pwField = (id, label = '6位数字密码') => `
  <div class="field">
    <label>${label}</label>
    <input class="pw" id="${id}" type="tel" inputmode="numeric" maxlength="6" placeholder="••••••" autocomplete="off">
    <div class="hint">留空表示不设密码（公开相册）</div>
  </div>`;
