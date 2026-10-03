# 原 Codex 窗口与成熟网页整合

当前版本 1.15.1 的会话展示与验证见 [会话窗口展示说明](codex-conversation-ui.md)，1.15 系统实现与差异见 [系统对齐说明](codex-system-parity.md)。本文保留 1.14 原窗口接入和真实任务/审批的验证记录。

网页复用 Codex Remote Bridge 0.1.101 的 Vue 会话、Markdown/代码/命令展示、输入、审批和队列组件。Windows 用户 Host 连接当前登录用户已经打开的官方 Codex 窗口；请求通过该窗口自己的 AppServerManager 执行。Cloud 继续使用 LanPower 的已认证 WSS 内存转发，不运行另一套 Codex，也不保存对话正文。

## 使用

1. 更新本机 LanPower，在「远程连接」保留已有项目授权，并点击「连接原 Codex 窗口」。当前电脑已完成连接，无需重开正在工作的窗口。
2. 登录本机 [Codex Remote](https://localhost:8443/remote)，选择电脑与会话。支持继续、新建、重命名、归档、分支、回退对话和分批读取历史。
3. 任务运行时，输入框可选择引导当前任务或加入原生队列；排队消息可修改、删除、调整顺序或立即执行。审批仅授予本次，不提供会话永久授权。

如果官方窗口没有启用本机调试接口，连接按钮会给出启动参数。先在原窗口完成任务，再由用户关闭并按提示启动；LanPower 不自动终止原窗口。旧的共享服务路径保留在「打开备用共享窗口」。

小程序保持原生页面，复用同一 Windows/Cloud 控制通道。正式云服务器尚未部署本轮版本，手机 5G、小程序真机操作和远程云环境不属于以下本机验收结论。

## 实现边界

- 复用的源码放在 `remote_ui`，MIT 许可与上游版本见 `remote_ui/LICENSE`、`remote_ui/UPSTREAM.md`。生成网页包含上游许可和 Vue/highlight.js 的第三方许可。未引入上游账号、提供商、隧道、Telegram、遥测和诊断邮件。
- Windows 只查找同一用户的官方应用进程，仅连接 `127.0.0.1` 上对应的 `app://-/index.html` 调试页。每次连接独立注册监听，断开只移除自己的监听，原任务继续运行。
- 新会话第一次启动会补齐原窗口的会话加载。审批优先通过窗口自身 `sendAppServerResponse` 回到原服务；旧版本保留 Electron 消息路径。仅发出界面“已处理”事件不足以真正批准原任务。
- 继续沿用项目目录授权、单设备一个控制端、同源 Cookie/手机独立 Bearer、请求白名单、审批验证与大小限制。原窗口既有任务的权限不被网页改写。
- 历史按每页 8 轮读取；1.15 已解除每轮条目、单项文本和网页 128 轮截断，并支持大响应分段。恢复连接读取实际状态，不重发任务。不保存对话、审批或队列正文；项目组织状态保存在用户电脑，输入/外观偏好保存在浏览器。
- 1.15 网页增加项目/独立聊天收纳、文件浏览与图片读取、技能选择及插件/应用/MCP 目录。文件补丁撤销、安装/授权、自动化调度、语音服务和会话级权限仍由原窗口处理；回退对话保留已经修改的文件。

## 验证

2026-10-03 本机验证结果：

| 范围 | 结果 |
| --- | --- |
| Windows 相关自动测试 | 17 项通过：原窗口地址约束、审批身份、队列/共享控制、历史与请求边界 |
| 网页传输与 renderer 自动测试 | 7 项通过：断线不重发、切换电脑隔离、监听独立释放、原服务审批回复 |
| Cloud 自动测试 | 200 项通过，保留授权和内存转发约束 |
| 浏览器受控数据检查 | 320/390/1440 宽度、明暗主题、历史翻页、队列修改、审批身份与重连通过，0 页面错误 |
| 真实原窗口 + 本机 Cloud | 新建原生会话、读取空会话、原生队列增删改/排序通过；网页提交等待命令，处理原窗口审批，执行完成并收到预期回复，0 页面错误 |

真实测试使用独立目录和临时本机测试设备，结束后清理其队列、归档测试会话并撤销测试设备；原工作会话保持运行。本机 Docker 更新保留原卷与登录/证书，Windows 就地更新保留设备身份、Cloud 地址和用户项目授权。无需同步远程仓库即可在本机试用。

## 构建与检查

```powershell
cd remote_ui
npm ci
npm test
npm run build
cd ..
dotnet test windows/LanPower.UnitTests -c Release --filter "FullyQualifiedName~DesktopCdpTests|FullyQualifiedName~SharedCodexTests|FullyQualifiedName~CodexRemoteTests"
cloud_app/.venv/Scripts/python.exe -m pytest cloud_app/tests -q
node tests/test_codex_remote_browser.cjs
```

网页产物提交在 `cloud_app/static/codex-ui`，Cloud Docker 不安装 Node 依赖。重新构建前端后更新产物及许可，再构建本机 Docker。`LanPower.CodexHost --check-desktop` 仅输出接入与目录/队列接口的统计，不输出会话内容。
