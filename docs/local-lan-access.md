# 本机 Cloud 的局域网访问

局域网部署配置版本：`1.0.0`。在仓库根目录运行 `./deploy/docker/start-dev.ps1`，脚本自动选择有默认网关的物理网卡私有 IPv4 地址，同时保留 `https://localhost:8443` 本机入口。控制台输出的 `https://<本机局域网 IP>:8443` 可供同一网段的其他电脑和手机使用。

Docker 只增加所选局域网 IPv4 的 `8443` HTTPS 映射。Windows 防火墙规则 `LanPower-Dev-HTTPS-LAN` 限制为该网卡、本机地址与同一 IPv4 网段；首次配置或地址变更时会请求 Windows 管理员权限。即使网卡被 Windows 标记为公用网络，规则仍仅允许所选局域网网段。

## 其他设备首次连接

1. 将本机 `deploy/docker/private/dev-root.crt` 复制到要使用的设备并导入为受信任根证书。这是开发 CA 的公开证书；请只复制这个文件。
2. 在浏览器打开启动脚本输出的局域网 HTTPS 地址，使用现有开发账号登录。账号仍为 `admin`，密码仍保存在本机 `deploy/docker/private/dev-login.txt`。
3. 浏览器会为局域网地址建立独立登录会话。登录、Codex 浏览器 WSS、网页显示的 Cloud 地址及手机授权二维码均支持明确配置的局域网地址。

iPhone/iPad 安装证书描述文件后，还需在“设置 → 通用 → 关于本机 → 证书信任设置”开启该开发 CA 的完全信任，见 [Apple 证书信任说明](https://support.apple.com/en-us/102390)。Windows 电脑可将此公开证书导入受信任根证书存储；后台服务需要计算机级信任。

原有 Passkey 仍绑定 `localhost`，请在本机原入口使用；局域网 IP 入口使用开发密码。其他设备的 `localhost` 指向设备自身，不能用它访问这台电脑。微信开发版可在“连接 → 开发版 Cloud 地址”填写局域网 HTTPS 地址；手机真机微信是否接受此开发证书，需要按微信开发环境要求单独验收。

## 地址变化与关闭局域网入口

多块物理网卡同时联网时，明确指定目标地址：

```powershell
./deploy/docker/start-dev.ps1 -LanAddress <本机私有 IPv4>
```

更换网络或 DHCP 地址变化后重新运行启动脚本，会更新 IP 证书、端口映射、允许的浏览器来源和防火墙规则。运行 `./deploy/docker/start-dev.ps1 -LocalOnly` 恢复仅本机访问；外部端口映射撤下后，原防火墙规则不会继续暴露服务。没有合适的物理私有 IPv4 网络时，脚本自动保持仅本机入口。

局域网地址仅写入被忽略的 `deploy/docker/private/dev-network.env`，登录哈希仍使用原 `.env.dev`。Cloud 数据卷、证书卷、设备配对和 Windows 应用配置继续复用。每次启动仍先用 SQLite backup API 备份并检查现有数据库。日常操作与证书恢复见 [本机开发指南](local-development.md)。

## 本机验证（2026-10-04）

Windows PowerShell 5.1 启动、基础与局域网 Compose 配置、Caddy 配置和防火墙范围检查通过。新增 16 项检查覆盖本机/局域网密码登录、安全 Cookie、二维码地址、WSS 浏览器来源和拒绝未配置来源；原有身份、Codex Remote 与手机授权相关 55 项检查通过。

本机实际通过正常证书校验访问两个 HTTPS 入口，并完成现有开发账号登录、四个授权页面访问和退出；直接 IP 访问的证书名称检查通过。从局域网路由器实际使用公开开发 CA 校验 HTTPS，健康接口返回 `1.15.2`。原登录文件、私有环境配置和开发 CA 逐字节保留，SQLite 完整性与外键检查通过，九张身份及配置表的主键与引用保留。手机浏览器及微信真机由用户继续验收。

## 实现参考

多个明确 HTTPS 站点及 IP 客户端的默认 TLS 名称按 [Caddy 配置说明](https://caddyserver.com/docs/caddyfile/concepts#addresses) 与 [default_sni](https://caddyserver.com/docs/caddyfile/options#default-sni) 配置。端口只发布到选定宿主机地址，见 [Docker 端口发布说明](https://docs.docker.com/engine/network/port-publishing/)。Windows 规则使用明确的本机地址、远端网段和网卡范围，见 [New-NetFirewallRule](https://learn.microsoft.com/en-us/powershell/module/netsecurity/new-netfirewallrule)。
