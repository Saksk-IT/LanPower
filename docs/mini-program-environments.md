# 微信小程序开发版与正式版

小程序 `3.3.1` 使用同一份 `mini_program` 源码，根据微信返回的运行环境区分开发版、体验版和正式版，不需要手工改源码或复制两份项目。

| 微信运行环境 | Cloud 地址 | 手机授权、电脑缓存与局域网配对 |
| --- | --- | --- |
| 开发版 `develop` | 在「连接 → 开发版 Cloud 地址」填写；未填写时由授权二维码确定 | 与正式版隔离，并按测试 Cloud 地址分别保存 |
| 体验版 `trial` | 通过 HTTPS 授权二维码确定，无测试地址输入入口 | 独立保存，不读取正式版或开发版授权 |
| 正式版 `release` | 通过 HTTPS 授权二维码确定，无测试地址输入入口 | 沿用原有存储，保留已有手机授权与配对 |

无法确定微信运行环境时使用正式版规则。开发版填写的测试地址不会被体验版或正式版读取；开发设置在这些版本中也无法保存。

## 在微信开发者工具测试本机 Cloud

1. 先按 [本地开发说明](local-development.md) 启动本机 Docker Cloud，浏览器打开 `https://localhost:8443`。
2. 在微信开发者工具导入 `mini_program`，配置自己的 AppID。开发工具和真机开发预览属于开发版；上传为体验版或正式发布后会自动采用对应规则。
3. 在开发工具的「详情 → 本地设置」中，为本机测试开启「不校验合法域名、web-view、TLS 版本及 HTTPS 证书」。仅本机私有配置记录此选项，公开 `project.config.json` 仍开启域名校验。
4. 在小程序「连接 → 开发版 Cloud 地址」填写 `https://localhost:8443`，点击「保存测试地址」。
5. 登录同一个本机 Cloud，在「已授权客户端」生成手机授权二维码，用开发版扫描该二维码。开发工具模拟器可在 `wx.scanCode` 调试界面使用二维码图片。测试服务器没有电脑时，页面会显示添加电脑指引。

Cloud 地址只填写协议、主机与可选端口，例如 `https://localhost:8443`、`https://test.example.com` 或 `http://192.168.1.100:8765`。开发版允许本机与私有 IPv4 局域网地址使用 HTTP；公网地址仍须 HTTPS。路径、账号密码、查询参数与无效端口均会被拒绝。既有 Codex 页面也需要将 HTTP 测试连接转换为 `ws://`，HTTPS 则使用 `wss://`。

## 切换测试地址

保存另一个地址时，当前连接和控制状态会立即清空，手机仅加载新地址对应的开发版授权与设备缓存。首次连接新地址需要在该 Cloud 生成并扫描新的授权二维码；切回曾授权的地址可以恢复原开发版授权，仍会重新读取电脑状态后才能控制。

二维码中的 Cloud 地址必须与当前填写地址一致，授权码不会转发到不同的 Cloud。切换不会撤销服务器上的手机授权，也不会删除正式版或其他测试地址的凭据。「清空地址，下次扫码选择」会移除当前测试地址选择，保留各地址的开发版授权。需要主动撤销时使用当前 Cloud 的「撤销手机授权」操作。

## 手机连接电脑上的 Cloud

手机的 `localhost` 指向手机自己。真机测试需要电脑与手机连接同一 Wi-Fi，并使用手机可达的电脑局域网地址或测试域名。

当前 Docker 启动脚本默认保留 `127.0.0.1:8443`，并为选定物理网卡增加局域网 HTTPS 入口、IP 证书、浏览器来源白名单与限定网段的防火墙规则。在开发版连接页填写脚本输出的局域网 HTTPS 地址，先点「测试连接」；随后在**同一局域网地址的 Cloud 网页**重新生成授权二维码，不能扫描 `localhost` 网页生成的码。`LANPOWER_PUBLIC_URL` 保留原本机入口，局域网来源由 `LANPOWER_ADDITIONAL_ORIGINS` 明确配置；数据卷、身份与登录配置沿用。完整的手机证书、微信调试和网络检查见 [局域网访问指南](local-lan-access.md#微信小程序连接本机-docker)。

当前 Cloud 平台要求 `LANPOWER_PUBLIC_URL` 使用 HTTPS。因此，本仓库 Cloud 的扫码测试请使用 HTTPS 入口；开发版对局域网 HTTP 的支持适用于已有对应 HTTP 授权二维码的测试服务，不能通过修改小程序地址让默认 Docker 入口自动变成 HTTP。

正式发布前，在微信后台配置 Cloud 的 request 和 socket 合法域名及有效 HTTPS 证书；正式版没有关闭校验的项目配置。微信域名、网络与证书要求见 [微信网络文档](https://developers.weixin.qq.com/miniprogram/dev/framework/ability/network.html)，环境标识见 [微信账号信息 API](https://developers.weixin.qq.com/miniprogram/dev/api/open-api/account-info/wx.getAccountInfoSync.html)。

## 本轮验证

```text
node tests/test_mini_program_environments.js
node tests/test_mini_program_cloud_connectivity.js
node tests/test_mini_program.js
node tests/test_mini_program_v2.js
node tests/test_mini_program_codex.js
node tests/test_mini_program_environments_layout.cjs
```

新增检查覆盖环境识别失败时的默认规则、开发地址校验、跨环境和跨地址授权隔离、设备与局域网缓存、旧连接停止及切换过程中的续期响应。页面使用微信 WCC/WCSC 编译器验证，编译后的连接页在 320/390/430px 下检查布局。自动检查不等同于微信真机扫码、域名校验或电源动作验收；未执行真实电源操作。
