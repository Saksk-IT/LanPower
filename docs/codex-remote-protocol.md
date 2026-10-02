# Codex Remote Relay 协议 v1

适用于 LanPower Windows / Cloud 1.11.0。电源与设备协议继续为 v2；这条开发链路不写入现有电源命令队列，也不改变 LAN / Gateway 行为。

## 认证与连接

| 端点 | 身份 | 约束 |
|---|---|---|
| `wss://<Cloud>/api/v2/remote/agent` | `Authorization: Bearer <Windows Access Token>` | 只接受 Windows 类型，不允许 Origin 或查询参数 |
| `wss://<Cloud>/api/v2/remote/client/<device_id>` | 现有 `lp_session` Cookie | Origin 精确匹配配置的 Cloud URL；校验账户和 Windows 归属 |
| `GET /api/v2/remote/status/<device_id>` | 同一浏览器会话 | 只返回 `state`、`connected`、`busy` 元数据 |

两端必须选择子协议 `lanpower.codex.v1`。设备最多一个 Agent 和一个控制页面，新 Agent 替换旧连接（4410），第二控制页面返回 `controller_busy` 并关闭（4409）。认证失败关闭 4403，外层连接参数/子协议非法关闭 4400。主动撤销设备立即关闭，其他会话/凭据失效最多 5 秒复核。

## 外层消息

浏览器不指定设备路由或 session，Cloud 根据认证连接绑定设备，生成 UUID `session`；Windows 仅接受当前绑定的 session。审批由 Host 映射为唯一远程请求 ID，响应和已处理通知按对应的会话连接还原；普通客户端请求由 Host 转为内部唯一 ID 调用 app-server，再恢复客户端 ID。

```json
{"type":"hello","protocol":1,"state":"host_ready"}
{"type":"open","session":"<Cloud-generated UUID>"}
{"type":"close","session":"<Cloud-generated UUID>"}
{"type":"state","session":"<Cloud-generated UUID>","state":"runtime_ready"}
{"type":"rpc","session":"<Cloud-generated UUID>","payload":{"id":"<client-id>","method":"thread/start","params":{"cwd":"D:\\Example\\Demo"}}}
{"type":"rpc","payload":{"id":"<client-id>","result":{"thread":{"id":"<thread-id>"}}}}
{"type":"rpc","payload":{"method":"item/agentMessage/delta","params":{"threadId":"<thread-id>","itemId":"<item-id>","delta":"示例输出"}}}
{"type":"rpc","payload":{"id":7,"result":{"decision":"decline"}}}
{"type":"error","code":"method_not_allowed"}
{"type":"ping"}
{"type":"pong"}
```

`hello` 来自 Agent。Cloud 给 Agent 的 `open/close/rpc` 带 session，Agent 给 Cloud 的 `state/rpc` 也带 session；Cloud 给浏览器的消息去掉 session。浏览器只发送 `rpc` 与 `ping/pong`。状态枚举为 `cloud_offline`、`host_offline`、`disabled`、`host_ready`、`runtime_starting`、`runtime_ready`、`runtime_error`。未知外层字段、重复 JSON 键、非有限数、非对象和深度超过 24 的 JSON 被拒绝。

## 客户端方法与参数

| 方法 | 允许参数 |
|---|---|
| `lanpower/status` | 无；Host 返回自动发现/手动授权的项目和目录、是否登录、活动 Thread/Turn、最近 Diff、待审批 |
| `lanpower/session/release` | `threadId`；只释放本地授权范围内的闲置远程会话 |
| `model/list` | `cursor`, `limit` |
| `thread/list` | `cursor`, `limit`, `cwd`, `archived` |
| `thread/start` | `cwd`, `model` |
| `thread/resume` | `threadId` |
| `thread/read` | `threadId`, `includeTurns` |
| `thread/name/set` | `threadId`, `name` |
| `thread/archive`, `thread/unarchive` | `threadId` |
| `turn/start` | `threadId`, `input`, `model`, `effort` |
| `turn/interrupt` | `threadId`, `turnId` |
| `turn/steer` | `threadId`, `expectedTurnId`, `input`；必须匹配本 Runtime 的当前任务 |

请求必须是 `{id, method, params}`。ID 为 1–100 字符字符串或 JavaScript 安全整数；limit 为 1–50。任务 input 只能是一项 `{type:"text", text:"..."}`，最多 16,000 字符。Cloud、Service 和 Host 分别检查方法/参数；Host 校验实际 Thread cwd，过滤列表中的未授权项目。`initialize/initialized` 与 `account/read` 由 Host 内部调用，账户结果仅返回登录布尔值；不能由浏览器直通。

Host 为创建/恢复强制 `approvalPolicy:on-request`、`sandbox:workspace-write`；为 turn 强制当前本地允许 cwd 和 `workspaceWrite` 策略，`networkAccess:false`，排除临时目录额外写入。`thread/list` 内部追加来源筛选以包含 app-server 创建的会话。浏览器不能修改这些字段。

1.11.0 的 `thread/list` 可省略 `cwd`，按更新时间读取所有已授权本机会话，跨已配置的模型提供方；客户端不能覆盖来源、提供方或项目发现规则。自动发现通过内部 `project/list`、已登记的桌面项目元数据和近期有效工作目录进行，不读取登录文件。关闭自动发现后仍只允许手动目录。

桌面已保存会话的 `thread/read` / 列表摘要可带 `live`：`source=localSession`，`state=running|idle|unknown`，`turnId`、`startedAt`、`updatedAt` 和有界活动摘要。状态来自本机真实生命周期及系统写锁，浏览器每 2 秒读取选中会话。近期轮次附带真实 `startedAt` / `completedAt` / `durationMs`；工具活动只含名称和执行状态，不含原始参数、隐藏推理或登录数据。`control=desktop` 仍不允许修改、引导和中断；`live` 是只读观察，不赋予桌面控制权。

`thread/read` 只读取，不恢复会话；Host 内部使用分页历史取最近 8 轮，每轮最多 80 项、文字字段最多 8,000 字符，总内容约 240,000 字符。返回 `control: desktop/available/remote`、项目名称和范围。桌面仍持有写锁时，继续、引导、中断及其他修改操作被拒绝。`turn/steer` 的输入约束与 `turn/start` 相同，不能带模型、目录或策略覆盖；`expectedTurnId` 必须匹配本 Runtime 当前任务，不能引导其他会话。

## 通知与审批

`lanpower/status` 增加 `sessionHandoff:true` 和 `activeTurns:[{threadId,turnId}]`；旧字段保持兼容。旧 Host 缺少此能力标志时网页禁用交还按钮。

Host 使用只读目录连接及最多 8 个独立会话进程；每会话按自己的活动编号校验引导/暂停。任务结束约 2–4 秒后检查加载状态、全部活动子任务、审批及后台命令，安全时释放该进程并发送 `lanpower/session/released`（`params.threadId`）。主动交还拒绝运行中任务；无法确认后台状态时不释放。其他会话不受影响。断开网页连接仍不结束运行中任务，完成后的释放检查继续进行。

Host 仅转发线程/任务状态、计划、item 开始/完成、AI/工具增量、`turn/diff/updated`、`serverRequest/resolved` 和 Runtime `error` 通知，不转发账号登录/凭据通知。

| Server Request | 允许响应 |
|---|---|
| `item/commandExecution/requestApproval` / `item/fileChange/requestApproval` | `{decision:"accept"/"decline"/"cancel"}`，单次；额外文件目录必须已在本机授权 |
| `item/permissions/requestApproval` | 拒绝，或仅批准原请求中的网络权限，`scope:"turn"`；不接受文件系统范围 |
| `item/tool/requestUserInput` | `{answers:{<question-id>:{answers:["..."]}}}`，有数量和文字长度限制 |
| `mcpServer/elicitation/request` | `{action:"decline"/"cancel", content:null}`；接受需在本机处理 |

审批 ID 必须对应当前待审批集合，提交中的 ID 不能重复发送。Host 再检查决定与待审批原请求，Runtime 确认后清除；Host 拒绝时恢复可操作状态。未处理请求 5 分钟后拒绝。不存在永久批准、远端登录、配置写入、插件安装、任意文件 RPC 或 `command/exec`。

## 限额、断线与数据

- 帧大小 1 MiB，JSON 深度 24；Relay 队列最多 32 帧且累计不超过 8 MiB，Agent/Host 出站队列各 16 帧。服务端发送超时 10 秒。
- 待响应/审批各最多 64；浏览器最多 120 请求/10 秒。Runtime RPC 等待 30 秒、浏览器 35 秒，Relay 待请求超过 120 秒关闭。
- 30 秒无消息时 Ping，90 秒无响应时关闭；不使用任务耗时判定 Runtime 失败。浏览器退避 1–30 秒、Agent 2–60 秒重连，均不重发任务。
- 固定错误码包括 `invalid_frame`、`method_not_allowed`、`params_not_allowed`、`invalid_decision`、`approval_unavailable`、`request_busy`、`agent_offline`、`remote_backpressure`、`remote_revoked`、`rate_limited`。Host 拒绝返回 `-32000` 与固定类别 `request_rejected/desktop_session_busy/task_running/workspace_not_allowed/turn_changed/approval_unavailable/too_many_sessions/background_running/session_release_unavailable`，不暴露本机异常文本。本机 stdio 接收上限为 8 MiB，近期历史截断后才进入 1 MiB Relay。
- Cloud 仅内存转发，审计记录固定事件类别、账户/设备编号与时间，不保存正文。浏览器内存和本机 Runtime 保存当前任务/历史，PWA 不缓存内容。TLS 在 Cloud 终止，当前不是端到端加密。
- 部署保持一个 worker/副本，重启丢弃路由与队列。任务是否继续以本机 Host/Runtime 为准，重连后读取状态和 Thread；不能根据超时自动重新执行。
