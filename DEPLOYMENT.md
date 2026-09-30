# 墨页 0.2.0 协作服务运维

## 已部署环境

- 桌面连接地址：`https://114.215.182.66`。这是 API/WSS 服务，没有网页编辑器。
- SSH：`ecs-user@114.215.182.66:22`。部署目录 `/opt/moye`，Compose 配置 `/opt/moye/deploy/compose.yml`。
- Alibaba Cloud Linux 3 x86_64，Docker 26.1.3、Compose 2.27.0；PostgreSQL 17、Node.js 24、Nginx 1.28，单实例。
- 外部 80/443 已实际连通。数据库仅在容器网络中，未映射宿主机端口。
- Certbot 5.4.0 已签发可信公网 IP 证书，使用 `shortlived` 配置。已验证 HTTPS/WSS 和 `renew --dry-run`。
- 初始管理员账号为 `admin`。临时密码见本机 `.runtime/管理员登录信息.txt`，首次登录必须修改。未将明文密码写入此文档或仓库。

## 桌面使用

1. 安装 0.2.0，打开个人书架右上角「多人协作」，输入上述地址与管理员账号。
2. 修改临时密码后，在「管理账号」创建成员。临时密码至少 12 位，成员首次登录需修改；不提供公开注册。
3. 新建协作作品，或「发布个人作品副本」。发布只上传选中的作品正文、设定与大纲；原作、AI 配置、候选稿和个人历史仍保留本机。
4. 在作品中的成员管理分配编辑者或只读者。管理员可以停用账号、重置密码、归档/删除作品和恢复共享版本。
5. 已打开的作品可离线编辑文本。新增、删除、排序、移动、导入、AI 采纳需要联网。点击同步状态可重试本机保存。
6. 其他人删除条目、管理员恢复历史或撤销权限后，未同步修改会转到个人书架的「离线恢复副本」，可继续编辑或导出。
7. 「备份」在线导出完整共享作品和全部历史；在个人书架恢复会生成独立本地副本。共享版本界面展示最近 100 条，完整历史保留在服务器和备份中。

AI 密钥与候选稿只存在各自电脑中。协作服务器不代理付费模型调用；只有采纳后的文字会同步。公网服务器连接不允许明文 HTTP，本机开发服务可使用 localhost HTTP。

## SSH 与状态检查

本仓库 `scripts/ecs.sh` 在一次临时 SSH agent 中加载密钥，结束后退出 agent；密钥不会复制到服务器。默认密钥路径为用户提供的 `~/Downloads/key1.pem`，也可通过 `MOYE_SSH_KEY` 指定。

```sh
scripts/ecs.sh 'cd /opt/moye/deploy && sudo docker compose ps'
scripts/ecs.sh 'cd /opt/moye/deploy && sudo docker compose logs --tail=100 app nginx'
scripts/ecs.sh 'sudo systemctl list-timers moye-backup.timer moye-renew.timer --no-pager'
curl --fail https://114.215.182.66/health
```

容器使用 `unless-stopped` 自动重启，设有健康检查，日志每个容器最多 3 份 × 10 MB。备份或续期失败可通过 `systemctl --failed`、`journalctl -u moye-backup -u moye-renew` 检查。

## 数据库备份与恢复

`moye-backup.timer` 每天 03:20（服务器 Asia/Shanghai，另有最多 5 分钟随机延迟）执行 PostgreSQL custom-format 备份，验证归档可读后才轮换；`/opt/moye/backups` 保留最近 7 份。升级前备份单独保存在 `/opt/moye/migration-backups`，不参与每日轮换。

```sh
scripts/ecs.sh 'sudo bash /opt/moye/deploy/backup.sh'
```

已经在独立数据库实际执行 `pg_restore` 并核对作品和版本数量。整库恢复会替换服务器全部账号、成员和作品，先确认备份路径，再执行：

```sh
sudo bash /opt/moye/deploy/restore-database.sh --replace-database /opt/moye/backups/moye-YYYYMMDDTHHMMSSZ.dump
```

脚本先再备份当前库，停应用、事务恢复、清除会话并递增同步代次，然后重启。客户端需重新登录；旧代次的离线稿会保留为个人副本。若恢复失败，应用保持停止，应检查错误后恢复服务。数据库备份不含个人 AI 密钥；它包含作品与账号的密码哈希。备份仍在同一台 ECS，主机/磁盘整体损坏需要另行配置异地备份。

## 证书续期

`moye-renew.timer` 每 12 小时运行一次。脚本调用 Certbot 检查续期，成功后验证 Nginx 配置并重新加载证书。不要关闭安全组 80 端口，否则 HTTP-01 验证无法完成。当前 IP 证书有效期约 6 天，不能沿用 90 天证书的检查频率。

```sh
sudo bash /opt/moye/deploy/renew.sh
cd /opt/moye/deploy
sudo docker compose run --rm certbot renew --cert-name 114.215.182.66 --dry-run --non-interactive --no-random-sleep-on-renew
```

[Let’s Encrypt IP 证书说明](https://letsencrypt.org/2026/03/11/shorter-certs-certbot)

## 更新与应用回退

本机先运行测试和 `npm run build:server`。仅上传 `dist-server`、服务端锁文件、Dockerfile 和必要运维脚本；不要上传 `.runtime`、私钥、安装包、个人资料库或本机 AI 配置，也不要覆盖服务器 `.env`、证书或正在使用的 `nginx.conf`。

```sh
npm run build:server
COPYFILE_DISABLE=1 tar -cf - dist-server deploy/Dockerfile deploy/package.json deploy/package-lock.json .dockerignore | scripts/ecs.sh 'tar -xf - -C /opt/moye'
scripts/ecs.sh 'sudo bash /opt/moye/deploy/update.sh'
```

更新脚本先单独备份数据库、将当前镜像标记 `moye-app:previous`，再构建启动新应用并检查健康。失败自动换回上一镜像。手动回退：

```sh
cd /opt/moye/deploy
sudo env APP_VERSION=previous docker compose up -d --no-deps app
sudo docker compose exec -T nginx nginx -s reload
```

应用镜像回退不会自动回滚数据库。当前迁移是兼容的建表操作；未来破坏性迁移必须先评估旧镜像兼容性，必要时显式恢复迁移前数据库备份。

## 重建主机

安装 Docker/Compose，将已构建的 `dist-server` 和 `deploy` 上传 `/opt/moye`。在 `deploy/.env` 生成新的长随机 `DB_PASSWORD`，设文件权限 600。先使用 `nginx.bootstrap.conf` 作为 `nginx.conf` 启动，再签发证书：

```sh
sudo docker compose up -d --build
sudo docker compose run --rm certbot certonly --non-interactive --agree-tos --register-unsafely-without-email --preferred-profile shortlived --webroot -w /var/www/acme --ip-address 114.215.182.66 --cert-name 114.215.182.66
cp nginx.tls.conf nginx.conf
sudo docker compose exec -T nginx nginx -s reload
sudo cp moye-*.service moye-*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now moye-backup.timer moye-renew.timer
```

管理员通过受保护的本地 JSON 文件（`username`、`displayName`、`password`、`admin:true`）从标准输入交给 `docker compose exec -T app node dist-server/admin.mjs` 创建。切勿把密码写进命令参数或日志。恢复已有数据库则无需再创建管理员。

当前 ECS 无法直连 Docker Hub 时使用 DaoCloud 镜像代理获取了基础镜像，再标记为标准镜像名；应用依赖按锁文件从 npm 镜像安装。重建时按网络环境选择可访问的可信镜像源。

## 2026-09-30 账号管理更新

本次增加账号改名与按用户查询作品权限接口，不修改数据库结构。先部署服务端，再更新桌面客户端；旧客户端仍可使用原有创建、启停和重置接口。新界面位于 Electron 桌面应用，服务器不提供网页用户管理页面。

隔离数据库验证脚本为 `scripts/user-management-integration.ts`，仅接受数据库名 `moye_users_verify_*`。使用 esbuild 打包（Node ESM、packages external）后，在应用依赖环境中运行；必须将 `DATABASE_URL` 指向新建的一次性数据库，验证结束后删除该库。脚本覆盖真实 PostgreSQL、改名后的 WebSocket 重连、停用与重置会话失效、成员权限升降与撤销，不读取现有账号凭据。
