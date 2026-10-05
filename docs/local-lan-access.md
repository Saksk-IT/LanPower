# 本机 Cloud 的局域网访问

局域网部署配置版本：`1.1.0`。本机 Cloud `1.24.2` 使用 **HTTP / WS**。在仓库根目录运行 `./deploy/docker/start-dev.ps1`，电脑访问 **http://localhost:8080**；脚本输出的 **http://电脑局域网IP:8080** 供同一网段手机和其他电脑使用。无需导入或信任开发证书。

Docker 只绑定回环和选定物理网卡的私有 IPv4，不监听所有网络地址。Windows 防火墙规则 `LanPower-Dev-HTTP-LAN` 仅允许该网卡、该地址与同一 IPv4 网段的 TCP 8080；首次配置或地址变更需 Windows 管理员权限。旧 HTTPS 8443 映射撤下，原数据库、账号、设备授权、登录密码及证书卷保留。

## 微信小程序连接本机 Docker

1. 运行 `./deploy/docker/start-dev.ps1`，电脑和手机连接同一 Wi-Fi。手机使用脚本输出的 `http://<电脑局域网IP>:8080`；手机上的 `localhost`、`127.0.0.1` 和 `::1` 指向手机自身。
2. 先在手机浏览器打开同一 HTTP 地址。无法打开时检查本地网络权限、VPN、访客 Wi-Fi、路由器客户端隔离与电脑防火墙。
3. 微信开发者工具导入完整 `mini_program` 或本机 `windows/out/CodexDock-mini-program-3.6.7.zip`，在「详情 → 本地设置」确认已开启「不校验合法域名、web-view、TLS 版本及 HTTPS 证书」。新版本机导入包带有最小 URL 校验设置，不包含用户原私有配置；正式源码的公开配置继续开启校验。手机开发预览在右上角菜单开启调试，退出后重新进入；手机调试开关需单独开启。
4. 小程序 `3.6.7` 的「我的 → 开发版 Cloud 地址」填写局域网 HTTP 地址，点击「测试连接」，再保存；保存会同步下方账号登录地址。此操作只读取 `/healthz`，不使用账号或授权码。统一账号输入框在开发版显示 HTTP 提示；仍显示旧 HTTPS 提示时，请检查导入目录、重新编译并确认「我的」页底部版本为 `3.6.7`。
5. 在账号登录区域填写同一 HTTP 地址并登录电脑使用的同一账号，手机会自动发现已连接电脑。原扫码方式继续可用：在电脑浏览器打开**同一局域网 HTTP 地址**并登录，进入「已授权客户端」生成新的手机二维码；不要扫描 `localhost` 或旧 HTTPS 网页生成的码。

开发版按完整 Cloud 地址隔离授权。改用 HTTP 后可重新登录原账号，原 HTTPS 地址对应的手机凭据和正式版状态继续保留。HTTP / WS 用于本机开发联调；体验版和正式版继续使用 HTTPS / WSS。微信网络和调试要求见 [微信网络说明](https://developers.weixin.qq.com/miniprogram/dev/framework/ability/network.html)。手机真机连通、扫码与 Codex 控制需实际验收。

## 开发者工具模拟器登录 403

Windows 微信开发者工具模拟器可以填写 `http://localhost:8080`，手机预览填写电脑局域网的 HTTP 地址。若请求已到达 `/api/v2/account/login`，却返回 403 和“请求来源不可用”，更新本机 Cloud 至 `1.24.2`，随后在模拟器直接重试登录。无需更换密码或清除手机授权。

实际模拟器请求不携带 Origin 与 Cookie，但附带官方 `https://servicewechat.com/{appid}/devtools/page-frame.html` Referer，以及 `Sec-Fetch-Site: cross-site`、`Sec-Fetch-Mode: cors`、`Sec-Fetch-Dest: empty`。旧 Cloud 将该标记当作网页跨站登录而拒绝。兼容仅适用于 `LANPOWER_ALLOW_LOCAL_HTTP=true` 下明确登记的 HTTP 入口和这组 JSON 请求信息；未知来源、Cookie 请求、网页表单与正式 HTTPS 来源继续按原规则检查，密码与连接密钥仍需验证。

修复前已通过当前真实开发者工具复现该 403；手机预览连接成功由用户确认。本轮模拟器与部署验证记录见 [本机开发环境](local-development.md)。

## Windows 已有本机连接迁移

安装 `1.24.0` 或更新版本后，以管理员身份在仓库运行：

```powershell
./deploy/docker/switch-windows-dev-http.ps1
```

脚本只迁移本机原来的 HTTPS 8443 地址到 HTTP 8080。它先用原长期授权检查新入口，备份加密凭据，再只更改 Cloud URL，保留设备编号、账号连接密钥和长期授权并重启后台服务。`-ValidateOnly` 只检查，不修改凭据或停止服务。新连接直接使用 `http://localhost:8080`；网页 Codex 和 Windows 中继均使用 WS。

局域网 IP 的 HTTP 页面使用账号密码；Passkey 需要浏览器安全上下文，可在本机 localhost 使用受浏览器支持的功能。已有 Passkey 记录不删除。

## 地址变化与关闭局域网入口

多块物理网卡同时联网时明确指定地址：

```powershell
./deploy/docker/start-dev.ps1 -LanAddress <本机私有IPv4>
```

更换网络或 DHCP 地址变化后重新运行，会更新端口映射、允许的浏览器来源与防火墙规则。`./deploy/docker/start-dev.ps1 -LocalOnly` 恢复仅本机访问。没有可用物理私有 IPv4 时默认仅本机入口。

局域网地址仅写入被忽略的 `deploy/docker/private/dev-network.env`，密码哈希使用原 `.env.dev`。每次启动先通过 SQLite backup API 备份并检查数据库，保持原 `lanpower-dev` 数据卷。首次创建的登录说明使用新 HTTP 地址；已有登录文件中的旧 URL 仅为旧提示，原密码不变。日常操作见 [本机开发指南](local-development.md)。

## 本机 HTTP 验证（2026-10-06）

Cloud 93 项、Windows 64 项检查及小程序账号/环境/网络/设备/Codex 检查通过，微信编译和 320/390/430px 浅深色布局通过。本机与局域网 HTTP 均完成真实登录、Cookie、二维码生成及页面访问检查；原数据卷、24 张表的既有标识与登录配置保留。Windows `1.24.0.0` 已恢复 HTTP 连接，设备身份和长期授权保留。

小程序实际连接逻辑经原生网络适配器完成 HTTP 登录、电脑发现、Bearer WS 以及原 Codex 窗口的只读模型列表请求，临时手机授权已撤销。此为本机链路检查，微信真机需按上方步骤实际验收。完整证据说明见 [本机更新记录](local-development.md#本机-http-1240-2026-10-06)。

## 历史 HTTPS 验证记录

以下保留此前 HTTPS 部署的实际检查记录；当前入口和联调步骤以上文 HTTP 为准。

## 本机验证（2026-10-04）

Windows PowerShell 5.1 启动、基础与局域网 Compose 配置、Caddy 配置和防火墙范围检查通过。新增 16 项检查覆盖本机/局域网密码登录、安全 Cookie、二维码地址、WSS 浏览器来源和拒绝未配置来源；原有身份、Codex Remote 与手机授权相关 55 项检查通过。

本机实际通过正常证书校验访问两个 HTTPS 入口，并完成现有开发账号登录、四个授权页面访问和退出；直接 IP 访问的证书名称检查通过。从局域网路由器实际使用公开开发 CA 校验 HTTPS，健康接口返回 `1.15.2`。原登录文件、私有环境配置和开发 CA 逐字节保留，SQLite 完整性与外键检查通过，九张身份及配置表的主键与引用保留。手机浏览器及微信真机由用户继续验收。

## 小程序 3.3.1 与本机 1.22.1 验证（2026-10-05）

小程序 `3.4.0` 的自动检查覆盖手机回环地址拦截、旧授权保留、无凭据的健康检测、微信网络错误分类，以及编辑地址、切到后台或切换环境后的迟到响应。连接页通过微信 WCC/WCSC 编译与 320/390/430px 布局检查；Cloud 来源与版本相关 25 项检查通过。这些检查不等同于手机真机网络、扫码、WSS 或电源动作验收。

本机 Cloud 镜像为 `codexdock-cloud:1.22.1-dev.1`，Cloud / Caddy 健康。本机与局域网 HTTPS 入口均完成正常证书校验、已有账号登录、授权页面地址与安全 Cookie 检查；从局域网路由器使用公开开发 CA 验证 IP 证书与健康接口，返回 `1.22.1`。Windows 四组件为 `1.22.1.0`，只读服务状态确认为已连接 Cloud。原数据卷和 CA 沿用；同机升级记录确认九张身份/配置表的既有编号保留，数据库完整性 `ok`、外键错误 0，Windows 设备身份与用户配置保留。

本机导入包 `windows/out/CodexDock-mini-program-3.3.1.zip` 包含 38 个公开小程序文件及占位 AppID，正文与已验证提交一致；Git 导出采用 Windows 行尾。构建快照、导入包检查和本轮 HTTPS / 路由器 / 服务只读报告在忽略目录 `private/phone-lan-1.22.1`。手机真机与扫码仍需按上方步骤验收；本轮没有执行真实电源动作、上传微信平台、推送仓库或部署远程 Cloud。

## 实现参考

多个明确 HTTPS 站点及 IP 客户端的默认 TLS 名称按 [Caddy 配置说明](https://caddyserver.com/docs/caddyfile/concepts#addresses) 与 [default_sni](https://caddyserver.com/docs/caddyfile/options#default-sni) 配置。端口只发布到选定宿主机地址，见 [Docker 端口发布说明](https://docs.docker.com/engine/network/port-publishing/)。Windows 规则使用明确的本机地址、远端网段和网卡范围，见 [New-NetFirewallRule](https://learn.microsoft.com/en-us/powershell/module/netsecurity/new-netfirewallrule)。
