# 云看板

本仓库保存后台源代码。数据库、客户资料、密码、私钥和上传文件仅保存在服务器。

## 两台电脑协作

第一次：`git clone https://github.com/juice507/yunkanban.git`

每次开始：`git pull --ff-only`，再运行 `git switch -c feature/功能名称`。

完成修改：`git add .`、`git commit -m "说明修改内容"`、`git push -u origin HEAD`。
在 GitHub 上创建 Pull Request，合并到 main 后，另一台电脑先拉取再继续。
不要同时修改相同功能；有未提交修改时先提交，不要强制拉取或强制推送。

本机唯一工作目录建议为 `D:\项目\插件\yunkanban`。原来的“云插件”目录是历史副本，不再用于发布。

## 本地检查

Node.js 20 或以上。前端：`cd web`、`npm ci`、`npm run build`。
服务端：`cd server`、`npm ci`、`node --check server.js`。
本地运行服务需要单独配置测试数据库、AUTH_SECRET、ADMIN_INITIAL_PASSWORD 和订阅集成文件；不要复制生产数据库到仓库。

## 统一部署

服务器使用独立源码 checkout（例如 `/opt/yunkanban-source`），运行目录仍是 `/opt/yunkanban-admin`。
先在源码目录运行 `git pull --ff-only`，然后运行 `sudo bash scripts/deploy.sh`。
脚本只允许干净的 main 分支，使用部署锁、数据库和代码备份，编译前端并同步 Nginx 实际目录，最后验证版本。
运行数据不会被 Git 覆盖。部署版本可访问 `/k9m4x7q2/version.json`。

首次接入时脚本会从服务器现有代码迁移旧鉴权配置到 `.auth-secret`，保持现有登录兼容；此文件绝不提交。
`/opt/yunkanban-admin` 只用于运行，不直接编辑。两台电脑都通过本仓库的分支、PR 和同一个部署脚本发布。

## 初始状态

源码取自 2026-10-28 服务器当前文件。仅移除了硬编码的默认密码、鉴权回退值及店铺默认编号，改用运行配置。
