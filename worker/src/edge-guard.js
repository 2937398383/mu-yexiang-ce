// 应用层边缘防护：方法白名单 / 扫描路径拦截 / 攻击工具 UA 拦截 / 全局限流
// 在业务路由之前执行。限流依赖 D1，故障时降级放行（不因风控故障阻断正常服务）。

// ---------- 方法白名单 ----------
// HEAD：OG 爬虫/CDN 健康检查常用，与 GET 同等放行
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'OPTIONS']);

// ---------- 扫描/利用路径 ----------

// 命中即拦：常见 CMS 后台、敏感配置文件、暴露的 VCS、路径遍历、null 字节
const SCAN_PATH_RE =
  /(?:\/wp-(?:admin|login|config|content|includes)|\/xmlrpc\.php|\/\.env\b|\/\.(?:git|svn|hg|aws|docker)(?:\/|$)|\/phpmyadmin|\/pma\b|\/server-(?:status|info)|\/jmx-console|\/actuator\b|\/(?:config|configuration)\.php|\/c99\.php|\/r57\.php|\/webshell|\.\.(?:\/|%2f|%5c)|%2e%2e(?:%2f|%5c)|%00)/i;

// ---------- 攻击工具 UA ----------

const BAD_UA_RE =
  /(?:sqlmap|nikto|nmap|masscan|acunetix|nessus|netsparker|dirbuster|gobuster|wpscan|metasploit|whatweb|w3af|skipfish|zgrab|arachni|openvas|zaproxy|jaeles|dalfox|nuclei|fuzzdb|paros\s|webbandit|morfeus|libwww-perl)/i;

// ---------- 全局限流 ----------

const GLOBAL_RATE = 120;   // 每 IP 每分钟最多 120 次 API 请求

// 幂等读（GET/HEAD）走 isolate 内存窗口计数：尽力而为的软限流，
// 每个请求不再写 D1（免费层写配额 10 万行/天，此前读请求也各写一行是最大消耗者）
const memHits = new Map(); // minuteKey -> Map(ip -> count)
let memSweepMinute = '';

function memRateLimited(ip) {
  const mk = minuteKey();
  if (mk !== memSweepMinute) {
    memSweepMinute = mk;
    memHits.clear(); // 窗口整体过期：上一分钟的计数即废弃
  }
  let win = memHits.get(mk);
  if (!win) { win = new Map(); memHits.set(mk, win); }
  const n = (win.get(ip) ?? 0) + 1;
  win.set(ip, n);
  return n > GLOBAL_RATE;
}

// 写操作走 D1 原子计数（跨 isolate 一致，写操作频次远低于读，D1 写压力可控）
async function rateLimited(ip, env) {
  try {
    const row = await env.DB.prepare(
      `INSERT INTO rate_event (ip, minute, count) VALUES (?, ?, 1)
       ON CONFLICT(ip, minute) DO UPDATE SET count = rate_event.count + 1
       RETURNING count`
    ).bind(ip, minuteKey()).first();
    return (row?.count ?? 0) > GLOBAL_RATE;
  } catch {
    return false; // D1 故障降级放行
  }
}

function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

function minuteKey() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}

/**
 * 边缘检查
 * @returns {Response|null} 命中拦截返回 Response，放行返回 null
 */
export async function edgeGuard(request, env) {
  if (!ALLOWED_METHODS.has(request.method)) {
    return new Response(JSON.stringify({ ok: false, error: '请求方法不合法' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }

  const url = new URL(request.url);
  const ua = request.headers.get('User-Agent') || '';
  // OG/分享元信息路径允许空 UA：Pages Function 的服务端子请求默认不带 UA
  // （/s/:id 落地页靠这两个接口渲染分享卡片），其余路径空 UA 一律拦截
  const isMetaPath = url.pathname.startsWith('/api/og/') || url.pathname.startsWith('/api/share/');
  if (SCAN_PATH_RE.test(url.pathname) || BAD_UA_RE.test(ua) || (!ua.trim() && !isMetaPath)) {
    return new Response(JSON.stringify({ ok: false, error: '请求已被拦截' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }

  const ip = clientIp(request);
  const limited = (request.method === 'GET' || request.method === 'HEAD')
    ? memRateLimited(ip)
    : await rateLimited(ip, env);
  if (limited) {
    return new Response(JSON.stringify({ ok: false, error: '请求过于频繁，请稍后再试' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '60' },
    });
  }

  return null;
}
