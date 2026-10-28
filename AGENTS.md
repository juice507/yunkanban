# 项目约定

- 开始工作先 `git status` 和 `git pull --ff-only`；存在未提交修改时先核对归属。
- 不直接编辑生产运行目录，不上传数据库、密钥、Cookie、客户资料或日志。
- 通过分支和 PR 合并；禁止 force push 到 main。
- 发布使用 `scripts/deploy.sh`，同时更新 Node 前端目录与 Nginx 公网目录。
- 完成部署必须检查公网 HTML、version.json 以及受影响 API；内部端口成功不代表公网成功。
- 所有发货、回复规则修改要有明确业务授权；检查时优先使用只读接口。
