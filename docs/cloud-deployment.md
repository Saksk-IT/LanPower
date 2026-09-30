# Cloud 部署

推荐在 Linux 服务器使用 Docker Compose。新部署的 Caddy 配置负责 HTTPS，Cloud 默认采用 SQLite，数据和证书持久保存在 Docker 数据卷。详细命令见 [Docker 快速部署](../deploy/docker/README.md)。

## 配置选择

| 场景 | 设置 |
|---|---|
| 全新部署 | `.env.example` 复制为 `.env`；填写 `LANPOWER_DOMAIN`，保留 `COMPOSE_PROFILES=https` 和 `LANPOWER_DATA_MOUNT=cloud-data` |
| 已有 HTTPS 代理 | `COMPOSE_PROFILES` 留空，设置实际 `LANPOWER_PUBLIC_URL`，代理到 `127.0.0.1:8765` |
| 已有目录数据 | 保留 `.env`；`LANPOWER_DATA_MOUNT=./data` 或不设置，目录需允许 UID 10001 写入 |
| 旧版 Gateway | 叠加 `compose.legacy.yml`，挂载原 `cloud.json` 与 `relay.db` |

Windows 和网关只向 Cloud 发起出站 HTTPS，不需要额外入站端口。公网只开放 80/443，Cloud 应用本身的 8765 仅绑定回环。只有浏览器与 Windows 时，不配置旧 Gateway 文件也能运行。

## 初始化

启动后，检查 `/healthz`。通过 `docker compose exec cloud cat /var/lib/lanpower-cloud/setup-code` 读取服务器上的初始化码。在实际域名的 `/setup` 创建管理员 Passkey，保存首次显示的 10 个恢复码。初始化完成后关闭 `/setup`，不会在重启后重新开放。

Passkey 验证绑定 HTTPS 地址，`LANPOWER_PUBLIC_URL` 应与用户实际访问地址一致。改变域名或协议需要重新安排 Passkey 和设备注册，不要随意切换。

## 旧版兼容

保留原 `.env`、LAN/Gateway/Client 凭据和原数据库。将私有 `cloud.json` 放入 `deploy/docker/private/`，其中旧数据库路径设为 `/var/lib/lanpower-cloud/relay.db`。旧数据挂载继续指向原目录，然后执行：

```sh
docker compose -f compose.yml -f compose.legacy.yml up -d --build
```

旧配置由服务器保存，不需要上传到网页。新 Cloud 会登记 Legacy Gateway、Windows 和客户端；`/api/v1/*` 继续由兼容协议处理。原 Gateway 无需立刻重新安装。

## 更新

先 [备份数据](migration-v1.md)，再使用经过验证的源码或固定镜像更新。Cloud 启动自动升级平台数据库，当前迁移为 `0008_persistent_clients`；未撤销手机的凭据改为长期，保留现有身份、凭据哈希、历史和撤销状态。先升级 Cloud `1.5.1`，再更新小程序 `2.0.2`，见 [长期授权升级](mini-program-v2.md#长期授权升级)。不要使用本地测试数据库覆盖服务器数据，不要运行 `docker compose down -v`。

更新后分别检查本机与公网 `/healthz`、网页登录、设备状态和只读状态命令，再安排真实电源验收。每次部署仍应核对其实际证书、端口和设备状态。

## 本地部署验证（2026-09-30）

Cloud Docker 镜像已成功构建；容器以 UID 10001 在全新数据卷启动，平台数据库迁移到 `0006_gateway_commands`，重启后数据保留。`lanpower-cloud migrate-v1` 命令入口可用。Caddy 2.11.4 配置校验与本地测试证书 HTTPS 转发通过。完整 Compose 的 Cloud + Caddy 启动、Cloud 健康检查及 HTTPS 访问均通过。文档中的 SQLite 备份命令已执行，备份恢复至独立数据卷后，完整性检查、数据和 Cloud 启动均通过。验证资源均为隔离测试数据。

以上为隔离环境检查，最初不包含公网或真实设备；后续部署证据如下。

## 指定公网环境验证（2026-09-30）

按用户授权清除旧 LanPower，未备份旧环境；在指定 Ubuntu 24.04 服务器部署 Cloud + Caddy。真实域名由 Cloudflare 代理，Caddy 已申请正式 Let’s Encrypt 证书。服务器回环 HTTP、源站 HTTPS 和经 Cloudflare 的公网 `/healthz` 均返回 200，产品版本为 `1.4.0`、协议为 `2`，实际平台迁移为 `0007_client_versions`。

Cloud 容器以 UID 10001 运行，根文件系统只读，数据目录可写；应用端口 8765 仅监听回环，公网 Web 由 80/443 提供。旧 Cloud 进程和反向代理配置已停止并清除。真实 Passkey 初始化完成，`/setup` 已关闭；恢复码单独保存在受限的本机私有目录，部署凭据、域名、地址和截图不纳入仓库。

本机 Windows 的短码批准、状态上报、凭据轮换和服务重启重连已通过。没有网关时，公网网页只读 `status` 由 `windows_direct` 返回 `completed`；六个主要页面在桌面和手机宽度均可访问且无页面横向溢出。随后实际路由器注册 v2 并关联电脑，有网关时仍优先 Windows 直连。

正式平台数据库通过 SQLite 在线备份 API 创建临时一致副本，并在无网络、无公开端口的独立容器恢复。迁移版本、管理员、Passkey、恢复码、设备、会话和审计记录数量一致，完整性检查为 `ok`，恢复后的 `/healthz` 正常且 `/setup` 仍为 404。生产容器持续健康；测试副本和容器已清理。此检查覆盖平台数据库，证书卷的扩展验证如下。真实电源动作、微信及网关剩余验收见 [开发与验收清单](implementation-checklist.md)。

随后扩展为证书与平台联合恢复：复制 Caddy 的证书数据卷和配置卷，以及部署文件；在隔离容器中恢复平台数据库，使用恢复出的正式证书和私钥提供 HTTPS，再转发到恢复后的 Cloud。TLS 校验使用默认信任库和原域名，`/healthz` 返回 200，身份与设备记录数量一致，`/setup` 为 404。两个容器共享无外部网络的命名空间，均不发布端口；测试配置关闭自动证书申请，生产 Cloud 与 Caddy 均未重启。测试容器、副本、证书归档和临时数据库已清理。

上述检查证明平台数据库及 Caddy 卷可恢复并提供可信 HTTPS；整机启动和真实网络切换仍需另行验收。

## 手机长期授权更新（2026-09-30）

正式 Cloud 从 `1.5.0` 更新为 `1.5.1`，迁移至 `0008_persistent_clients`。更新前使用 SQLite 一致备份并校验数据库，备份部署配置和原源码，保留旧镜像；先在无网络、无公开端口的隔离副本运行迁移，确认身份、设备、凭据与撤销状态保留，再短暂停止 Cloud 创建切换时快照并更新。原 Cloud 数据卷、Caddy 与证书卷均保留，未修改 Windows 或网关程序。

更新后数据库完整性与外键检查通过，管理员、Passkey、恢复码、设备、手机授权与历史记录全部保留；已撤销的授权没有自动恢复。容器健康；回环及公网 HTTPS `/healthz` 返回 `1.5.1` / 协议 `2`，`/setup` 保持关闭。公网检查使用正常客户端 User-Agent；默认 Python User-Agent 被现有入口返回 403，不改动入口策略。

用临时手机会话经公网验证：短期访问过期可续期；丢弃首个续期成功响应后，同一长期凭据再次续期成功；设备列表可读取，实际 Windows 与网关在线；撤销后续期和访问均为 401。验证会话已清理，未执行真实电源动作。备份与摘要保存在服务器部署目录的受限 `backups/mobile-auth-*` 目录；地址、密钥和数据库不纳入仓库。手机端仍需通过微信开发者工具重新预览或上传小程序 `2.0.2`，再完成真机验收。

## 控制台界面更新（2026-10-01）

正式 Cloud 从 `1.5.1` 更新为 `1.6.0`。日期按北京时间记录，服务器备份目录使用 UTC 时间。更新前创建 SQLite 一致备份，保存源码、部署配置与摘要，并保留原镜像。候选镜像沿用已部署镜像的依赖，使用干净构建的应用包；在无网络的隔离副本验证启动迁移、全部表数据不变和模板编译，再切换正式容器。本轮没有新增数据库迁移，仍为 `0008_persistent_clients`。

切换后核对数据库完整性和外键，账户、Passkey、恢复码、设备身份及手机授权保留；原数据卷继续挂载，Caddy 和证书服务未重启。Windows、小程序和路由器网关无需为此次界面更新升级。备份与回滚材料保存在服务器受限的 `backups/cloud-ui-*` 目录；回滚应用时继续使用实时数据，不以旧快照覆盖生产数据库。

119 项 Cloud 测试与状态脚本通过。隔离 Chromium 检查七个主要页面和登录页在 1440、390、320 像素宽度下无横向溢出，覆盖确认取消/单次提交、设备管理、二维码、配对错误、网络中断禁用操作与恢复同步。

公网通过正常 HTTPS 证书校验：`/healthz` 返回 `1.6.0` / 协议 `2`；七个主要页面在桌面和手机宽度渲染正常，浏览器无脚本错误；真实 Windows 与网关在线，旧 `/system` 跳转设置，登录页 Passkey 入口可见，`/setup` 仍关闭。公网浏览器验收全部为 GET 请求，未发出真实电源指令；短效验证会话已删除。真实部署截图和凭据仅保存在私有临时目录，不纳入仓库。本轮未推送远程仓库或发布 Release。
