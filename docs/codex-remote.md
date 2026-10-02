# Codex Remote 使用与验收

LanPower 1.8.0 的第一阶段远程开发入口是 Cloud 的 `/remote` 网页，也可添加为 PWA。开发任务在自己的 Windows 电脑上执行，Cloud 转发消息，Codex 登录、项目代码和会话历史留在电脑。现有小程序、电源控制和 Wake Gateway 继续使用原链路。

## 准备与首次连接

1. 构建并安装 Windows 1.8.0，同时将自己的 Cloud 更新到 1.8.0。公开 v1.6.1 安装器和正式 Cloud 1.7.2 暂不提供 Codex Remote。更新前备份原配置和数据库，保留配对身份。
2. 在准备远程使用的 Windows 用户下安装官方 Codex CLI，并在电脑上完成登录。检查 `codex --version` 和本机 Codex 能正常工作。安装器只包含 LanPower Host，不包含 Codex CLI 或登录凭据；本轮协议验证使用 CLI `0.159.0`。
3. 在 LanPower「远程连接」中先连接自己的 Cloud。启用「Codex Remote」，添加允许开发的项目目录，点击保存。授权按 Windows 用户保存，默认关闭；只接受普通本机目录，不接受网络路径、符号链接或目录联接。
4. 登录 Cloud 网页，进入「Codex Remote」，选择电脑并连接。项目列表来自电脑端授权，不能在网页添加目录。选择项目，创建新会话，或点击已有会话恢复。
5. 输入任务并发送，查看实时 AI/工具输出和代码修改 Diff。命令或文件需要审批时，查看上下文后拒绝或批准一次；页面没有永久批准选项。任务运行时可以中断，收到本机确认后更新状态。
6. 手机可在支持的浏览器中添加页面到主屏幕。电脑离线时，先使用页面的「唤醒电脑」或既有小程序唤醒；此操作仍需要已配置且可用的 Wake Gateway。上线后连接程序自动恢复。

Cloud 必须是 Windows 和浏览器都可访问、证书可信的 HTTPS 地址，反向代理需支持 WebSocket Upgrade。电脑只发起 HTTPS/WSS 出站连接，不需要端口映射。现有本机开发地址 `https://localhost:8443` 只供当前电脑使用，手机自己的 localhost 不能连接它；正式公网验收需用户另行部署 Cloud 1.8.0。

## 状态与操作

| 页面状态 | 含义与下一步 |
|---|---|
| 电脑未连接 Relay | 电脑离线、Cloud 旧版或网络不可达；先查看电源状态与 Cloud 连接 |
| 用户 Host 未运行 | Windows 尚未登录用户，或 Host 未启动；在电脑打开 LanPower |
| 本机尚未授权 | 在电脑启用远程开发并保存至少一个项目 |
| Runtime 启动中 | 用户 Host 正在启动本机 Codex |
| Runtime 未就绪 | 在电脑检查 CLI、登录和运行环境，再断开并连接 |
| Codex 已连接 | 连接就绪；尚未登录时仍会提示在本机完成登录 |
| 另一页面正在控制 | 每台电脑只允许一个控制页面；关闭另一个页面再连接 |

Windows 已登录是必要条件。锁屏通常保留用户会话；注销会结束用户 Host。唤醒电脑不等于完成 Windows 登录，电脑从关机启动但没有登录用户时，远程开发仍不可用。MVP 不设置自动登录，也不会用 SYSTEM 代替用户运行 Codex。

## 断线、恢复与审批

- 关闭或刷新浏览器只断开控制连接，已发任务继续在电脑运行。重连读取活动任务、最近 Diff、未完成审批和本机保存的会话；不会自动重发任务。发送结果未知时先恢复会话确认。
- 空的新会话在首次任务前由 Host 内存保留，最多 32 个。官方 app-server 尚未持久保存的空会话，在 Host 重启后消失；首次任务后的历史由本机 Codex 管理。
- 每台电脑一个 Runtime、一个活动远程任务。可浏览其他会话，但要等活动任务完成或中断后再发送新任务。
- 命令和文件只可单次审批。带额外文件目录的请求必须精确匹配本机授权项目根目录；额外文件系统权限和永久策略变更不可在网页批准。网络权限最多当前任务 turn；MCP 交互登录/授权需在电脑处理。
- 未处理审批 5 分钟后拒绝。浏览器断线后审批保留在本机，重新连接后可继续处理；到期或 Runtime 已解决的审批不能再次批准。
- 关闭本地授权或修改项目配置会结束 Runtime 及其工具进程，终止中的任务可能已有部分修改，应在本机检查代码。Host 使用 Windows Job Object，进程崩溃或卸载退出时结束其子进程。
- 服务/Cloud 重启、网络断开不自动重发开发任务。Host 保持用户 Runtime，重连绑定新的控制会话；Windows 注销、Host 退出后的恢复依赖 Codex 的本机会话历史。

## 保存与安全边界

用户授权配置位于 `%LOCALAPPDATA%\LanPower\codex-remote.json`，不保存 OpenAI 密钥。Host 使用当前用户已有的 Codex Home，不复制到 ProgramData 或 Cloud。卸载保留 LanPower 原配对与用户配置，并移除用户 Host 启动项。

Relay 使用有界内存队列，不把提示词、输出、完整代码、Diff 或审批正文保存到数据库和日志。审计仅含账户/设备编号、事件类型和时间。PWA 只缓存版本化公开静态文件，HTML、接口、会话、任务和 Diff 不进入 Service Worker 缓存；不支持离线发任务。

TLS 在 Cloud 终止，当前 MVP **不是端到端加密**，自建 Cloud 的运维者属于可信边界。Runtime 按 `workspace-write` / `on-request` 运行；这限制写入和需要批准的工具操作，但不是完整文件保密沙箱，不保证阻止读取 Windows 用户可读文件。请只授权可信项目，仔细审核命令，保护 Cloud 登录及 Windows 用户账户。

Relay 单帧最多 1 MiB，队列最多 32 帧且累计 8 MiB，最多 64 个待回复/审批，10 秒最多 120 个浏览器请求。超限断开而不自动重试任务。页面保留最多约 256 KiB 实时文字和最近 Diff、5,000 行 Diff；较大历史或输出需要回到本机查看。Cloud 当前仅支持单个 worker/副本。

## 本轮验证（2026-10-02）

- Cloud 184 项自动测试通过：同源/类型/所有权校验、禁用方法和策略覆盖、重复审批、设备撤销、Agent 替换、畸形 JSON、大小/背压及正文不入库。
- Windows 61 项单元测试通过，包含项目范围、真实用户 Host 与服务管道往返、授权关闭、模拟 app-server 审批、Diff、中断和退出；桌面布局及 LAN dry-run 继续回归。
- 官方 CLI Schema 与真实 stdio 初始化、创建、列表验证通过，使用独立 Codex Home，不读取登录文件或发起推理。
- 本机 Docker 正常 TLS 校验下，真实 Chromium + WSS Relay 在 1440/390/320px 通过创建会话、实时输出、文件审批、Diff、中断、XSS 文本展示和仅静态 PWA 缓存；Runtime 消息使用测试替身。
- 使用当前 Windows 用户真实登录的 Codex，经实际 Service WSS Agent、用户 Host 管道与 390px 浏览器提交中文任务，批准单次文件修改，确认测试文件由 old 改为 new，收到实时输出与实际 Diff，刷新后恢复会话和 Diff。本轮发现并修复了 Windows stdio 字符编码、无汇总通知时的文件 Diff 展示；验证目录与设备凭据独立，原生产配对未切换。
- 本机 Cloud 已更新 1.8.0，原开发数据卷/登录配置/证书保留。Windows 已通过 Setup 就地升级并核对组件哈希，升级前的 LAN 配对、Cloud 设备身份和用户项目授权保留。新用户的远程开发默认关闭；本机已保存的启用状态不被重置。检测到正在使用的控制页面时，不额外接管连接。

真实 Codex 任务已在本机完整链路通过，正式公网 5G 仍待人工验收。已完成本机验证不等于正式 Cloud 已部署、电脑已物理唤醒或手机公网开发已验收。

## 后续人工验收

在用户要求部署正式 Cloud 后：用手机 5G 登录、查看状态、实际唤醒、等待 Windows 用户会话恢复，再提交一个可审查的小型开发任务。核对实时输出、批准/拒绝、实际文件 Diff、断网重连、中断及撤销后无法再控制。另验收 Windows 注销/重新登录、关机后人工登录、长任务和较大输出。

本机可运行：

```powershell
python scripts/verify-codex-protocol.py
python -m pytest cloud_app/tests -q
dotnet test windows/LanPower.UnitTests -c Release
dotnet run --project windows/LanPower.Desktop.Tests -c Release
dotnet run --project windows/LanPower.Tests -c Release
node tests/test_cloud_remote.js
```

协议与 Runtime 接入参考 [OpenAI 官方 app-server 文档](https://developers.openai.com/codex/app-server)；实际白名单、限额和转发规则以 [LanPower Relay 协议](codex-remote-protocol.md) 为准。
