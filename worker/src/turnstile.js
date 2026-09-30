// Cloudflare Turnstile 人机验证（服务端校验）
// 依赖 wrangler secret：TURNSTILE_SECRET（在 Cloudflare 控制台 → Turnstile 创建 Widget 后获得）
// 免费额度：10 次 siteverify/秒，个人自用足够。

/**
 * 校验 Turnstile token
 * @param {object} env   Worker 环境（读取 TURNSTILE_SECRET）
 * @param {string} token 前端传来的 turnstileToken
 * @param {string} ip    客户端 IP（CF-Connecting-IP）
 * @returns {Promise<{ok:boolean, error?:string, status?:number}>}
 */
export async function verifyTurnstile(env, token, ip) {
  // 未配置 secret 时降级放行：避免漏配导致管理员被锁在门外（本地调试也无需验证码）
  if (!env.TURNSTILE_SECRET) return { ok: true };
  if (!token) return { ok: false, error: '缺少人机验证，请刷新后重试', status: 400 };

  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET);
  form.append('response', token);
  form.append('remoteip', ip || '');

  const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: form,
  });
  const data = await resp.json();
  if (!data.success) return { ok: false, error: '人机验证失败，请重试', status: 403 };
  return { ok: true };
}
