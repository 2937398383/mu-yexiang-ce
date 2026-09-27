// 临时脚本：检查 Cloudflare zone 是否激活
const fs = require('fs');
const t = fs.readFileSync(__dirname + '/.cf-home/.wrangler/config/default.toml', 'utf8');
const token = t.match(/oauth_token = "([^"]+)"/)[1];
const zone = 'cdc2937398383qqcom.dpdns.org';

(async () => {
  const r = await fetch(`https://api.cloudflare.com/client/v4/zones?name=${zone}`, {
    headers: { Authorization: 'Bearer ' + token },
  });
  const j = await r.json();
  if (!j.success) {
    console.log('API error:', JSON.stringify(j.errors));
    return;
  }
  const z = j.result[0];
  if (!z) {
    console.log('zone-not-found');
    return;
  }
  console.log('status:', z.status);
  console.log('assigned NS:', z.name_servers.join(', '));
  if (z.status === 'active') {
    console.log('ZONE_ID=' + z.id);
  }
})();
