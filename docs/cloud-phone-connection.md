# Windows、路由器、Cloud 与手机联调

本清单用于把已安装的 Windows 服务、已配置的 AX3000T Gateway、Remote Cloud 和微信小程序接成一条可从手机 5G 使用的链路。按顺序验证，每一步都先满足本节的检查结果再继续。

## 0. 先核对是不是同一套凭据

路由器配置完成后，先找到当时由 `python -m cloud_remote.provision` 生成的配套文件：

- `cloud.json`：部署到 Cloud，包含 `gateway_id`、`gateway_secret`、`client_secret`。
- `gateway.json`：安装到路由器 `/data/lanpower/gateway.json`。
- `remote-pairing.svg`：由手机微信扫描。

三份文件必须来自同一次生成。Cloud 与路由器的 `gateway_id`、`gateway_secret` 必须相同；路由器的 `cloud_url` 必须与 Cloud 的 HTTPS 域名一致；手机二维码中的 `gateway_id` 和 `client_secret` 必须对应这份 `cloud.json`。

**不要为了找回二维码而重新运行 provision。** 它会随机生成新凭据，旧路由器随即无法认证。若配套 `cloud.json` 或二维码丢失，需重新生成一套并同时更新 Cloud、路由器和手机；只改其中一端不会连通。Windows LAN Token 必须仍与路由器 `gateway.json` 中的 `lan_token` 一致。

如果确认找不到原配套文件，可在本机**管理员 PowerShell**从仓库根目录重新生成一套。先把示例域名换成真实 HTTPS 域名；如果 `$setup` 目录已存在，换一个新的输出目录名。此操作会生成新凭据，后续必须将新 `cloud.json` 部署到 Cloud、将新 `gateway.json` 显式替换到路由器，并让手机清除旧远程配对后扫描新二维码：

```powershell
py -3.12 -m pip install --user qrcode==8.2
$setup = Join-Path $env:LOCALAPPDATA ('LanPower\remote-setup-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
py -3.12 -m cloud_remote.provision `
  --cloud-url 'https://power.example.com' `
  --lan-config 'C:\ProgramData\LanPower\config.json' `
  --mac '02-11-22-33-44-55' `
  --broadcast '192.168.1.255' `
  --output $setup
```

确认 MAC 和广播地址仍对应当前电脑所在网段，再运行。脚本会拒绝覆盖已存在的输出目录。Gateway 安装脚本升级时会保留现有 `/data/lanpower/gateway.json`，因此轮换后需先备份旧文件，再明确安装新配置；参见 [Gateway 安装说明](../router_gateway/README.md)。

## 1. 确认 Windows LAN 服务

Windows 服务应运行在电脑当前的固定局域网地址，TCP 端口为 `48211`。路由器的 DHCP 静态绑定地址、`gateway.json` 的 `pc_ip` 必须与这台电脑一致。检查：

1. 在 Windows 本机打开 `http://127.0.0.1:48211/setup`，页面能显示局域网配对二维码。
2. 用手机暂时连接家中 Wi-Fi，扫描该局域网二维码。小程序显示“在线 · 局域网”。
3. 在路由器上确认能访问 `pc_ip:48211`，且 Gateway 配置中的 LAN Token 与 Windows 配置一致。

Windows 的 `C:\ProgramData\LanPower\config.json` 受系统 ACL 保护。需要重新生成整套凭据时，从**管理员 PowerShell**运行 provision，避免把 LAN Token 手动复制到聊天、普通日志或 Git 文件中。

## 2. 部署 Cloud HTTPS 服务

**可以使用 Cloudflare，推荐用 Cloudflare Tunnel 发布 HTTPS 域名。** LanPower Cloud 程序仍运行在你的 Linux 服务器上，Cloudflare 负责域名入口和安全隧道。Tunnel 从服务器向 Cloudflare 建立出站连接，所以不需要给服务器开放公网入站 `80` / `443`，也不需要暴露 Windows 的 `48211` 或路由器 SSH。Cloudflare 官方说明：[Tunnel 发布应用](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/)、[建立 Tunnel 并发布域名](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/)。

如果你说的“用 Cloudflare”是指完全不使用这台 Linux 服务器、把应用直接改部署到 Workers，目前代码不能原样上传：它使用 `ThreadingHTTPServer` / `threading` 和本地 SQLite 文件；Workers 的 Python 运行环境不支持 `threading`，临时文件系统也不用于持久化。那条路需要改为 Worker 请求入口，并把持久化改接 Cloudflare D1 等服务，工作量比使用 Tunnel 大。[Workers Python 运行限制](https://developers.cloudflare.com/workers/languages/python/stdlib/)。

前提是域名已经添加到 Cloudflare，权威 DNS 已切换到 Cloudflare。先将仓库 `cloud_remote/` 目录和配套 `cloud.json` 放到服务器 `/opt/lanpower/`。Cloud 只监听本机 `127.0.0.1:8765`：

服务器需有 Python 3.12+、systemd。配置 Cloud 服务用户、持久化数据库目录和凭据权限：

```sh
sudo useradd --system --home /opt/lanpower --shell /usr/sbin/nologin lanpower 2>/dev/null || true
sudo mkdir -p /opt/lanpower /var/lib/lanpower-cloud
sudo chown -R lanpower:lanpower /opt/lanpower /var/lib/lanpower-cloud
sudo chmod 700 /opt/lanpower
sudo chmod 600 /opt/lanpower/cloud.json
```

确认 `/opt/lanpower/cloud_remote/` 是从仓库复制的源码目录，并确认 `cloud.json` 的 `database` 指向 `/var/lib/lanpower-cloud/relay.db`。建立 `/etc/systemd/system/lanpower-cloud.service`：

```ini
[Unit]
Description=LanPower Remote Cloud
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=lanpower
Group=lanpower
WorkingDirectory=/opt/lanpower
ExecStart=/usr/bin/python3 -m cloud_remote.server --config /opt/lanpower/cloud.json
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/lanpower-cloud

[Install]
WantedBy=multi-user.target
```

在 Cloudflare 控制台的 Zero Trust / Networks / Tunnels 创建一个 Tunnel，并添加 Published application 路由：

- Public hostname：实际 Cloud 子域名，例如 `power.example.com`。
- Service type / URL：`HTTP` / `http://127.0.0.1:8765`。
- 不要给这个 hostname 加 Cloudflare Access 登录策略；小程序通过 LanPower 自己的 Bearer 凭据鉴权。
- 在服务器安装 Cloudflare 控制台显示的 Linux `cloudflared` 命令，并将 Tunnel 注册为系统服务。命令内的 Tunnel token 是私密凭据，不要贴到聊天或仓库。官方步骤见 [创建远程管理 Tunnel 并发布应用](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/)。

启动 Cloud 服务，并确认 Cloudflare Tunnel 显示已连接：

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now lanpower-cloud
sudo systemctl status --no-pager lanpower-cloud
sudo systemctl status --no-pager cloudflared
curl -fsS https://power.example.com/healthz
```

`/healthz` 应返回 `ok: true` 和版本号。它只证明 Cloudflare HTTPS 入口和 Cloud 进程可用，**不代表路由器已连接**。SQLite 文件必须保存在持久化磁盘，并纳入云端备份。若你已有 Caddy / Nginx，也可以继续用它做 HTTPS 反向代理而不启用 Tunnel；无论哪种方式，都要保留 loopback 绑定、持久化数据库和凭据权限。

## 3. 确认路由器已连到这份 Cloud

路由器安装既已完成，这一步只检查，不重新安装：

1. `/data/lanpower/lanpower-gateway -config /data/lanpower/gateway.json -check-config` 应成功。
2. 查看 `/data/lanpower/gateway.log`，确认进程持续运行且没有 HTTPS、401 或配置错误。
3. 完成下一节的小程序远程配对后，用手机查看 Cloud 状态；预期是 Gateway `online`，电脑开启时 PC 为 `online`。

若 `/healthz` 正常但 Gateway 离线，优先检查路由器出站 DNS/HTTPS、路由器配置的 Cloud URL，以及 Cloud 和 Gateway 的 `gateway_id` / `gateway_secret` 是否匹配。若 Gateway 在线但 PC 离线，检查 DHCP 绑定、`pc_ip`、LAN Token、Windows 防火墙及 Windows 服务状态。

## 4. 配置并预览微信小程序

仓库 `mini_program/project.config.json` 中的 `touristappid` 是公开占位值。用微信开发者工具导入 `mini_program/`，在本机开发者工具设置自己的小程序或测试号 AppID；不要把 AppSecret 放入此项目。

在微信公众平台为这个 AppID 配置 Cloud 域名为 HTTPS `request` 合法域名，域名须与 `cloud.json` 生成配对链接中的域名完全一致。不要填写路径或端口。开发者工具中的本地调试选项不能代替微信真机所需的域名配置。

在开发者工具编译并预览，用 iPhone 微信扫码；再分别扫描：

1. Windows `/setup` 页面上的**局域网配对二维码**，验证 Wi-Fi 下直连。
2. `remote-pairing.svg` 上的**远程配对二维码**，验证手机已保存 Cloud URL、Gateway ID 和手机凭据。

小程序的局域网配对和远程配对是两项独立配置。远程二维码属于私密凭据，只在自己的手机上扫描，不要发到群聊或提交到仓库。

## 5. 用手机 5G 做端到端验证

先在 Wi-Fi 下确认小程序能显示“在线 · 局域网”。随后关闭 iPhone Wi-Fi，确认蜂窝网络显示为 5G，并重新打开小程序：

1. 配对和域名配置正确时，状态应显示“在线 · 远程”。
2. 先让电脑睡眠，用小程序点“开机”，等待 Gateway 经 LAN 发送 WOL，并等状态恢复在线。
3. 再测试一次“睡眠”及远程唤醒。确认远程唤醒成功后，再测试休眠、重启；关机留到最后验证。

故障定位：手机返回 401 通常表示手机二维码与 Cloud `client_secret` 不匹配；5G 下请求失败而 Wi-Fi 正常，先检查 HTTPS 证书、微信 `request` 合法域名和 DNS；Gateway 在线但电脑离线，检查路由器到 Windows 的局域网配置；服务端日志不要加入或输出任何 Bearer 凭据。

完成条件：Wi-Fi 下 LAN 直连可用；关闭 Wi-Fi 后 5G 下显示远程在线；电脑睡眠或关机时能通过路由器 WOL 唤醒；电脑在线时远程电源指令可送达。
