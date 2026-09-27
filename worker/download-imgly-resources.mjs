/* 下载 @imgly/background-removal 1.7.0 自托管资源到 web/vendor/imgly/
 * 只包含：onnxruntime-web 全套（wasm+mjs）+ small 模型 isnet_quint8
 * 运行：node worker/download-imgly-resources.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_BASE = 'https://staticimgly.com/@imgly/background-removal-data/1.7.0/dist/';
const OUT_DIR = path.join(__dirname, '..', 'web', 'vendor', 'imgly');

const manifest = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'imgly-resources.json'), 'utf8'
));

// 保留的资源：onnxruntime-web（threaded：CPU + jsep WebGPU；无 COOP/COEP 头时使用）+ small 量化模型
const wantedKeys = Object.keys(manifest).filter((k) =>
  (k.startsWith('/onnxruntime-web/') &&
    (!k.includes('.jsep.') || k.includes('threaded.jsep.'))) ||
  k === '/models/isnet_quint8'
);
const slimManifest = Object.fromEntries(wantedKeys.map((k) => [k, manifest[k]]));

// 收集所有需要的 chunk 文件名
const chunks = new Set();
for (const key of wantedKeys) {
  for (const c of manifest[key].chunks) chunks.add(c.name);
}

async function downloadChunk(name) {
  const dest = path.join(OUT_DIR, name);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return false;
  const resp = await fetch(DATA_BASE + name);
  if (!resp.ok) throw new Error(`${name} HTTP ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return true;
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(OUT_DIR, 'resources.json'),
    JSON.stringify(slimManifest, null, 0)
  );

  const list = [...chunks];
  console.log(`共 ${list.length} 个资源块需要下载`);
  let done = 0;
  for (const name of list) {
    const fetched = await downloadChunk(name);
    done += 1;
    const sizeMB = (fs.statSync(path.join(OUT_DIR, name)).size / 1048576).toFixed(2);
    console.log(`[${done}/${list.length}] ${fetched ? '已下载' : '已存在'} ${name} (${sizeMB}MB)`);
  }
  console.log('完成，资源目录：' + OUT_DIR);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
