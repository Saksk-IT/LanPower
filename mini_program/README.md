# CodexDock 微信小程序

统一账号登录：电脑登录后自动加入账号，手机登录同一 Cloud 的同一账号即可选择电脑；已有 Passkey 用户先在网页「设置 → 统一账号」设置密码。原扫码授权和局域网直连继续兼容，见 [三端账号登录](../docs/account-login.md)。

当前小程序版本 **3.6.0**，协议版本 **2**，配套 Windows / Cloud / Web **1.23.2**。导入完整 `mini_program` 目录，或本机生成的 `windows/out/CodexDock-mini-program-3.6.0.zip`。页面路径与兼容说明见 [小程序导航](../docs/mini-program-navigation.md)。

## 页面与入口

底部使用微信原生导航栏，仅有两个页签：

- **我的设备**：默认首页，展示已连接、已授权的 Windows 设备及在线状态。点击设备卡片进入该设备的详情页。
- **我的**：手机授权、Cloud 连接信息、开发版测试地址、使用帮助与独立局域网旧版入口。

**设备详情**包含设备状态、开机 / 唤醒、睡眠、休眠、重启、关机，以及 **Codex 控制**入口。局域网关联和唤醒参数也属于这台设备，保存在其详情页。详情页和 Codex 页固定对应点击的设备；返回依次回到设备详情和设备列表。设备被移除或不再授权时停止控制并提示返回列表，不自动切换到其他电脑。

Codex 控制保留项目、最近聊天、完整历史、模型与强度、权限、附件、队列和审批功能。控制页没有底部主导航，也不在当前设备内切换到另一台电脑；更换设备请返回“我的设备”。原始电脑选择缓存、长期授权和开发 / 体验 / 正式环境隔离继续使用，无需因导航更新重新扫码。

Codex 沿用已有的自定义顶部导航，避让状态栏和微信胶囊；设备内的工作台顶部提供“返回设备详情”，聊天中的返回先回到工作台。菜单、搜索、文件与能力目录保持原有操作。

## 第一次连接

1. 在 Cloud 注册账号，或用已有 Passkey 登录后，在 **设置 → 统一账号** 设置密码。部署配置中的管理员密码也可直接使用。
2. 在 Windows 版 CodexDock 的 **远程连接** 登录该 Cloud 的账号，电脑自动加入账号。
3. 打开小程序 **我的 → 统一账号**，填写同一 Cloud 地址并登录同一账号，自动进入 **我的设备**。原扫码授权方式继续保留。
4. 点击目标电脑，进入 **设备详情**。需要电源操作时在本页操作；需要开发时打开 **Codex 控制**，选择项目或聊天。
5. Codex 使用 Windows 当前用户已登录的原 Codex 窗口；电脑须在线、启用 Codex Remote 并授权项目。

开发版测试地址位于 **我的 → 开发版 Cloud 地址**，填写后先测试连接，再保存并登录该 Cloud 的账号。手机使用电脑的局域网 HTTPS 地址；`localhost` 仅供电脑模拟器测试。步骤见 [局域网联调](../docs/local-lan-access.md#微信小程序连接本机-docker) 和 [环境隔离](../docs/mini-program-environments.md)。

## 电源与局域网

- 在线且控制通道可用时，可执行睡眠、休眠、重启和关机；每次发送前再次确认目标设备与操作。
- 离线且具备可用唤醒方式时，可尝试开机 / 唤醒。指令送达或唤醒包发出不代表已经开机，需要等待设备上线。
- 在设备详情的“电脑局域网直连”扫描这台电脑的 LAN 配对码。二维码在 Windows 应用的 **手机配对 → 显示配对二维码**。
- 局域网离线唤醒需要保存真实 MAC 和广播地址；电脑需事先启用网络唤醒并保持供电、网线连接。远程唤醒可在 Windows 的“配置远程唤醒”关联 Wake Gateway。

设备列表可下拉或点击刷新，可见时每 10 秒更新 Cloud 状态；设备详情可见时每 5 秒检查电源状态。网络错误显示状态未知，保留已保存的设备和局域网配对。后台页面停止轮询，回到同一台设备后重新同步，不重发指令或任务。

无需 Cloud 的旧版局域网控制保留在 **我的 → 独立局域网 / 旧版连接**，继续读取原有 v1 配对与唤醒设置。该独立模式仅用于电源；Codex 控制仍经 Cloud HTTPS / WSS 连接。

## 导入与预览

`app.json` 注册 7 个页面，每页均包含 `.js`、`.json`、`.wxml`、`.wxss`。公开 `project.config.json` 保留 `touristappid`；在本机微信开发者工具配置自己的 AppID，个人配置文件不会打包。项目不保存 AppSecret、真实授权二维码或 LAN / Cloud 凭据。

真机须配置 Cloud 的 HTTPS `request` 合法域名与 WSS `socket` 合法域名。局域网开发证书需在手机单独信任，允许微信访问本地网络；模拟器的调试设置不会替代真机配置。详见 [连接说明](../docs/local-lan-access.md)。

## 开发检查

在仓库根目录运行：

```powershell
node --test tests/test_mini_program_navigation.js
node tests/test_mini_program.js
node tests/test_mini_program_v2.js
node tests/test_mini_program_codex.js
node tests/test_mini_program_environments.js
node tests/test_mini_program_cloud_connectivity.js
```

导航检查覆盖原生两页签、旧链接、设备卡片与固定目标、扫码回流、移除设备、页面栈和迟到响应。`test_mini_program_environments_layout.cjs`、`test_mini_program_codex_layout.cjs` 使用微信 WCC / WCSC 编译页面和 Playwright，检查 320 / 390 / 430px 的设备列表、详情、我的与 Codex 布局，需要本机编译器和 Playwright。

自动渲染不等同于微信真机验收。重新编译或导入新版包后，人工检查底部页签、列表进入详情、详情进入同一设备的 Codex、返回、扫码、Wi-Fi / 5G、附件返回与电源动作。本机版本和实际部署结果见 [开发记录](../docs/local-development.md)。
