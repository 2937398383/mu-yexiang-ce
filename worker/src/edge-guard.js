// 应用层边缘防护：方法白名单 / 扫描路径拦截 / 攻击工具 UA 拦截 / 全局限流
// 在业务路由之前执行。限流依赖 D1，故障时降级放行（不因风控故障阻断正常服务）。

// ---------- 方法白名单 ----------

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS']);

// ---------- 扫描/利用路径 ----------

// 命中即拦：常见 CMS 后台、敏感配置文件、暴露的 VCS、路径遍历、null 字节
const SCAN_PATH_RE =
  /(?:\/wp-(?:admin|login|config|content|includes)|\/xmlrpc\.php|\/\.env\b|\/\.(?:git|svn|hg|aws|docker)(?:\/|$)|\/phpmyadmin|\/pma\b|\/server-(?:status|info)|\/jmx-console|\/actuator\b|\/(?:config|configuration)\.php|\/c99\.php|\/r57\.php|\/webshell|\.\.(?:\/|%2f|%5c)|%2e%2e(?:%2f|%5c)|%00)/i;

// ---------- 攻击工具 UA ----------

const BAD_UA_RE =
  /(?:sqlmap|nikto|nmap|masscan|acunetix|nessus|netsparker|dirbuster|gobuster|wpscan|metasploit|whatweb|w3af|skipfish|zgrab|arachni|openvas|zaproxy|jaeles|dalfox|nuclei|fuzzdb|paros\s|webbandit|morfeus|libwww-perl)/i;

// ---------- 全局限流 ----------

const GLOBAL_RATE = 120;   // 每 IP 每分钟最多 120 次 API 请求

function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

function minuteKey() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}

async function rateLimited(request, env) {
  try {
    const row = await env.DB.prepare(
      `INSERT INTO rate_event (ip, minute, count) VALUES (?, ?, 1)
       ON CONFLICT(ip, minute) DO UPDATE SET count = rate_event.count + 1
       RETURNING count`
    ).bind(clientIp(request), minuteKey()).first();
    return (row?.count ?? 0) > GLOBAL_RATE;
  } catch {
    return false; // D1 故障降级放行
  }
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
  if (SCAN_PATH_RE.test(url.pathname) || BAD_UA_RE.test(ua) || !ua.trim()) {
    return new Response(JSON.stringify({ ok: false, error: '请求已被拦截' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }

  if (await rateLimited(request, env)) {
    return new Response(JSON.stringify({ ok: false, error: '请求过于频繁，请稍后再试' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '60' },
    });
  }

  return null;
}
