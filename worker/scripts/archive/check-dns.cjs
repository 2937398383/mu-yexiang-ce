// 临时脚本：列出 zone DNS 记录，缺的补上 www/root -> Pages
const fs = require('fs');
const t = fs.readFileSync(__dirname + '/.cf-home/.wrangler/config/default.toml', 'utf8');
const token = t.match(/oauth_token = "([^"]+)"/)[1];
const ACCOUNT = '65e1870ebd61513b5e09664b1673a5ed';
const ZONE = '64ca2504e7eaab2fa188b884ce4063c6';
const H = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };

async function call(method, path, body, tries = 4) {
  let err;
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
        method,
        headers: H,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20000),
      });
      return { status: r.status, j: await r.json().catch(() => ({})) };
    } catch (e) {
      err = e;
      await new Promise((r) => setTimeout(r, 2500 * i));
    }
  }
  throw err;
}

(async () => {
  const list = await call('GET', `/zones/${ZONE}/dns_records?per_page=100`);
  console.log('existing records:');
  for (const r of list.j.result || []) {
    console.log(`  ${r.type} ${r.name} -> ${r.content} (proxied=${r.proxied})`);
  }
})();
