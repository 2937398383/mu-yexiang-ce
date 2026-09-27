// 只查 DNS 记录，不修改
const fs = require('fs');
const t = fs.readFileSync(__dirname + '/.cf-home/.wrangler/config/default.toml', 'utf8');
const token = t.match(/oauth_token = "([^"]+)"/)[1];

(async () => {
  const r = await fetch('https://api.cloudflare.com/client/v4/zones/64ca2504e7eaab2fa188b884ce4063c6/dns_records?per_page=100', {
    headers: { Authorization: 'Bearer ' + token },
  });
  const j = await r.json();
  if (!j.success) {
    console.log('API error:', JSON.stringify(j.errors));
    return;
  }
  for (const rec of j.result) {
    console.log(`${rec.type.padEnd(6)} ${rec.name.padEnd(45)} -> ${rec.content} (proxied=${rec.proxied})`);
  }
})();
