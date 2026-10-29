# 独立界面方案 01

本目录与生产 `web/`、`server/` 完全独立，不连接业务接口。

- `index.html`：可直接打开的单文件设计稿，包含示例数据和交互。
- `verify.cjs`：使用 Playwright 验证搜索、抽屉、多选、列设置、深色模式与窄屏布局。
- `preview-light.png` / `preview-dark.png`：本地检查截图，不提交到仓库。

本机启动：`python -m http.server 4178 --bind 127.0.0.1 --directory design-preview`。
也可双击 index.html 打开。运行检查需要可用的 Playwright 与 Chromium。

确认视觉方案后再迁移至 React / Ant Design 的正式页面；不通过生产部署脚本发布本目录。
