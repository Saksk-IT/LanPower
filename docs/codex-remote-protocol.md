# Codex Remote Relay 协议 v1

适用于 CodexDock Windows / Cloud / Web 1.24.9 与小程序 3.6.14，首屏接口对旧 Host 保留分步读取回退。Relay 子协议保持 v1，电源与设备协议继续为 v2；这条开发链路不写入现有电源命令队列，也不改变 LAN / Gateway 行为。额度、上下文和能力状态规则见 [原生状态说明](codex-native-status.md)。

## 认证与连接

| 端点 | 身份 | 约束 |
|---|---|---|
| `wss://<Cloud>/api/v2/remote/agent` | `Authorization: Bearer <Windows Access Token>` | 只接受 Windows 类型，不允许 Origin 或查询参数 |
| `wss://<Cloud>/api/v2/remote/client/<device_id>` | 现有 `lp_session` Cookie | Origin 精确匹配配置的 Cloud URL；校验账户和 Windows 归属 |
| `wss://<Cloud>/api/v2/remote/mobile/<device_id>` | `Authorization: Bearer <Mobile Access Token>` | 显式 `codex` 权限、账户和 Windows 归属；不接受 Cookie 代替、查询令牌或设备令牌 |
| `GET /api/v2/remote/status/<device_id>` | 浏览器会话，或具备 `codex` 权限的手机 Bearer | 只返回 `state`、`connected`、`busy` 元数据 |

两端必须选择子协议 `lanpower.codex.v1`。每台设备保留一个 Agent，多个已授权网页和小程序共享同一个 Host 会话；新 Agent 替换旧连接（4410），新页面不替换已有页面，也不重新打开 Host。最后一个页面离开后才发送 `close`。认证失败关闭 4403，外层连接参数/子协议非法关闭 4400。主动撤销设备立即关闭所有页面，手机权限撤销仅关闭对应手机连接，其他会话/凭据失效最多 5 秒复核。旧 Cloud 的 4409 在新版客户端提示升级。

网页和小程序可以同时连接同一电脑，手机不需要 Cookie 或 Origin。旧手机的空权限列表只兼容既有电源操作，不赋予 Codex；新增/修改授权时勾选 `codex`，同时保留读取状态所需的 `status`。修改权限需要所属账户的浏览器 CSRF 表单，不轮换手机凭据。权限关闭或授权撤销在连接复核时生效。

小程序沿用 CloudClient 的长期凭据续期，在短期访问凭据到期前重新连接；切后台或页面卸载后在应用内存短暂保留连接 60 秒，同一账号/Cloud/电脑重建页面时复用，超时或切换身份后释放。前台重新读取状态、历史及待审批，完整状态确认前不开放控制。退避 1–30 秒，旧连接回调按代次隔离；任务和决定均不自动重发。正文不进入手机本地存储，富文本仅生成固定节点，不解释 HTML。

## 外层消息

浏览器不指定设备路由或 session，Cloud 根据认证连接绑定设备，同一电脑的页面共用 UUID `session`；Windows 仅接受当前绑定的 session。Cloud 将普通请求 ID 映射为唯一转发 ID，响应只还原给发起页面，即使网页和手机用了同一编号也不会串页。Host 再映射到 app-server 内部 ID。任务通知、状态和审批广播到所有页面，后来连接的页面补发尚未处理的审批；Cloud 对同一审批只允许一个在途决定，已处理通知同步移除所有页面中的审批。

```json
{"type":"hello","protocol":1,"state":"host_ready"}
{"type":"open","session":"<Cloud-generated UUID>"}
{"type":"close","session":"<Cloud-generated UUID>"}
{"type":"state","session":"<Cloud-generated UUID>","state":"runtime_ready"}
{"type":"rpc","session":"<Cloud-generated UUID>","payload":{"id":"<client-id>","method":"thread/start","params":{"cwd":"D:\\Example\\Demo"}}}
{"type":"rpc","payload":{"id":"<client-id>","result":{"thread":{"id":"<thread-id>"}}}}
{"type":"rpc","payload":{"method":"item/agentMessage/delta","params":{"threadId":"<thread-id>","itemId":"<item-id>","delta":"示例输出"}}}
{"type":"rpc","payload":{"id":7,"result":{"decision":"decline"}}}
{"type":"rpc_chunk","id":"<client-id>","rpcId":"<unique-relay-id>","index":0,"count":2,"data":"<JSON response fragment>"}
{"type":"error","code":"method_not_allowed"}
{"type":"ping"}
{"type":"pong"}
```

`hello` 来自 Agent。Cloud 给 Agent 的 `open/close/rpc/rpc_upload` 带 session，Agent 给 Cloud 的 `state/rpc/rpc_chunk` 也带 session；Cloud 给浏览器的消息去掉 session。浏览器发送 `rpc`、`rpc_upload` 与 `ping/pong`。状态枚举为 `cloud_offline`、`host_offline`、`disabled`、`host_ready`、`runtime_starting`、`runtime_ready`、`runtime_error`。未知外层字段、重复 JSON 键、非有限数、非对象和深度超过 24 的 JSON 被拒绝。

### 大请求与大响应分段

逻辑请求、响应和附件不设总大小或分段数量上限。传输分段最多 65536 个 UTF-16 字符，保留完整代理对；分段大小用于控制缓冲，与可上传图片/文件大小无关。

客户端的小请求使用 `rpc`；大请求把整个 `{type:"rpc",payload:{id,method,params}}` JSON 分成 `{type:"rpc_upload",id,index,count,data}`。Cloud 按认证页面隔离组装，检查连续序号、固定数量、重复键与正文 ID；全部到达并完成方法/参数校验后才建立请求路由。Cloud 到 Agent 的分段带认证会话 `session` 和唯一转发 ID，Service 与用户 Host 同样在完整到达后校验。部分上传绝不派发执行；丢弃断开的上传，未完成上传 5 分钟无进展自动清理。上传正文只存在 Cloud 内存，不写数据库、日志或磁盘。

响应沿用 `rpc_chunk`，Cloud 仅记录进度并按顺序转发，客户端验证正文 ID 与 `rpcId` 再组装；移除旧 16 MiB 结果、512 段及 32 MiB 客户端组装上限。过大的完成通知仍通过 `lanpower/historyChanged` 补读完整历史。

发送使用背压等待，客户端、Cloud、管道与 Agent 保留有限缓冲。认证、字段类型、会话绑定和协议顺序继续校验；切换电脑、断线或授权失效清理未完成数据，不自动重发任务。分页每页数量与可读取的总数量分别处理，客户端可继续读取全部分页。

## 客户端方法与参数

| 方法 | 允许参数 |
|---|---|
| `lanpower/status` | 无；Host 返回项目/聊天目录、登录布尔值、活动 Thread/Turn、最近 Diff、待审批、实际控制能力、`capabilityPaging` 及 `library` |
| `lanpower/status`（快速） | `fast`；只返回首屏所需的项目、缓存偏好、活动摘要和能力标记，不在该请求中刷新账号、审批或完整目录；完整状态随后补读 |
| `lanpower/bootstrap` | `threadId`, `archived`, `limit`；一次返回快速状态、第一页模型、协作模式、第一页聊天目录，可附带选中 Thread 的只读内容 |
| `lanpower/session/release` | `threadId`；只释放本地授权范围内的闲置远程会话 |
| `lanpower/chat/start` | `model`；仅自动发现与共享控制启用时，在当前用户 Documents/Codex 下新建独立聊天 |
| `lanpower/library/update` | `revision`, `preferences`；电脑端收纳状态的版本检查与原子更新 |
| `lanpower/library/list` | `query`, `cursor`, `limit`, `archived`, `refresh`；完整授权元数据查询，独立返回 `pinned` |
| `lanpower/library/check` | `threadIds`（至多 256 个编号）, `archived`；核验已缓存编号，返回仍属于该视图的 `data` |
| `lanpower/history/action` | `threadId`, `turnId`, `expectedTailTurnId`, `action`（`fork` / `rollback`）；电脑端稳定轮次定位与操作前检查 |
| `lanpower/files/list` | `cwd`, `path`, `cursor`；授权目录内分页浏览 |
| `lanpower/files/read` | `cwd`, `path`；授权目录内文本预览 |
| `lanpower/files/upload` | `cwd`, `name`, `base64`；原始文件上传至当前 Windows 用户的 CodexDock 附件目录，名称不可含路径/流，新编号隔离文件，不覆盖既有文件 |
| `lanpower/files/search` | `cwd`, `query`；授权目录内文件名/路径搜索 |
| `lanpower/image/read` | `threadId`, `path`；当前授权会话引用的本地图片 |
| `lanpower/automations/list` | 无；读取授权项目的本机自动化配置，不创建或调度 |
| `skills/list`, `plugin/list` | `cwd`, `cursor`, `limit`（1–24）, `refresh`；Host 转换为已授权的本机 `cwds`，页面参数不传给原生接口；旧客户端无分页参数时保留原完整响应 |
| `app/list` | `cursor`, `limit`, `threadId` |
| `mcpServerStatus/list` | `cursor`, `limit` |
| `config/mcpServer/reload` | 无；重新加载本机 MCP 配置 |
| `account/rateLimits/read`, `collaborationMode/list` | 无；原窗口实际额度和协作模式目录。额度更新通知只转发原生字段 |
| `model/list` | `cursor`, `limit` |
| `thread/list` | `cursor`, `limit`, `cwd`, `archived` |
| `thread/start` | `cwd`, `model` |
| `thread/resume` | `threadId` |
| `thread/read` | `threadId`, `includeTurns`, `historyLimit`（1–8） |
| `thread/turns/list` | `threadId`, `cursor`, `limit`；完整可见历史，Host 每页最多 8 轮 |
| `thread/fork` | `threadId` |
| `thread/rollback` | `threadId`, `numTurns`；回退 1–100000 轮，仍受会话授权与原生控制约束 |
| `thread/name/set` | `threadId`, `name` |
| `thread/archive`, `thread/unarchive` | `threadId` |
| `thread/queue/add` | `threadId`, `clientUserMessageId`, `input`, `submissionId` |
| `thread/queue/list` | `threadId`, `cursor`, `limit` |
| `thread/queue/update` | `threadId`, `queuedSubmissionId`, `input`, `submissionId` |
| `thread/queue/delete` | `threadId`, `queuedSubmissionId` |
| `thread/queue/reorder` | `threadId`, `queuedSubmissionIds`，非空、不重复编号列表 |
| `thread/queue/start` | `threadId`, `queuedSubmissionId`（必填，防止恢复后执行其他队列项） |
| `turn/start` | `threadId`, `input`, `model`, `effort`, `mode`（`default` / `plan`）, `submissionId` |
| `turn/interrupt` | `threadId`, `turnId` |
| `turn/steer` | `threadId`, `expectedTurnId`, `input`, `submissionId`；必须匹配本 Runtime 的当前任务 |
| `lanpower/submission/read` | `threadId`, `submissionId`（1–100 字符）；只读取已授权会话的本机回执 |
| `lanpower/history/item/read` | `threadId`, `reference`（1–100 字符）, `offset`（非负 UTF-16 字符偏移）；读取本机会话绑定的临时引用 |

请求必须是 `{id, method, params}`。ID 为 1–100 字符字符串或 JavaScript 安全整数；limit 为 1–50。input 为非空列表：`{type:"text",text}`、`{type:"image",url:"data:image/...;base64,..."}`（png/jpeg/webp/gif）及 `{type:"skill",name,path}`。不设文字长度、图片大小/数量、技能大小/数量上限，不压缩、不裁剪；拒绝无效 Unicode 与无效图片格式。共享/原窗口发送技能前，Host 验证其与当前授权会话原生目录中的启用项相符。Cloud、Service 和 Host 分别检查方法/参数；Host 校验实际 Thread cwd，过滤列表中的未授权项目。`initialize/initialized` 与 `account/read` 由 Host 内部调用，账户结果仅返回登录布尔值；不能由浏览器直通。

### 1.24.9 首屏 bootstrap 与后台目录预热

`lanpower/bootstrap` 是 Cloud 路径的首屏聚合读取接口，不创建、恢复或订阅会话。Host 返回的 `status.fast:true` 只代表快速快照，`loggedIn:false` 不代表已登出；客户端必须等待后续完整 `lanpower/status` 确认账号和控制能力。`threadId` 存在时，附带的 `thread` 仍遵守只读历史、项目授权和原生快照规则。

Host 在 `runtime_ready` 后后台发现项目并建立活跃/归档目录。目录第一页可以带 `stale:true, refreshing:true`，客户端应继续展示已有外壳或缓存，并在刷新完成后重读；目录未准备好时不能用空页覆盖旧列表。查询和归档筛选仍通过同一授权范围，缓存只保存摘要与组织元数据。

Cloud 已识别有效 RPC 编号后的方法/参数校验失败，返回关联响应 `{id,error:{code:-32602,message:"<固定类别>",data:{notSent:true}}}`，不进入路由与电脑派发。客户端立即显示未发送并保留草稿；帧结构或编号本身无效仍使用外层错误。断线、超时和已派发请求继续沿用回执查询，不推断未执行。

独立模式 Host 为创建/恢复强制 `approvalPolicy:on-request`、`sandbox:workspace-write`；为 turn 强制当前本地允许 cwd 和 `workspaceWrite` 策略，`networkAccess:false`，排除临时目录额外写入。`thread/list` 内部追加来源筛选以包含 app-server 创建的会话。浏览器不能修改这些字段。

1.11.0 的 `thread/list` 可省略 `cwd`，按更新时间读取所有已授权本机会话，跨已配置的模型提供方；客户端不能覆盖来源、提供方或项目发现规则。自动发现通过内部 `project/list`、已登记的桌面项目元数据和近期有效工作目录进行，不读取登录文件。关闭自动发现后仍只允许手动目录。

桌面已保存会话的 `thread/read` / 列表摘要可带 `live`：`source=localSession`，`state=running|idle|unknown`，`turnId`、`startedAt`、`updatedAt` 和有界活动摘要。状态来自本机真实生命周期及系统写锁，浏览器每 2 秒读取选中会话。近期轮次附带真实 `startedAt` / `completedAt` / `durationMs`；工具活动只含名称和执行状态，不含原始参数、隐藏推理或登录数据。`control=desktop` 仍不允许修改、引导和中断；`live` 是只读观察，不赋予桌面控制权。

独立模式 `thread/read` 只读取，不恢复会话。原窗口与共享模式按原生 `thread/turns/list {itemsView:"full",sortDirection:"desc"}` 游标取最近 8 轮，摘要带 `historyCursor`；客户端继续分页至开头。只在原生接口明确返回 `-32601` 时退回完整 `thread/read`，使用 `lp-history-v1:<offset>` 分页。可见历史不再按每轮 80 项、单项 8000 字或总计 128 轮裁剪；公开推理摘要可显示，隐藏正文与加密推理不转发。旧独立桌面保存记录的只读活动摘要仍有自己的限额，不能把该路径当作原窗口完整历史。

摘要返回 `control: desktop/available/remote/shared`、项目范围、`isChat` 及实际读取到的 model / reasoningEffort / collaborationMode。桌面仍持有独立写锁时，继续、引导、中断及其他修改操作被拒绝。`turn/steer` 的输入约束与 `turn/start` 相同，不能带模型、目录或策略覆盖；`expectedTurnId` 必须匹配当前任务。

## 1.16.0 状态版本、发送回执和超大历史

`lanpower/status` 增加 `lanpowerRevision`、`submissionReceipts`、`largeHistory` 与 `unsupportedMethods`。会话摘要及通知参数也带 `lanpowerRevision`，网页结合读取开始时的本地状态代次核对，避免旧快照或旧任务完成事件覆盖新任务。重连、回到前台和定期补读恢复审批/任务/队列，不重发写操作。

`submissionId` 对四类发送方法为可选兼容字段；1.16 网页生成稳定编号并始终携带。Host 从原生参数中移除它，在本机先记录再派发，相同编号/参数返回原回执而不重新派发；不同会话或参数返回 `submission_mismatch`。成功结果增加 `receipt`；查询返回 `sending|accepted|failed|uncertain|unknown` 及实际可得的任务/队列编号。发送中重启转为 uncertain，只有明确拒绝可标记 failed，传输失联不推断未执行。文件仅保存元数据与哈希，不保存输入正文。

大项替换为 `{type:"lanpowerLargeItem",id,originalType,reference,characters,bytes,wholeTurn}`，`wholeTurn:true` 表示完整轮次。客户端通过 `lanpower/history/item/read` 取得 `{offset,data,nextOffset,characters}`；每块最多 64 Ki 个 UTF-16 字符，末块 `nextOffset:null`，代理对保持完整。引用绑定 threadId，读取前重新核对授权。Renderer / Host 将发布引用与正文分离：可重读正文缓存按 64 MiB 预算淘汰，1.21.0 不再拒绝大项或限制引用数量，保留 10 分钟空闲租约续期。正文被淘汰时引用保留，按原生 turn/item 重新定位并核对内容哈希；过期或变化明确返回错误。网页/小程序每项最多自动尝试三次，随后手动重试。正文不写 Cloud。

网页超限页按 8/4/2/1 缩小，在会话内自动恢复完整大项，取消后保留已完成轮次与当前块偏移，失败不重放发送。1.21.0 已移除内容和结果总大小拒绝，保留分块缓冲、背压与内存中继。具体测试与人工验收范围见 [P0 记录](codex-remote-p0.md) 和 [首批六项修复](codex-remote-first-six-fixes.md)。

## 1.18.0 定位操作与聊天目录

`lanpower/status` 增加 `targetedHistoryActions`、`historyReferenceLeases` 和 `libraryCatalog`。指定历史轮次的分支/回退需要前一能力为 true 且会话具有 `historyTailTurnId`；缺少时禁用该操作并提示更新。完整聊天库缺少能力时沿用旧列表，并说明搜索只覆盖已加载聊天。

`lanpower/history/action` 在电脑端核对项目授权、目标轮次、原生最新尾轮和活动状态。分支使用内部 `thread/fork.lastTurnId`；回退分页读取全会话元数据后计算移除数量，执行前再读最新尾轮。历史变化返回 `history_changed`，不改变客户端阅读位置。该方法仅在共享/原窗口模式启用，不允许客户端指定原生尾部轮数。

`lanpower/library/list` 返回 `{data,pinned,nextCursor,revision}`。电脑端获取活跃/归档授权元数据，不设总条数上限；查询覆盖标题、预览、目录、项目名称及别名。`refresh:true` 强制刷新，其他读取最多复用 5 秒快照。游标绑定快照修订号，变化返回 `library_cursor_changed`。`check` 从完整快照核对旧编号；客户端仅删除可靠确认不在视图中的条目，不用首屏缺席推断删除。归档、恢复、新会话和重命名事件触发更新，定期读取补偿遗漏。组织状态与元数据快照修订号分别维护。

## 1.15.1 电脑端项目组织和资源

`lanpower/status.library` 为 `{revision, preferences}`。preferences 包含 `collapsed`、`pinned`、`hidden`、`order`、`aliases`、`sections`、`sort` 与 `chatsFirst`，不设集合数量、别名长度和文件总量上限。更新须带已读取的 revision；冲突返回当前版本及 `conflict:true`，客户端合并后重试。Host 验证置顶会话仍在授权范围，串行写临时文件再替换 `%LOCALAPPDATA%/LanPower/codex-library.json`。该文件只保存组织元数据，不直接改写官方桌面全局状态。

文件路径须落在明确授权目录内，拒绝目录穿越、网络路径和 reparse point。目录每页 100 项，枚举总量、文件大小、搜索项数和深度不设上限；二进制文件返回对应标志。搜索跳过版本库与依赖内部目录。上传只允许新建当前用户附件，不允许覆盖任意电脑文件，不直接执行上传内容。

图片不设文件大小拒绝，检查 png/jpeg/gif/webp/bmp 文件头，返回 `{contentType,size,base64}`。授权会话目录外的图片须来自该会话已读取的可见内容；引用索引按会话隔离，不允许其他会话复用。网页按需读取并使用有界 object URL 缓存，切换电脑/连接时清理。

## 1.13.1 共享执行与原生队列

`lanpower/status` 返回 `sharedControl:true`、`queueSupported:true`、`sessionHandoff:false`；会话摘要可返回 `control:shared`。旧状态与独立进程路径保持兼容。共享 `thread/read` 在授权检查后以 `thread/resume {threadId,excludeTurns:true}` 订阅当前任务，不设置权限、模型或目录覆盖；状态与活动编号从同一服务及当前轮次读取。共享会话无需释放，`lanpower/session/release` 被拒绝；旧独立桌面仍按写锁保护。

`thread/queue/*` 是本机 CLI 的实验性原生接口，不是 Cloud 自建任务队列。新增/更新的 input 使用上述相同约束；消息身份与队列编号不超过 100 字符，重排拒绝重复或空集合。原生 `thread/queue/changed` 通知触发列表重读，断线后读回队列而不重新添加。队列执行沿用该原生会话已有设置；备用共享与独立模式的新建即时任务使用受限权限。

共享服务由独立用户进程持有，只监听 `127.0.0.1`。后端使用 32 字节随机 Bearer，凭据经 `CurrentUserOnly` 命名管道传递；Token 文件及桌面配置仅允许当前用户/SYSTEM。官方桌面的本地网关使用另一随机入口，拒绝 Origin、查询参数与畸形 Upgrade，只转发有界文本帧；转发认证不会出现在 Cloud URL。Host 退出、远程断线和撤销授权只断开其连接，不结束共享引擎。安装器将服务放入版本目录并限定自动关闭的程序，避免升级时结束共享任务。

审批由同一原生服务解决一次，再映射已解决编号给网页；不覆盖已有桌面权限，不对共享审批执行独立模式的 5 分钟自动拒绝。会话通知按已授权线程过滤，保留公开推理摘要并移除隐藏/加密内容，Diff 按会话分开维护。详细实测与边界见 [共享控制](codex-remote-takeover.md)。

## 原 Codex 窗口

`desktopControl:true` 表示用户 Host 通过已启用的本机调试接口连接原窗口 AppServerManager，继承该窗口的会话、任务、权限、队列和审批；不为原窗口 turn/start 覆盖 sandbox / approvalPolicy。目录和资源仍受 CodexDock 本机授权检查。连接、断线与升级不自动关闭或重启官方桌面。

原窗口 conversationState / streamRole / turnCompleted 转为 `lanpower/conversation/changed`、`lanpower/stream/changed` 与 `lanpower/historyChanged`；`thread/settings/updated` 更新会话模型、思考强度和协作模式。网页以事件驱动刷新，30 秒检查用于断线或遗漏后的恢复。CDP 通知队列拥塞时记录有界的待补读会话；Host 输出拥塞时也合并历史更新提示，不靠丢掉最终输出维持连接。审批请求不能作为普通增量静默丢弃。

该入口依赖官方桌面的内部接口；版本兼容性、原窗口实测及未对齐能力见 [原窗口整合](codex-original-window.md) 和 [系统对齐](codex-system-parity.md)。

## 独立模式通知与审批

`lanpower/status` 增加 `sessionHandoff:true` 和 `activeTurns:[{threadId,turnId}]`；旧字段保持兼容。旧 Host 缺少此能力标志时网页禁用交还按钮。

Host 使用只读目录连接及按需创建的独立会话进程，不设会话数量上限；每会话按自己的活动编号校验引导/暂停。任务结束约 2–4 秒后检查加载状态、全部活动子任务、审批及后台命令，安全时释放该进程并发送 `lanpower/session/released`（`params.threadId`）。主动交还拒绝运行中任务；无法确认后台状态时不释放。其他会话不受影响。断开网页连接仍不结束运行中任务，完成后的释放检查继续进行。

Host 仅转发线程/任务状态、计划、item 开始/完成、AI/工具增量、`turn/diff/updated`、`serverRequest/resolved`、`account/rateLimits/updated` 和 Runtime `error` 通知；账号登录结果和凭据通知仍不转发。

| Server Request | 允许响应 |
|---|---|
| `item/commandExecution/requestApproval` / `item/fileChange/requestApproval` | `{decision:"accept"/"decline"/"cancel"}`，单次；额外文件目录必须已在本机授权 |
| `item/permissions/requestApproval` | 拒绝，或仅批准原请求中的网络权限，`scope:"turn"`；不接受文件系统范围 |
| `item/tool/requestUserInput` | `{answers:{<question-id>:{answers:["..."]}}}`，不设回答数量与文字长度上限 |
| `mcpServer/elicitation/request` | `{action:"decline"/"cancel", content:null}`；接受需在本机处理 |

审批 ID 必须对应当前待审批集合，提交中的 ID 不能重复发送。Host 再检查决定与待审批原请求，Runtime 确认后清除；Host 拒绝时恢复可操作状态。独立模式未处理请求 5 分钟后拒绝。不存在永久批准、远端登录、任意配置写入、插件安装、任意文件 RPC 或 `command/exec`；文件与图片开放上文受授权检查的读取和附件上传，不允许任意文件覆盖。

## 限额、断线与数据

- 帧大小 1 MiB，JSON 深度 24；Relay 队列最多 32 帧且累计不超过 8 MiB，Agent 出站队列 16 帧、Host 8 个有界本地响应。服务端发送超时 10 秒。分段发送等待队列容量，避免大历史将所有分段一次性塞入 Cloud 内存。
- 待响应/审批不设数量上限；每个页面最多 120 次逻辑请求/10 秒，上传分块不重复计入。Runtime RPC 沿用原生调用超时；网页/小程序和 Relay 在途请求等待 5 分钟，不以消息字数拒绝请求。
- 30 秒无消息时 Ping，90 秒无响应时关闭；不使用任务耗时判定 Runtime 失败。浏览器退避 1–30 秒、Agent 2–60 秒重连，均不重发任务。
- Agent 将中继 `error` 帧作为当前连接失败处理；协议拒绝、无效数据与非停机的连接取消进入重试。Host 管道在拒绝无效消息后重新监听，不让远程开发连接异常终止整个 Windows 电源服务。
- 固定错误码包括 `invalid_frame`、`invalid_chunk`、`method_not_allowed`、`params_not_allowed`、`invalid_decision`、`approval_unavailable`、`request_busy`、`agent_offline`、`remote_backpressure`、`remote_revoked`、`rate_limited`。Host 拒绝返回 `-32000` 与固定类别 `request_rejected/desktop_session_busy/task_running/workspace_not_allowed/turn_changed/approval_unavailable/too_many_sessions/background_running/session_release_unavailable/result_too_large`，不暴露本机异常文本。本机 Runtime 收发和代理不设置原先的消息字节拒绝，大响应经分段传输。
- Cloud 仅内存转发，审计记录固定事件类别、账户/设备编号与时间，不保存正文。浏览器内存和本机 Runtime 保存当前任务/历史，项目组织存于本机用户目录，PWA 不缓存会话内容。TLS 在 Cloud 终止，当前不是端到端加密。
- 部署保持一个 worker/副本，重启丢弃路由与队列。任务是否继续以本机 Host/Runtime 为准，重连后读取状态和 Thread；不能根据超时自动重新执行。

同一共享会话的在途请求和待审批正文只保存在内存中，不设上述数量及总量拒绝。单个页面队列溢出只断开该页面，不撤销其他页面或电脑 Agent。
