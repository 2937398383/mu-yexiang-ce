// 临时脚本：通过 DoH 查询域名的 NS 委派情况
const domain = 'cdc2937398383qqcom.dpdns.org';

async function doh(name, type) {
  const u = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`;
  const r = await fetch(u, { headers: { accept: 'application/dns-json' } });
  return r.json();
}

(async () => {
  // 1. 直接查该域名的 NS（递归解析器视角）
  const ns = await doh(domain, 'NS');
  console.log('NS answer:', JSON.stringify(ns.Answer || ns.Authority || [], null, 2));

  // 2. 查 dpdns.org 的权威 NS
  const parent = await doh('dpdns.org', 'NS');
  console.log('dpdns.org NS:', (parent.Answer || []).map((a) => a.data).join(', '));
})();
