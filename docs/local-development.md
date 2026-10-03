# 本机 Docker 开发环境

应用源码版本为 `1.14.0`，小程序 `2.1.2`，本地部署配置版本为 `1.14.0-dev.1`。使用独立的 `lanpower-dev` Compose 项目，在本机提供 **https://localhost:8443**。此入口仅供当前电脑使用；Cloud、登录身份与测试设备保存在独立开发卷中。

## 启动与登录

安装 Docker Desktop 并启用 Linux 容器后，在仓库根目录执行：

```powershell
./deploy/docker/start-dev.ps1
```

脚本启动 Docker、在缺少镜像时构建、首次生成随机开发密码，等待服务健康，将 Caddy 的本地根证书导入当前用户和本地计算机的受信任根证书存储，最后用正常证书校验检查 HTTPS。计算机证书导入会单独请求 Windows 管理员确认，Docker 和密码生成仍在当前用户下运行。它不需要公网域名。首次构建需要下载镜像和 Python 依赖；已有镜像时直接复用，不访问镜像仓库。

打开 https://localhost:8443，使用 `admin` 登录。密码保存在本机 `deploy/docker/private/dev-login.txt`；哈希保存在 `deploy/docker/.env.dev`。文件只允许当前 Windows 用户和 SYSTEM 访问，并被 Git 与 Docker 构建上下文排除。后续启动复用原密码；还可以在“设置”中添加本地 Passkey。

首次使用密码登录已完成开发账户初始化，因此 `/setup` 关闭。正式部署仍按原有 Passkey 初始化流程。请始终使用 `localhost` 地址；替换为 IP 会改变登录来源和 Passkey 域名。

## 连接本机 Windows 应用

Windows 后台服务以 `LocalSystem` 运行，不使用浏览器当前用户的证书存储。只给当前用户信任开发 CA 时，会出现“浏览器能打开，但 Windows 端连接 Cloud 失败”，服务日志包含 `SecureConnectionError -> AuthenticationException`。开发配置 `1.8.0-dev.1` 默认同时配置计算机级信任；已部署环境可只运行以下命令修复证书，无需重装应用或重建账户：

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

## 本机 1.13.1 双端控制（2026-10-03）

实际官方桌面与 LanPower 产品共享连接完成双向暂停、引导、原生队列显示；共享服务用户管道与无 Bearer Header 桌面网关验证通过。Windows 76 项、Cloud 200 项与浏览器检查通过；安装版双端入口实际点击成功，真实 Cloud/Agent/Host/共享服务/官方桌面链路通过新会话与刷新检查。当前官方额度用完阻止此次完整网页任务复测，详见 [验证记录](codex-remote-takeover.md)。

本机镜像为 `lanpower-cloud:1.13.1-dev.1`，正常 HTTPS 返回 1.13.1，Cloud/Caddy 健康。切换前使用 SQLite backup API 备份，完整性与九张身份/配置表的主键及引用保持，原数据卷、登录配置与 CA 保留。Windows Setup 就地安装，Service、Desktop、Host、版本化共享服务与构建匹配；LAN 配置与用户项目授权保留，Cloud 地址和设备身份一致，续期凭据正常轮换。原有官方工作窗口与运行中的共享服务未重启。

实际登录浏览器确认 Host 就绪，另一网页仍持有控制连接，本轮未抢占它完成真实网页点击到桌面的整链路验收。启用时点击 Windows「打开 Codex 双端控制」，在新增官方窗口继续会话；旧进程的活动任务不能在线迁移。远程服务器、公网/微信真机及真实审批 UI 待验收，未推送或发布。

## 历史本机 1.12.0 小程序第一版（2026-10-03）

新增原生 Codex 页面、手机 Bearer WSS 入口和显式开发权限。Cloud **193 项**、Windows **71 项**、小程序旧版/v2/Codex 交互、WCC/WCSC 三页面编译、320/390/430px 浅色/深色/审批/键盘布局检查通过。布局由微信编译结果在浏览器 DOM 适配器中渲染，包含微信 v2 默认按钮规则；不是微信真机验证。

本机 Docker 已切换为 `lanpower-cloud:1.12.0-dev.1`，运行和分发包版本均为 1.12.0，Cloud/Caddy 健康。切换前使用 SQLite backup API 一致备份并检查完整性；升级后完整性及外键检查通过，九张身份/配置表的主键与引用摘要一致。原数据卷、登录配置、开发 CA 保留，无数据库迁移变更。

Windows Setup 从本轮独立构建目录就地安装至现有目录，三个安装程序版本 1.12.0.0，二进制哈希与构建产物一致，服务 Running。原 LAN 配置和用户 Codex 授权逐字节保留，Cloud 地址与设备身份一致。升级前确认 Host 只有只读目录查询进程，无远程执行会话；原生 Codex 桌面程序未重启。

通过正常证书验证的实际 HTTPS 登录创建临时手机授权，使用小程序的 CloudClient 与 CodexConnection 实现经原生 API 适配器访问本机 Cloud。确认电源手机不能开发、网页修改 Codex 权限后原凭据直接可用、WSS Bearer Header 与子协议握手通过，安装 Host 已就绪。另一真实控制页面仍占用电脑，服务返回 controller_busy，本轮未抢占它读取真实项目或执行任务。临时手机已撤销、测试浏览器已退出。

第一版截图和导入说明见 [小程序 Codex Remote](codex-remote-mini-program.md)。尚未进行实际微信、5G 或真实手机任务验收；远程服务器未更新、未推送或发布。工作区同时存在其他开发中的改动，本轮构建与提交仅纳入小程序、手机鉴权和相关版本/文档，未将其他桌面共享控制改动纳入安装包。

## 历史本机 1.11.0 会话交接更新（2026-10-02）

开发镜像为 `lanpower-cloud:1.11.0-dev.1`，Cloud 与 Caddy 健康，正常 HTTPS、登录和运行/分发包版本通过。更新前用 SQLite backup API 保存一致备份，升级后完整性为 ok；九张身份及授权配置表的主键/引用摘要与备份一致，原数据卷、登录设置与 CA 保留。

Windows Setup 已就地安装到现有目录，三个程序哈希与构建产物匹配，服务 Running；原 LAN 配置、用户 Codex 授权保留，Cloud 地址与设备身份一致，续期凭据正常轮换。原生桌面进程未重启。Windows 71 项、Cloud 187 项及浏览器 1440/390/320px 检查通过；官方 Runtime 实测会话占用、释放、暂停后的自动释放及同会话恢复。真实浏览器验证安装 Host 就绪，因另一控制页面在使用，未抢占其连接完成真实网页任务验收。原生桌面同时控制仍未完成，未更新远程服务器或发布。

## Codex Remote 1.10 本机验证（2026-10-02）

本机 Cloud / Windows 更新至 `1.10.0`，开发镜像为 `lanpower-cloud:1.10.0-dev.1`。升级前使用 SQLite backup API 保存开发库并检查完整性，保留数据卷、登录配置和开发 CA；升级后运行及分发包版本均为 1.10.0，Cloud 和 Caddy 健康，完整性检查正常且无外键错误。原 Windows 配置、用户 Codex 授权、设备身份和 Cloud 地址保留，续期凭据正常轮换；三个安装程序的二进制哈希与构建产物一致。

Windows 68 项、Cloud 186 项及浏览器 1440/390/320px 检查通过。真实只读 Runtime 请求确认桌面会话的运行/结束状态和近期消息；页面控制流程使用模拟响应。另一真实网页仍持有控制连接，本轮未抢占或中断它完成实际双端网页控制验证。未部署公网服务器或推送远程仓库。

## 历史 Codex Remote 1.9 本机验证（2026-10-02）

本机 Cloud / Windows 更新至 `1.9.0`，开发镜像为 `lanpower-cloud:1.9.0-dev.1`。正常 Docker 构建通过，切换前使用 SQLite backup API 备份并检查完整性，原数据卷、登录配置和开发 CA 保留。Setup 就地更新三项 Windows 程序并核对哈希；LAN 配置、用户授权保留，Cloud 地址和设备身份不变，凭据正常续期轮换。

真实 Service WSS Agent、用户 Host 和浏览器已自动识别项目/工作目录及近期会话，并读取桌面占用的真实会话；没有接管或中断桌面工作。独立临时目录中的官方 Runtime 实际接收引导并回复，实际中断确认通过，文件内容保持。1440/390/320px 浏览器检查覆盖自动连接、项目分组、消息详情、引导、暂停、旧缓存清除及桌面只读，交互使用受控 Runtime 响应。桌面跨 Runtime 的已运行任务控制、完整历史分页与手机 5G 仍未验收。

## Codex Remote 1.8 历史本机验证（2026-10-02）

本机 Cloud 镜像正常重建为 `lanpower-cloud:1.8.0-dev.1`，新增 WebSocket 运行依赖，更新前使用 SQLite 一致备份；原数据卷、`.env.dev`、开发密码与证书保留。Cloud / Caddy 均为 healthy，正常证书校验的 `/healthz` 返回 `1.8.0`，迁移仍为 `0009_automation`。

真实 Chromium 与 WSS Relay 在 1440/390/320px 下通过会话、输出、文件审批、Diff、中断、刷新恢复和 XSS 文本检查；实际 Service Worker 安装成功，仅缓存六项公开静态资源。真实 Codex 任务进一步通过：当前用户已有登录、本轮 Service Agent 和 Host 管道，在独立项目修改测试文件，单次文件审批、实际 Diff 和刷新恢复正常。安装保留升级前的用户设置与设备身份，自动测试使用独立设备，不覆盖当前电脑的 Cloud 连接；未执行真实电源动作。完整记录与公网待验收项见 [Codex Remote](codex-remote.md)。

开发模式包含 PWA 缓存。1.9.0 起，明确允许的公开静态文件优先读取网络的新版本，网络不可用时才回退缓存；页面、接口和会话正文始终不缓存。旧版已打开页面可刷新获取更新，正式发布仍应递增版本。不要清除 Cloud 数据卷或重建登录配置来处理浏览器缓存。

## 历史本机部署验证（2026-10-02，1.7.2）

本轮更新前先备份开发 SQLite 数据库并通过完整性检查；本机 Docker 使用 Cloud `1.7.2`、开发配置 `1.7.2-dev.1`，保留原数据卷、`.env.dev`、登录身份和开发证书。更新后 `/healthz` 返回 `1.7.2`，Cloud 和 Caddy 均为 healthy。数据库完整性、外键及 10 张身份/配置表与升级前备份一致。

Docker Hub 连接超时后，沿用本机既有镜像的相同依赖，重新安装 `1.7.2` 分发包并覆盖当前运行源码；58 个运行文件摘要与源码一致，包版本和运行版本一致，依赖检查通过。正常 HTTPS 证书校验、真实管理员密码登录和 1440/390px 页面验证通过。开发库目前没有配对设备，远程桌面下载及电源交互在隔离设备环境验证，未执行真实电源操作。正式服务器未更新。

## 历史本机部署验证（2026-10-01）

Cloud `1.7.0` 与 Caddy `2.11.4` 已在 Docker Desktop 启动，开发镜像标签为 `lanpower-cloud:1.7.0-dev.1`，两个容器均为 healthy。首次直连 Docker Hub 超时，本次核对本机缓存依赖与当前声明一致，并用已逐字节核对的 54 个应用运行文件构建离线镜像；包版本、运行版本与源码一致，依赖完整性检查通过。日常启动直接复用此镜像，显式 `-Build` 仍需镜像仓库和包源可达。

Windows HTTPS 检查与 Chromium 浏览器均通过正常证书校验。实际管理员密码登录、安全 Cookie、七个主要页面在 1440/390px 下共 14 组布局检查、空设备接口、SSE 状态流及匿名访问限制通过，浏览器无脚本错误。源码文件时间戳触发的 Python 自动重载已实测，随后 HTTPS 恢复正常。

停止容器后重新执行启动脚本，SQLite 一致备份和完整性检查通过，23 张表的内容摘要、登录配置及开发 CA 均保持不变；数据库迁移为 `0009_automation`、日志模式为 WAL。开发环境采用全新测试数据，未连接真实设备或执行电源动作。此次只在本地提交开发部署配置与说明，不发布远程资源。

## Windows 本机连接修复（2026-10-01）

开发配置 `1.7.0-dev.1` 只验证并配置了当前用户的证书信任，实际 `LocalSystem` 服务在请求本机配对接口时出现 `HttpRequestException:SecureConnectionError -> AuthenticationException`。现场核对发现开发 CA 存在于 `CurrentUser\Root`，但不在 `LocalMachine\Root`。

`1.7.0-dev.2` 增加独立的证书修复脚本，并由启动入口默认调用；管理员权限仅用于导入计算机证书。补齐同一张开发 CA 后，无需修改 Windows 程序或重启服务，通过实际服务 IPC 调用配对接口成功获得短码和正确的本机批准地址，验证用等待状态随后取消。此检查没有兑换新设备凭据；正式转到本机 Cloud 仍需用户在网页批准。原服务身份、Cloud 连接和 LAN 配对保持不变，未执行电源动作。更新后的开发启动脚本在 Windows PowerShell 5.1 下通过，运行前备份测试库，Cloud 和代理均保持健康。

## 本机 1.14.0 原窗口整合（2026-10-03）

本机镜像更新为 `lanpower-cloud:1.14.0-dev.1`，访问 [本机 Codex Remote](https://localhost:8443/remote) 查看新 Vue 网页。升级前使用 SQLite backup API 检查备份；原开发卷、登录配置和 CA 保留。Windows Setup 就地更新到 1.14.0，Service、Desktop、Host 和版本化备用服务与构建匹配，设备身份、Cloud 地址、LAN 配置和用户项目授权保留。Host 已切换为原窗口接入；官方工作窗口未重启。真实任务、原服务审批回复与原生队列操作通过，详见 [原窗口整合说明](codex-original-window.md)。远程仓库和正式云服务器本轮未同步。
