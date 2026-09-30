# 墨页 0.2.0 验证记录

验证日期：2026-09-29。当前机器为 macOS Apple Silicon；协作服务器为 Alibaba Cloud Linux 3 x86_64。

## 自动测试及真实联调

- TypeScript、Vite、Electron 主进程/preload、TypeScript 服务端均编译成功。
- 30 项单元及模拟协议测试：原有 20 项全部通过；新增 10 项覆盖 Yjs 并发收敛、重复更新、本人撤销、删除不复活、非法文档拒绝、SQLite 待发送操作重启恢复、写盘失败回滚、历史恢复/条目删除时保存个人恢复副本、账号缓存隔离、服务维护时保留待同步操作。
- OpenAI 兼容与 Claude 模拟服务覆盖碎片化 UTF-8 流、取消、鉴权错误、限流/超时相关错误、提前断流和参数差异。没有使用用户付费 API Key。
- 原有个人写作 Electron E2E：书架、设定、卷章大纲、AI 初稿/选段/摘要、冲突确认、写盘失败重试、导入导出、快照、备份恢复、立即关闭与重启持久化。
- 两个真实 macOS Electron 客户端通过本机可断线代理连接实际 ECS HTTPS/WSS：同段编辑、本人撤销、远程光标、组合输入事件期间推迟远程更新、双方离线合并、离线关闭重启、只读客户端、恢复共享历史后的本地恢复副本。
- AI 协作实测使用本机模拟模型：生成期间另一成员改稿；拒绝冲突确认不写入，确认后保存共享版本；候选稿仅生成者本机可见；相对选区润色保留他人在段尾的修改；完整共享备份恢复成独立个人作品。
- CodeMirror 双客户端实际粘贴 22.5 万字符、2.5 万行章节，验证同步后的末尾编辑与再次替换；编辑器使用独立滚动视口维持虚拟渲染。
- 实际服务端额外回归：22.5 万字符中文正文、不同章节同时编辑、设定/卷纲更新、章节归属和结构调整、删除条目、停用账号即时关闭连接、共享历史完整备份；应用容器重启后已确认正文与重启前完全一致。
- PostgreSQL 备份已实际恢复至独立测试数据库，作品和历史版本数量与原库一致；未用测试覆盖生产库。
- ECS 80/443 外部访问成功、可信 IP TLS 证书有效、HTTPS/WSS 联调成功。Certbot 正式证书 `renew --dry-run --no-random-sleep-on-renew` 成功。每日备份和 12 小时续期定时器已启用，备份定时器已实际执行。

## 并发与延迟

`scripts/collab-protocol.ts` 对实际公网 WSS 建立 10 个独立 Yjs 客户端，使用已授权的测试编辑者会话。每端发送 8 次中文增量，发送与接收各增加 50 ms 延迟（额外 RTT 100 ms）。

- 共 80 次编辑，所有客户端最终文本一致。
- 从本地编辑到服务器提交后的确认，P95 为 **641 ms**，低于 1 秒目标。
- 重复消息没有产生重复内容，双方离线副本重连后合并。
- 覆盖跨作品越权、只读写入拒绝、撤销权限、AI 原文冲突和旧同步代次拒绝。

本次延迟测量来自短文本验收作品，未将长篇全部历史的最坏负载等同于上述结果。原始指标保存在 `test-results/collab-protocol.json`。

## 安装包与平台边界

- 已生成 macOS arm64、x64 DMG/ZIP 和 Windows x64 NSIS EXE，版本 0.2.0。
- macOS arm64 最终打包应用已实际启动，验证 SQLite WASM、关闭前保存、重启持久化、深色模式及最小窗口布局；最终安装包也通过上述双客户端协作、离线恢复、AI 冲突与 22.5 万字符编辑完整联调。
- Windows 安装包在 macOS 交叉构建，未在 Windows 系统实际安装或启动；Intel macOS 未在 Intel 设备实测。
- 自动中文测试使用 Unicode 输入与 composition 事件；尚未人工逐一验证 macOS 拼音、微软拼音等系统候选窗行为。
- 真实五家模型服务需用户自行填写有效密钥再验证；模拟通过不等于真实 API 已通过。
- 安装包未签名，macOS 未公证，使用默认应用图标。GitHub Actions 双平台构建工作流已配置，但未在此会话推送运行。
- 历史版本是全书快照，本机 SQLite 为 sql.js 原子文件持久化；未做长期大规模资料库性能基准或历史压缩。服务端备份保留在同一台 ECS，尚未配置异地灾备。

## 复现入口

```sh
npm test
npm run build
npm run build:server
npm run test:e2e
node scripts/packaged-smoke.mjs
```

实际 ECS 的协作测试使用 `.runtime/test-admin-bootstrap.json` 中的独立验收账号；该文件及生成的会话不纳入仓库。首次测试前通过 `server/admin.ts` 创建该验收管理员，再运行：

```sh
npx esbuild scripts/collab-protocol.ts --bundle --platform=node --format=esm --packages=external --outfile=.runtime/collab-protocol.mjs
node .runtime/collab-protocol.mjs
node scripts/collab-smoke.mjs
npx esbuild scripts/collab-regression.ts --bundle --platform=node --format=esm --packages=external --outfile=.runtime/collab-regression.mjs
node .runtime/collab-regression.mjs
```

这些联调脚本会创建测试账号与作品；回归脚本包含实际应用容器重启，应在维护窗口运行。完成最终打包版联调并备份后，已用 `deploy/cleanup-validation.sql` 清理 5 部验收作品与 8 个测试账号；仅保留正式 `admin` 账号。`admin` 管理员未被测试使用，保持首次登录待改密状态。

## 最后复核

最后复核期间 SSH 与 HTTPS 曾暂时不可达，用户反馈发生余额预警并已处理。恢复后，外网 HTTPS 健康检查返回 `0.2.0`，最终 macOS arm64 安装包通过完整协作联调，验收数据清理已完成。正式管理员未用于测试，首次登录仍须修改临时密码。

## 2026-09-30 用户管理更新验证

- `npm test`：37 项全部通过；新增账号接口鉴权、创建与重复用户名、显示名称校验、会话保留/撤销、两种权限查询一致性、停用账号授权限制、本机名称缓存及撤权后的离线文本恢复测试。
- `npm run build` 与 `npm run build:server` 均通过；Vite 保留原有大包及静态/动态混合导入提示。修改文件格式检查和 `git diff --check` 通过。
- `node scripts/user-management-smoke.mjs`：真实 Electron、临时 SQLite 和本机模拟 API 验证搜索、类型筛选、创建、重复提交拦截、改名、保存失败重试、保存成功但刷新失败、独立密码重置、停用/启用以及两个权限入口。截图为 `test-results/user-management.png` 与 `test-results/member-management.png`。
- 在指定 ECS 上使用独立 PostgreSQL 数据库 `moye_users_verify_20260930_v1` 执行 `scripts/user-management-integration.ts` 的构建产物：真实账号生命周期、首次改密、名称更新保留会话、WebSocket 1012 重连、权限撤销/停用后的 1008 断连、重置密码撤销登录、权限查询一致性及非法请求均通过。测试库已清理，没有使用生产账号运行写入测试。
- 通过 sudo 更新 `/opt/moye/dist-server` 并运行现有 `deploy/update.sh`。服务端 SHA-256：`40ed95e51059db6aea3b76f99b9620e8f83922ebbdeaa105243491157e528b9a`，与本地构建一致；应用、数据库、Nginx 均健康，公网 `/health` 返回成功，新接口未登录返回 401。
- 升级前数据库备份：`/opt/moye/migration-backups/pre-update-20260930T091108Z.dump`；代码备份：`/opt/moye/migration-backups/server-before-users-20260930.tar`；旧镜像保留为 `moye-app:previous`。部署前后生产表数量保持为账号 3、作品 1、成员关系 1、版本 4。
- 本次已构建并验证桌面源码，但未重新生成 DMG/EXE 安装包；服务器部署不会改变已安装客户端的界面。新界面需使用本次桌面构建，现有客户端仍可使用旧接口。
