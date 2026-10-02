# 一次性运维脚本存档

部署域名/DNS 排查阶段的一次性脚本（Cloudflare API 查询、域名接管验证等），已完成使命归档于此。
脚本多使用相对路径或硬编码域名，如需重跑请先移回 `worker/` 根目录。
仍在使用的脚本保留在 `worker/` 根目录：`apply-cors.cjs`（R2 CORS）、`download-imgly-resources.mjs`（本地 AI 模型资源）。
