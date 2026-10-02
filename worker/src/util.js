// 通用小工具：HTTP 响应、UTC 时间窗口、data URI 解码
// 各 API 模块统一从这里 import，避免 json/fail 在多文件各写一份
'use strict';

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

export function fail(error, status = 400, extra = {}) {
  return json({ ok: false, error, ...extra }, status);
}

// UTC 自然日 "YYYY-MM-DD"（配额/限流窗口口径，与 Cloudflare 计费日界一致）
export function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

// data URI → Uint8Array
export function dataUriToBytes(dataUri) {
  const b64 = dataUri.slice(dataUri.indexOf(',') + 1);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
