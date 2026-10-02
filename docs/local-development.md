# 本机 Docker 开发环境

应用源码版本为 `1.7.2`，本地部署配置版本为 `1.7.2-dev.1`。使用独立的 `lanpower-dev` Compose 项目，在本机提供 **https://localhost:8443**。此入口仅供当前电脑使用；Cloud、登录身份与测试设备保存在独立开发卷中。

## 启动与登录

安装 Docker Desktop 并启用 Linux 容器后，在仓库根目录执行：

```powershell
./deploy/docker/start-dev.ps1
```

脚本启动 Docker、在缺少镜像时构建、首次生成随机开发密码，等待服务健康，将 Caddy 的本地根证书导入当前用户和本地计算机的受信任根证书存储，最后用正常证书校验检查 HTTPS。计算机证书导入会单独请求 Windows 管理员确认，Docker 和密码生成仍在当前用户下运行。它不需要公网域名。首次构建需要下载镜像和 Python 依赖；已有镜像时直接复用，不访问镜像仓库。

打开 https://localhost:8443，使用 `admin` 登录。密码保存在本机 `deploy/docker/private/dev-login.txt`；哈希保存在 `deploy/docker/.env.dev`。文件只允许当前 Windows 用户和 SYSTEM 访问，并被 Git 与 Docker 构建上下文排除。后续启动复用原密码；还可以在“设置”中添加本地 Passkey。

首次使用密码登录已完成开发账户初始化，因此 `/setup` 关闭。正式部署仍按原有 Passkey 初始化流程。请始终使用 `localhost` 地址；替换为 IP 会改变登录来源和 Passkey 域名。

## 连接本机 Windows 应用

Windows 后台服务以 `LocalSystem` 运行，不使用浏览器当前用户的证书存储。只给当前用户信任开发 CA 时，会出现“浏览器能打开，但 Windows 端连接 Cloud 失败”，服务日志包含 `SecureConnectionError -> AuthenticationException`。开发配置 `1.7.2-dev.1` 默认同时配置计算机级信任；已部署环境可只运行以下命令修复证书，无需重装应用或重建账户：

```powershell
./deploy/docker/trust-dev-certificate.ps1
```

完成管理员确认后，在 Windows 应用中填入 `https://localhost:8443` 并点击“连接 Cloud”，再到本机 Cloud 的“连接电脑”页面核对短配对码并允许连接。这里验证的是当前电脑与本机 Cloud；其他设备不能通过自己的 `localhost` 连接本机。

如果只测试浏览器，可使用 `./deploy/docker/start-dev.ps1 -WebOnly`，只配置当前用户证书信任。该选项不保证系统账户运行的 Windows 后台服务能够连接。所有方式都保持 HTTPS 证书校验，不添加忽略证书验证的代码。

## 日常开发

`cloud_app` 和 `cloud_remote` 以只读方式挂载到容器。修改 `cloud_app/app` 或 `cloud_remote` 中的 Python 文件后，服务会自动重载；修改模板、CSS 和 JavaScript 后刷新浏览器。修改本地部署文件后，重新运行启动脚本；数据库迁移文件改动后重启 Cloud。

修改依赖或 Dockerfile 后显式重建镜像：

```powershell
./deploy/docker/start-dev.ps1 -Build
```

常用操作在仓库根目录执行：

```powershell
# 查看状态、日志与健康结果
docker compose -p lanpower-dev -f deploy/docker/compose.dev.yml ps
docker compose -p lanpower-dev -f deploy/docker/compose.dev.yml logs --tail 80 cloud caddy
Invoke-RestMethod https://localhost:8443/healthz

# 重启应用，保留账户与测试数据
docker compose -p lanpower-dev -f deploy/docker/compose.dev.yml restart cloud

# 停止开发环境；再次运行启动脚本即可恢复
docker compose -p lanpower-dev -f deploy/docker/compose.dev.yml stop
```

Cloud 使用普通用户和只读根文件系统；宿主机只发布回环 `8443`。微信通知密钥和旧 Gateway 配置在此环境中置空。初始设备列表为空，可用于页面、授权和模拟设备接口测试。实际 Windows 应用已有的 Cloud 连接不会自动切换；手机、路由器或其他电脑无法访问本机 `localhost`，跨设备联调需单独配置受信任的 HTTPS 地址。

## 数据、备份与证书

`lanpower-dev_cloud-data` 保存测试数据库，`lanpower-dev_caddy-data` 保存本地 CA 与证书私钥，`lanpower-dev_caddy-config` 保存代理运行配置。保留这三个卷，以及私有 `.env.dev`。不要运行带 `-v` 的 `down` 或删除这些卷。

再次执行启动脚本时，会通过无网络的 SQLite 辅助容器备份现有开发库并检查完整性，将副本保存到被忽略的 `deploy/docker/backups/`，之后才启动或更新应用。Cloud 停止或容器已移除时也能先备份，避免新代码启动迁移早于备份。备份与开发数据仅用于本地，不应用来覆盖正式云端数据库。若数据卷存在而 `.env.dev` 丢失，脚本会停止，要求恢复配置，避免重置账户。日常停止请使用 `stop`。

证书公开部分保存在 `deploy/docker/private/dev-root.crt`。若浏览器在导入前已打开，关闭并重新打开浏览器后再访问；不需要关闭证书验证。彻底停用开发环境后，可移除脚本输出的开发 CA 指纹对应证书，计算机证书移除需在管理员 PowerShell 中执行：

```powershell
# 将 <开发 CA 指纹> 替换为启动脚本输出的值，仅移除该开发证书。
Remove-Item -LiteralPath 'Cert:\CurrentUser\Root\<开发 CA 指纹>'
Remove-Item -LiteralPath 'Cert:\LocalMachine\Root\<开发 CA 指纹>'
```

## 本机部署验证（2026-10-02）

本轮更新前先备份开发 SQLite 数据库并通过完整性检查；本机 Docker 使用 Cloud `1.7.2`、开发配置 `1.7.2-dev.1`，保留原数据卷、`.env.dev`、登录身份和开发证书。更新后 `/healthz` 返回 `1.7.2`，Cloud 和 Caddy 均为 healthy。数据库完整性、外键及 10 张身份/配置表与升级前备份一致。

Docker Hub 连接超时后，沿用本机既有镜像的相同依赖，重新安装 `1.7.2` 分发包并覆盖当前运行源码；58 个运行文件摘要与源码一致，包版本和运行版本一致，依赖检查通过。正常 HTTPS 证书校验、真实管理员密码登录和 1440/390px 页面验证通过。开发库目前没有配对设备，远程桌面下载及电源交互在隔离设备环境验证，未执行真实电源操作。正式服务器未更新。

## 历史本机部署验证（2026-10-01）

Cloud `1.7.0` 与 Caddy `2.11.4` 已在 Docker Desktop 启动，开发镜像标签为 `lanpower-cloud:1.7.0-dev.1`，两个容器均为 healthy。首次直连 Docker Hub 超时，本次核对本机缓存依赖与当前声明一致，并用已逐字节核对的 54 个应用运行文件构建离线镜像；包版本、运行版本与源码一致，依赖完整性检查通过。日常启动直接复用此镜像，显式 `-Build` 仍需镜像仓库和包源可达。

Windows HTTPS 检查与 Chromium 浏览器均通过正常证书校验。实际管理员密码登录、安全 Cookie、七个主要页面在 1440/390px 下共 14 组布局检查、空设备接口、SSE 状态流及匿名访问限制通过，浏览器无脚本错误。源码文件时间戳触发的 Python 自动重载已实测，随后 HTTPS 恢复正常。

停止容器后重新执行启动脚本，SQLite 一致备份和完整性检查通过，23 张表的内容摘要、登录配置及开发 CA 均保持不变；数据库迁移为 `0009_automation`、日志模式为 WAL。开发环境采用全新测试数据，未连接真实设备或执行电源动作。此次只在本地提交开发部署配置与说明，不发布远程资源。

## Windows 本机连接修复（2026-10-01）

开发配置 `1.7.0-dev.1` 只验证并配置了当前用户的证书信任，实际 `LocalSystem` 服务在请求本机配对接口时出现 `HttpRequestException:SecureConnectionError -> AuthenticationException`。现场核对发现开发 CA 存在于 `CurrentUser\Root`，但不在 `LocalMachine\Root`。

`1.7.0-dev.2` 增加独立的证书修复脚本，并由启动入口默认调用；管理员权限仅用于导入计算机证书。补齐同一张开发 CA 后，无需修改 Windows 程序或重启服务，通过实际服务 IPC 调用配对接口成功获得短码和正确的本机批准地址，验证用等待状态随后取消。此检查没有兑换新设备凭据；正式转到本机 Cloud 仍需用户在网页批准。原服务身份、Cloud 连接和 LAN 配对保持不变，未执行电源动作。更新后的开发启动脚本在 Windows PowerShell 5.1 下通过，运行前备份测试库，Cloud 和代理均保持健康。
