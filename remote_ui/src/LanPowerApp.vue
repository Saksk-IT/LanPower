<template>
  <div class="lp-codex" :class="{ 'lp-chat-open': chatOpen, 'lp-sidebar-collapsed': sidebarCollapsed }">
    <aside class="lp-library" aria-label="电脑、项目和会话">
      <LanPowerThreadTree :device-id="deviceId" :projects="projects" :threads="displayedThreads" @search="searchLibrary" :current-thread="current" :selected-thread-id="threadId" :active-turns="activeTurns" :approval-threads="approvals.map(a => a.threadId)" :ready="ready" :loading="loadingLibrary" :next-cursor="listCursor" :archived="archivedView" :chat-supported="chatSupported" :saved-preferences="libraryState.preferences" @update-library="saveLibrary" @select="openThread" @new-thread="openNewThread" @new-chat="newChat" @toggle-sidebar="toggleSidebar" @load-more="loadThreads(true)" @toggle-archived="toggleArchived" @navigate="navigate" @thread-action="sidebarThreadAction" @browse-files="openFiles">
      <template #connection><div class="lp-device-context"><ComposerDropdown class="lp-device-picker" :model-value="deviceId" :options="devices.map(d => ({value:d.id,label:d.name}))" placeholder="选择开发电脑" enable-search search-placeholder="搜索电脑" @update:model-value="changeDevice" />
      <div class="lp-connection" role="status"><span :class="{ 'is-ready': ready }" />{{ stateLabel }}<button v-if="!ready && deviceId" @click="reconnect">重连</button></div>
      <p v-if="wakeAvailable" class="lp-power"><span>{{ powerText }}</span><button :disabled="waking" @click="wake">唤醒</button></p></div></template>
      </LanPowerThreadTree>
    </aside>
    <main v-show="view === 'chat'" class="lp-conversation">
      <header class="lp-chat-header"><button class="lp-back" @click="chatOpen = false" aria-label="返回会话列表"><IconTablerLayoutSidebar /></button><button v-if="sidebarCollapsed" class="lp-expand lp-icon-button" @click="sidebarCollapsed = false" aria-label="展开侧栏"><IconTablerLayoutSidebar /></button><div><h1>{{ currentTitle }}</h1></div><button v-if="currentCwd" class="lp-header-pill" @click="openFiles(currentCwd)" aria-label="浏览项目文件"><IconTablerFolder /><span>{{ projectName(currentCwd) }}</span></button><details v-if="threadId" class="lp-actions"><summary aria-label="会话操作">•••</summary><div><button @click="refreshCurrent">刷新会话</button><button :disabled="loadingAllHistory" @click="jumpToBeginning">跳至对话开头</button><button @click="renameThread">重命名</button><button @click="forkThread()">分支会话</button><button @click="archiveThread">归档</button></div></details></header>
      <div class="lp-chat-status" role="status"><span>{{ stateLabel }}</span><span>{{ taskLabel }}</span><span>{{ syncLabel }}</span><span>{{ desktopControl ? '原 Codex 窗口' : sharedControl ? '备用共享窗口' : '本机 Codex' }}</span></div>
      <details v-if="threadId" class="lp-native-context"><summary>上下文 · {{ threadUsage.usage?.remainingContextPercent === null || !threadUsage.usage ? '待原生数据' : `${threadUsage.usage.remainingContextPercent}% 剩余` }}</summary><TokenUsageStatus :usage="threadUsage.usage" :reason="threadUsage.reason" /></details>
      <p v-if="feedback" class="lp-feedback" role="status">{{ feedback }}<button @click="feedback = ''" aria-label="关闭提示">×</button></p>
      <template v-if="threadId">
        <p v-if="historyProgress" class="lp-history-progress" role="status">{{ historyProgress }} <button v-if="loadingAllHistory" @click="cancelHistory">取消读取</button><button v-else-if="historyResume" :disabled="!ready" @click="resumeHistory">继续读取</button></p>
        <p v-if="beginningIndex >= 0" class="lp-history-progress">正在阅读对话开头 <button :disabled="loadingEarlier || beginningIndex === 0" @click="loadLater">读取后续消息</button><button :disabled="!ready" @click="returnLatest">返回最新消息</button></p>
        <ThreadConversation ref="conversation" :messages="messages" :pending-requests="selectedApprovals" :live-overlay="liveOverlay" :is-loading="loadingChat" :active-thread-id="threadId" :cwd="currentCwd" :has-more-persisted-above="Boolean(historyCursor)" :is-loading-persisted-above="loadingEarlier" :load-earlier-messages="loadEarlier" :allow-file-actions="false" @fork-thread="forkThread($event.turnIndex)" @rollback="rollback($event.turnId)" @respond-server-request="respondApproval" @open-file="openFiles(currentCwd,$event)" @retry-history-content="retryContent" />
        <div class="lp-compose-area">
          <p v-if="editingQueue" class="lp-edit-queue">正在修改排队消息 <button @click="cancelQueueEdit">取消</button></p>
          <QueuedMessages :messages="queueRows" :disabled="!canControl || busy" @edit="editQueue" @delete="deleteQueue" @steer="startQueue" @reorder="reorderQueue" />
          <ThreadPendingRequestPanel v-if="selectedApprovals.length" :request="selectedApprovals[0]!" :request-count="selectedApprovals.length" :has-queue-above="queueRows.length > 0" :single-turn-only="true" :is-responding="respondingApproval" @respond-server-request="respondApproval" />
          <p v-if="sendReceipt" class="lp-send-receipt" role="status">{{ receiptLabel }}<button v-if="sendReceipt.state === 'uncertain' || sendReceipt.state === 'sending'" :disabled="!ready || queryingReceipt" @click="queryReceipt">查询发送回执</button><button v-if="sendReceipt.state === 'uncertain'" @click="refreshCurrent">查阅原窗口会话</button><button v-if="sendReceipt.state === 'uncertain'" @click="confirmNotAccepted">确认未执行并恢复草稿</button></p>
          <p v-if="settingsHint" class="lp-settings-hint">{{ settingsHint }}<button @click="inheritSettings">采用原窗口参数</button></p>
          <ThreadComposer v-show="!selectedApprovals.length" :key="`${deviceId}:${threadId}`" ref="composer" :active-thread-id="threadId" :cwd="currentCwd" :models="models" :valid-reasoning-efforts="effortOptions" :skills="skills" :supports-plan-mode="planSupported" :selected-model="selectedModel" :selected-reasoning-effort="selectedEffort" :selected-collaboration-mode="selectedMode" selected-speed-mode="standard" :is-turn-in-progress="Boolean(activeTurn)" :is-interrupting-turn="interrupting" :disabled="!canControl || busy || loadingChat || sendBlocked || changingPermissions" :permission-mode="selectedPermission" :permissions-supported="permissionsSupported" :changing-permissions="changingPermissions" @change-permissions="changePermissions" :has-queue-above="queueRows.length > 0" :send-with-enter="sendWithEnter" :in-progress-submit-mode="inProgressMode" :remote-mode="true" @submit="submit" @interrupt="interrupt" @update:selected-model="chooseSetting('model',$event)" @update:selected-reasoning-effort="chooseSetting('effort',$event)" @update:selected-collaboration-mode="chooseSetting('mode',$event)" />
          <p class="lp-compose-hint">{{ canControl ? '输入与操作同步到电脑上的同一会话' : ready ? '请在电脑的 LanPower 连接原 Codex 窗口后继续此会话' : stateHint }}</p>
        </div>
      </template>
      <div v-else class="lp-welcome"><div>✳</div><h2>继续你的工作</h2><p>选择最近聊天，或在项目中新建聊天。</p><button class="lp-primary" :disabled="!ready" @click="openNewThread()">＋ 新聊天</button><p v-if="!ready">{{ stateHint }}</p></div>
    </main>
    <RemoteFeaturePage v-if="view !== 'chat'" :key="deviceId" :view="view" :ready="ready" :projects="projects" :cwd="currentCwd || projectCwd" :send-with-enter="sendWithEnter" :in-progress-mode="inProgressMode" :quota="nativeState" :context="threadUsage" :capability-paging="capabilityPaging" @refresh-quota="nativeUsage.readQuota()" @back="chatOpen = false" @close="view = 'chat'; chatOpen = true" @use-skill="useSkill" @theme="setTheme" @update:send-with-enter="setSendWithEnter" @update:in-progress-mode="setInProgressMode" />
    <RemoteFilesPanel v-if="filesCwd" :key="`${deviceId}:${filesCwd}:${filePath}`" :cwd="filesCwd" :ready="ready" :initial-path="filePath" @close="filesCwd = ''; filePath = ''" @attach="attachProjectFile" />
    <Teleport to="body"><div v-if="newThreadDialog" class="lp-dialog-overlay" @click.self="newThreadDialog = false"><form class="lp-dialog" role="dialog" aria-modal="true" aria-label="新建聊天" @submit.prevent="createFromDialog"><h2>新建聊天</h2><p>选择已授权的项目目录。</p><ComposerDropdown v-model="projectCwd" :options="projects.filter(p => p.kind !== 'chat').map(p => ({value:p.path,label:p.name}))" placeholder="选择项目" enable-search search-placeholder="搜索项目" /><footer><button type="button" @click="newThreadDialog = false">取消</button><button class="lp-primary" :disabled="!projectCwd || busy">创建聊天</button></footer></form></div><div v-if="renameDialog" class="lp-dialog-overlay" @click.self="renameDialog = false"><form class="lp-dialog" role="dialog" aria-modal="true" aria-label="重命名聊天" @submit.prevent="saveThreadName"><h2>重命名聊天</h2><input v-model="renameDraft" aria-label="聊天名称" autofocus maxlength="1000" /><footer><button type="button" @click="renameDialog = false">取消</button><button class="lp-primary" :disabled="!renameDraft.trim()">保存</button></footer></form></div></Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import ThreadConversation from './components/content/ThreadConversation.vue'
import ThreadComposer, { type ComposerDraftPayload, type SubmitPayload, type ThreadComposerExposed } from './components/content/ThreadComposer.vue'
import QueuedMessages from './components/content/QueuedMessages.vue'
import ThreadPendingRequestPanel from './components/content/ThreadPendingRequestPanel.vue'
import { normalizeThreadMessagesV2 } from './api/normalizers/v2'
import LanPowerThreadTree from './components/sidebar/LanPowerThreadTree.vue'
import ComposerDropdown from './components/content/ComposerDropdown.vue'
import IconTablerLayoutSidebar from './components/icons/IconTablerLayoutSidebar.vue'
import IconTablerFolder from './components/icons/IconTablerFolder.vue'
import RemoteFeaturePage from './components/content/RemoteFeaturePage.vue'
import TokenUsageStatus from './components/content/TokenUsageStatus.vue'
import { NativeUsage } from './lanpower/nativeStatus'
import RemoteFilesPanel from './components/content/RemoteFilesPanel.vue'
import { mergeHistory, readPage, readThread, newBeginning, findBeginning, HistoryContentReader, refreshHistoryTurn, type BeginningJob } from './lanpower/history'
import { newSettings, observeSettings, effectiveSettings, modelId, validEfforts, type ModelCapability, type ThreadSettings, type SendSettings } from './lanpower/settings'
import { permissionMode, permissionLabels, type PermissionPreset } from './lanpower/permissions'
import { StateClock } from './lanpower/state'
import { reasoningSummary, timestampMs } from './lanpower/turnPresentation'
import { defaultLibraryPreferences, type LibraryPreferences } from './lanpower/library'
import { prepareSubmissionInput } from './lanpower/input'
import { resetRemoteImages } from './lanpower/images'
import type { ReasoningEffort, UiServerRequest, UiLiveOverlay } from './types/codex'
import { connection, RemoteError, type RpcEvent } from './lanpower/connection'

const config = JSON.parse(document.getElementById('lanpower-codex-config')?.textContent || '{"devices":[]}')
const devices: Array<{ id: string; name: string }> = config.devices
const deviceId = ref(''), state = ref('idle'), threadId = ref(''), chatOpen = ref(false)
const sidebarCollapsed = ref(false), view = ref('chat'), archivedView = ref(false), chatSupported = ref(false), filesCwd = ref('')
const newThreadDialog = ref(false), renameDialog = ref(false), renameDraft = ref(''), loadingAllHistory = ref(false)
const sendWithEnter = ref(true), inProgressMode = ref<'queue' | 'steer'>('queue'), selectedMode = ref<'default' | 'plan'>('default')
const skills = ref<Array<{name:string;path:string;description:string;scope?:string;enabled?:boolean}>>([])
const conversation = ref<{jumpToStart:()=>Promise<void>;jumpToLatest:()=>void} | null>(null)
const ready = computed(() => state.value === 'runtime_ready')
const nativeState = shallowRef<any>({snapshots:[],loading:false,reason:'连接所选电脑后读取原生额度与用量。'})
const nativeUsage = new NativeUsage(connection, () => ready.value, () => { nativeState.value = {...nativeUsage.state} })
const threadUsage = computed(() => { void nativeState.value; return nativeUsage.context(threadId.value) })
const capabilityPaging = ref(false)
const permissionsSupported = ref(false), permissionUpdates = ref<string[]>([])
const changingPermissions = computed(() => permissionUpdates.value.includes(sessionKey()))
const selectedPermission = computed(() => { settingsVersion.value; return ready.value ? permissionMode(threadSettings().permissions,currentCwd.value) : 'unknown' })
let quotaTimer: ReturnType<typeof setTimeout> | undefined
const threads = shallowRef<any[]>([]), current = shallowRef<any>(null), projects = ref<Array<{ name: string; path: string; kind?:string }>>([])
const libraryCatalog = ref(false), libraryQuery = ref(''), searchRows = shallowRef<any[]>([])
const displayedThreads = computed(() => libraryQuery.value && libraryCatalog.value ? searchRows.value : threads.value)
const projectCwd = ref(''), listCursor = ref(''), historyCursor = ref(''), models = ref<string[]>([])
const selectedModel = ref(''), selectedEffort = ref<ReasoningEffort | ''>('')
const desktopControl = ref(false), sharedControl = ref(false), queueSupported = ref(false)
const targetedHistoryActions = ref(false)
const planSupported = ref(false)
const recovering = ref(false), lastSync = ref(0), syncFailed = ref(false)
const nativeModels = ref<ModelCapability[]>([]), settingsVersion = ref(0), unsupportedMethods = ref<string[]>([])
const clock = new StateClock(), settingsByThread = new Map<string,ThreadSettings>(), drafts = new Map<string,ComposerDraftPayload>(), queueEdits = new Map<string,string>()
type Receipt = {submissionId:string;method:string;payload:SubmitPayload;settings:SendSettings;state:'sending'|'accepted'|'failed'|'uncertain';turnId?:string;message?:string}
const receipts = new Map<string,Receipt>(), receiptVersion = ref(0), queryingReceipt = ref(false), receiptsSupported = ref(false)
const historyProgress = ref(''), historyResume = ref<'beginning'|''>(''), beginningIndex = ref(-1)
let historyAbort: AbortController | null = null, beginningJob: BeginningJob | null = null
const contentState = shallowRef<Record<string,{loaded:number;error:string}>>({})
let contentReader: HistoryContentReader | null = null, contentAbort: AbortController | null = null
let contentRun = 0, restoringContent = false, contentRetry: ReturnType<typeof setTimeout> | undefined, contentRetryDelay = 2000
const contentFailures = new Map<string,number>()
function pauseContent(): void { contentRun++; contentAbort?.abort(); contentAbort = null; restoringContent = false; clearTimeout(contentRetry) }
function resetContent(): void { pauseContent(); contentReader = null; contentState.value = {}; contentRetryDelay = 2000; contentFailures.clear() }
function sessionKey(id = threadId.value): string { return `${deviceId.value}:${id}` }
function threadSettings(): ThreadSettings { const key = sessionKey(); if (!settingsByThread.has(key)) settingsByThread.set(key,newSettings()); return settingsByThread.get(key)! }
function displaySettings(): void { const options = effectiveSettings(threadSettings()); selectedModel.value = options.model; selectedEffort.value = options.effort; selectedMode.value = options.mode; settingsVersion.value++ }
function chooseSetting(key: keyof SendSettings, value: any): void {
  const options = threadSettings(); Object.assign(options.overrides,{[key]:value})
  if (key === 'model') { const model = nativeModels.value.find(m => modelId(m) === value), efforts = validEfforts(model); if (!efforts.includes(effectiveSettings(options).effort as ReasoningEffort)) options.overrides.effort = model?.defaultReasoningEffort || '' }
  displaySettings()
}
function inheritSettings(): void { threadSettings().overrides = {}; displaySettings() }
async function changePermissions(mode:PermissionPreset): Promise<void> {
  if (!canControl.value || !permissionsSupported.value || busy.value || loadingChat.value || sendBlocked.value || changingPermissions.value) return
  const e = epoch, s = selection, id = threadId.value, key = sessionKey()
  permissionUpdates.value = [...permissionUpdates.value,key]
  try {
    const result = await connection.request('lanpower/permissions/set',{threadId:id,permissionMode:mode})
    if (e !== epoch || s !== selection) return
    applyThreadSettings(result.thread)
    feedback.value = selectedPermission.value === mode
      ? `已切换为${permissionLabels[mode]}${activeTurn.value ? '，用于后续任务；当前任务和已发起的审批保留原设置。' : '。'}`
      : '已读取原窗口的实际权限；当前配置与所选模式不同，请核对电脑端的权限限制。'
    scheduleReconcile()
  } catch (error) {
    if (e === epoch && s === selection) {
      feedback.value = `权限更改未确认：${error instanceof Error ? error.message : '请重新连接后读取实际状态'}。`
      scheduleReconcile()
    }
  } finally { permissionUpdates.value = permissionUpdates.value.filter(item => item !== key) }
}
const effortOptions = computed(() => validEfforts(nativeModels.value.find(m => modelId(m) === selectedModel.value)))
const settingsHint = computed(() => { settingsVersion.value; const settings = threadSettings(); return Object.keys(settings.overrides).length ? `下次新任务使用已选参数；原窗口：${settings.native.model || '默认模型'} / ${settings.native.effort || '默认强度'} / ${settings.native.mode === 'plan' ? '计划模式' : '默认模式'}。排队和引导沿用当前任务参数。` : '' })
const sendReceipt = computed(() => { receiptVersion.value; return receipts.get(sessionKey()) })
const sendBlocked = computed(() => { receiptVersion.value; return ['sending','uncertain'].includes(sendReceipt.value?.state || '') })
const receiptLabel = computed(() => { receiptVersion.value; return {sending:'发送中，正在等待电脑回执。',accepted:'原窗口已接受。',failed:'发送失败，输入已恢复。',uncertain:'发送结果待确认，请先查询回执或查阅原窗口；禁止直接重复发送。'}[sendReceipt.value?.state || 'accepted'] })
const taskLabel = computed(() => !ready.value ? '任务状态待恢复' : selectedApprovals.value.length ? '等待审批或回复' : activeTurn.value ? '正在工作' : '当前无运行任务')
const syncLabel = computed(() => !threadId.value ? '' : !ready.value ? `历史缓存${lastSync.value ? ' · 上次同步 ' + new Date(lastSync.value).toLocaleTimeString('zh-CN') : ''}` : recovering.value || loadingChat.value ? '正在恢复原窗口状态' : syncFailed.value ? '最近同步失败 · 显示历史缓存' : lastSync.value ? '最近同步 ' + new Date(lastSync.value).toLocaleTimeString('zh-CN') : '尚未同步')
function saveDraft(): void { if (threadId.value && composer.value) { const key = sessionKey(); drafts.set(key,composer.value.getDraft()); if (editingQueue.value) queueEdits.set(key,editingQueue.value); else queueEdits.delete(key) } }
async function hydrateSavedDraft(): Promise<void> { const key = sessionKey(), s = selection; await nextTick(); if (key === sessionKey() && s === selection) { editingQueue.value = queueEdits.get(key) || ''; composer.value?.hydrateDraft(drafts.get(key) || {text:'',imageUrls:[],skills:[],fileAttachments:[]}) } }
function resetHistory(): void { historyAbort?.abort(); historyAbort = null; historyProgress.value = ''; historyResume.value = ''; loadingAllHistory.value = false; beginningIndex.value = -1; beginningJob = null; resetContent() }
const activeTurns = ref<Record<string, string>>({}), approvals = ref<UiServerRequest[]>([])
const queue = ref<any[]>([]), editingQueue = ref(''), composer = ref<ThreadComposerExposed | null>(null)
const loadingChat = ref(false), loadingLibrary = ref(false), loadingEarlier = ref(false), busy = ref(false), interrupting = ref(false)
const feedback = ref(''), powerText = ref(''), wakeAvailable = ref(false), waking = ref(false)
const respondingApproval = ref(false)
const libraryState = ref({revision:0, preferences:defaultLibraryPreferences()}), filePath = ref('')
let libraryDraft: LibraryPreferences | null = null, librarySaving = false, libraryTimer: ReturnType<typeof setTimeout>, reconcileTimer: ReturnType<typeof setTimeout>
const overlay = ref<UiLiveOverlay>({ activityLabel: '', activityDetails: [], reasoningText: '', errorText: '' })
const turnTimings = new Map<string, {startedAt:number;completedAt?:number}>()
function timingKey(id:string, turnId:string): string { return `${deviceId.value}:${id}:${turnId}` }
function rememberTiming(id:string, turn:any, started:boolean): void {
  if (!id || !turn?.id) return
  const key = timingKey(id,turn.id), previous = turnTimings.get(key)
  const start = timestampMs(turn.startedAt) ?? previous?.startedAt ?? (started ? Date.now() : undefined)
  if (start === undefined) return
  turnTimings.set(key,{startedAt:start,...(!started ? {completedAt:timestampMs(turn.completedAt) ?? Date.now()} : {})})
  if (turnTimings.size > 128) turnTimings.delete(turnTimings.keys().next().value!)
}
let epoch = 0, selection = 0, approvalSequence = 0, streamFrame = 0, syncing = false, polling: ReturnType<typeof setInterval>
const remoteApprovalIds = new Map<number, string | number>()
const approvalKeys = new Map<string, number>()
const labels: Record<string, string[]> = {
  idle: ['请选择电脑', '选择电脑后读取原窗口的项目和会话。'], connecting: ['连接中', '正在连接开发电脑…'],
  cloud_offline: ['电脑未连接', '电脑上线并登录 Windows 后会自动连接。'], host_offline: ['等待电脑登录', '登录 Windows 后后台自动启动，正在等待恢复。'],
  disabled: ['尚未授权', '请在电脑的 LanPower 启用 Codex Remote 并保存授权。'], host_ready: ['正在读取 Codex', '正在连接电脑上的 Codex。'],
  runtime_starting: ['正在读取 Codex', '正在读取原窗口的项目与最近会话。'], runtime_ready: ['已连接', ''],
  runtime_error: ['Codex 未就绪', '请确认 Codex 已打开并登录，后台会自动重新连接；首次使用请在 LanPower 连接原窗口。'],
  disconnected: ['连接已断开', '正在重连；电脑上的任务会继续运行。'], update_required: ['需要更新 Cloud', '请更新至 1.16.2，以支持多个页面同时连接。'],
  revoked: ['开发授权已变化','请重新检查登录与开发权限后重连。'],
}
const stateLabel = computed(() => labels[state.value]?.[0] || '连接未就绪')
const stateHint = computed(() => labels[state.value]?.[1] || '请检查电脑上的连接状态。')
const activeTurn = computed(() => activeTurns.value[threadId.value] || '')
const canControl = computed(() => ready.value && !recovering.value && Boolean(threadId.value) && current.value?.id === threadId.value && (sharedControl.value || current.value?.control === 'remote'))
const currentTitle = computed(() => current.value?.name || current.value?.preview?.slice(0, 60) || (threadId.value ? '新会话' : 'Codex Remote'))
const currentCwd = computed(() => current.value?.cwd || '')
const messages = computed(() => current.value ? normalizeThreadMessagesV2({ thread: {...current.value,turns:(current.value.turns || []).map((turn:any) => {
  const timing = turnTimings.get(timingKey(current.value.id,turn.id))
  return {...turn,...(timing ? {startedAt:turn.startedAt ?? timing.startedAt,completedAt:turn.completedAt ?? timing.completedAt} : {}),
    items:(turn.items || []).map((item:any) => item.type === 'lanpowerLargeItem' ? {...item,
      historyLoaded:contentState.value[item.reference]?.loaded || 0,historyError:contentState.value[item.reference]?.error || ''} : item)}
})} } as any) : [])
const selectedApprovals = computed(() => approvals.value.filter(a => a.threadId === threadId.value))
const liveOverlay = computed<UiLiveOverlay | null>(() => {
  if (!ready.value) return null
  if (!activeTurn.value) return overlay.value.errorText ? {...overlay.value,running:false} : null
  const turn = current.value?.turns?.find((t:any) => t.id === activeTurn.value)
  const items:any[] = turn?.items || []
  const runningCommand = items.some(item => item.type === 'commandExecution' && item.status === 'inProgress')
  const summary = reasoningSummary(items.slice().reverse().find(item => item.type === 'reasoning') || {})
  return {...overlay.value,running:!selectedApprovals.value.length && !interrupting.value,
    activityLabel:selectedApprovals.value.length ? '等待你的回复' : interrupting.value ? '正在停止' : runningCommand ? 'Running command' : overlay.value.activityLabel || 'Thinking',
    reasoningText:overlay.value.reasoningText || summary,
    startedAtMs:timestampMs(turn?.startedAt) ?? timestampMs(current.value?.live?.startedAt) ?? turnTimings.get(timingKey(threadId.value,activeTurn.value))?.startedAt}
})
const queueRows = computed(() => queue.value.map(entry => ({ id: entry.id, text: (entry.input || []).filter((i: any) => i.type === 'text').map((i: any) => i.text).join('\n'), imageUrls: (entry.input || []).filter((i: any) => i.type === 'image').map((i: any) => i.url) })))
function projectName(path: string): string { return projects.value.find(p => p.path === path)?.name || path.replace(/\\/g, '/').replace(/\/$/, '').split('/').pop() || '项目' }
function dateLabel(value: string): string { return new Date(value).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) }
function showError(error: unknown): void { feedback.value = error instanceof Error ? error.message : '请求未完成，请刷新会话确认。' }
function resetApprovals(): void { approvals.value = []; remoteApprovalIds.clear(); approvalKeys.clear(); respondingApproval.value = false }
function addApproval(event: RpcEvent): void {
  if (event.id === undefined) return
  const key = JSON.stringify(event.id)
  let id = approvalKeys.get(key)
  if (!id) { id = ++approvalSequence; approvalKeys.set(key, id); remoteApprovalIds.set(id, event.id) }
  const p = event.params || {}
  const value: UiServerRequest = { id, method: event.method, params: p, threadId: p.threadId || '', turnId: p.turnId || '', itemId: p.itemId || '', receivedAtIso: new Date().toISOString() }
  approvals.value = [...approvals.value.filter(a => a.id !== id), value]
}
function onState(value: string): void {
  const wasReady = ready.value; state.value = value
  if (!ready.value) { clearTimeout(quotaTimer); nativeUsage.reset('电脑连接未就绪，无法取得当前额度与上下文。') }
  else if (!wasReady) void nativeUsage.readQuota()
  if (!ready.value) { epoch++; busy.value = false; syncing = false; recovering.value = false; loadingLibrary.value = false; loadingChat.value = false; loadingEarlier.value = false; interrupting.value = false; historyAbort?.abort(); libraryDraft = null; resetRemoteImages(); resetApprovals(); queue.value = []; overlay.value = { activityLabel: '', activityDetails: [], reasoningText: '', errorText: '' }; clock.clear() }
  else if (!wasReady) void restore()
}
async function restore(): Promise<void> {
  const e = epoch, stamp = clock.capture(); recovering.value = true
  try {
    const [status, modelList, modes] = await Promise.all([connection.request('lanpower/status'), connection.request('model/list', { limit: 50 }), connection.request('collaborationMode/list').catch(() => ({data:[]}))])
    if (e !== epoch || !ready.value) return
    applyStatus(status,stamp)
    planSupported.value = (modes.data || []).some((mode:any) => mode.mode === 'plan')
    const allModels = [...(modelList.data || [])]; let modelCursor = modelList.nextCursor
    const cursors = new Set<string>()
    while (modelCursor && e === epoch) { if (cursors.has(modelCursor)) throw new Error('模型列表游标未推进。'); cursors.add(modelCursor); const page = await connection.request('model/list',{limit:50,cursor:modelCursor}); allModels.push(...(page.data || [])); modelCursor = page.nextCursor }
    if (e !== epoch) return
    nativeModels.value = allModels; models.value = [...new Set<string>(allModels.map(modelId).filter(Boolean))]
    if (!threadId.value) selectedModel.value = modelId(allModels.find((m:any) => m.isDefault) || allModels[0] || {})
    await loadThreads()
    if (threadId.value) { if (current.value?.id === threadId.value) await refreshCurrent(); else await selectThread(threadId.value, true) }
    if (e === epoch && threadId.value) await queryReceipt()
  } catch (error) { if (e === epoch) showError(error) }
  finally { if (e === epoch) recovering.value = false }
}
function applyStatus(status: any, stamp = clock.capture()): void {
  capabilityPaging.value = status.capabilityPaging === true
  permissionsSupported.value = status.permissionsControl === true
  desktopControl.value = Boolean(status.desktopControl); sharedControl.value = Boolean(status.sharedControl); queueSupported.value = Boolean(status.queueSupported)
  receiptsSupported.value = Boolean(status.submissionReceipts); unsupportedMethods.value = status.unsupportedMethods || []
  targetedHistoryActions.value = Boolean(status.targetedHistoryActions)
  libraryCatalog.value = Boolean(status.libraryCatalog)
  chatSupported.value = Boolean(status.chatSupported)
  if (status.library && !librarySaving && !libraryDraft) libraryState.value = status.library
  projects.value = status.projects || []; if (!projects.value.some(p => p.path === projectCwd.value)) projectCwd.value = projects.value[0]?.path || ''
  if (!clock.unchanged(stamp)) { scheduleReconcile(); return }
  const active: Record<string,string> = Object.fromEntries((status.activeTurns || []).map((t: any) => [t.threadId, t.turnId]))
  const next = {...activeTurns.value}
  for (const id of new Set([...Object.keys(next),...Object.keys(active)])) if (clock.snapshot(id,status.lanpowerRevision)) { if (active[id]) next[id] = active[id]!; else delete next[id] }
  activeTurns.value = next
  // Reconcile requests; a desktop reply can have arrived while the browser was disconnected.
  const incoming = new Set((status.pendingApprovals || []).map((request: RpcEvent) => JSON.stringify(request.id)))
  for (const [key, localId] of approvalKeys) if (!incoming.has(key)) { approvalKeys.delete(key); remoteApprovalIds.delete(localId) }
  approvals.value = approvals.value.filter(a => remoteApprovalIds.has(a.id))
  if (!approvals.value.length) respondingApproval.value = false
  for (const request of status.pendingApprovals || []) addApproval(request)
  connection.reconcileApprovals((status.pendingApprovals || []).map((r:RpcEvent) => r.id))
}
async function loadThreads(more = false): Promise<void> {
  if (!ready.value || loadingLibrary.value) return
  const e = epoch, query = libraryQuery.value, archived = archivedView.value; loadingLibrary.value = true
  try {
    const result = await connection.request(libraryCatalog.value ? 'lanpower/library/list' : 'thread/list', { limit:50,archived,
      ...(libraryCatalog.value ? {refresh:!more,...(query ? {query} : {})} : {}),...(more && listCursor.value ? {cursor:listCursor.value} : {}) })
    if (e !== epoch || query !== libraryQuery.value || archived !== archivedView.value) return
    if (query && libraryCatalog.value) searchRows.value = [...new Map([...(more ? searchRows.value : []),...(result.data || []),...(result.pinned || [])].map((t:any) => [t.id,t])).values()]
    else {
      const previous = threads.value, checked:any[] = []
      if (!more && libraryCatalog.value) {
        for (let offset = 0; offset < previous.length; offset += 256) {
          const check = await connection.request('lanpower/library/check',{threadIds:previous.slice(offset,offset + 256).map(t => t.id),archived})
          if (e !== epoch || query !== libraryQuery.value || archived !== archivedView.value) return
          checked.push(...(check.data || []))
        }
      }
      threads.value = [...new Map([...(more || !libraryCatalog.value ? previous : checked),...(result.data || []),...(result.pinned || [])].map((t:any) => [t.id,t])).values()]
    }
    listCursor.value = result.nextCursor || ''
  } catch (error) { if (e === epoch) { showError(error); if (more && error instanceof RemoteError && error.code === 'library_cursor_changed') { listCursor.value = ''; queueMicrotask(() => void loadThreads()) } } }
  finally { if (e === epoch) { loadingLibrary.value = false; if (query !== libraryQuery.value) void loadThreads() } }
}
function searchLibrary(query: string): void { libraryQuery.value = query; searchRows.value = []; listCursor.value = ''; if (!libraryCatalog.value && query) feedback.value = '当前电脑版本仅能搜索已加载聊天，请更新后使用完整聊天库。'; void loadThreads() }
async function selectThread(id: string, restoring = false): Promise<void> {
  if (!ready.value) return
  if (id === threadId.value && current.value && !restoring) { chatOpen.value = true; await refreshCurrent(); return }
  saveDraft(); resetHistory()
  const e = epoch, s = ++selection
  const stamp = clock.capture(id)
  loadingEarlier.value = false; loadingAllHistory.value = false; syncing = false
  busy.value = false; lastSync.value = 0; syncFailed.value = false
  threadId.value = id; chatOpen.value = true; loadingChat.value = true; current.value = null; queue.value = []; editingQueue.value = ''; historyCursor.value = ''
  overlay.value = { activityLabel: '', activityDetails: [], reasoningText: '', errorText: '' }
  try {
    const result = await readThread(connection,id)
    if (e !== epoch || s !== selection) return
    current.value = result.thread; historyCursor.value = result.thread.historyCursor || ''
    const {turns:_turns,...summary} = result.thread
    threads.value = [...new Map([...threads.value,summary].map(t => [t.id,t])).values()]
    if (clock.unchanged(stamp,id) && clock.snapshot(id,result.thread.lanpowerRevision)) { applyThreadSettings(result.thread); observeTurn(result.thread); lastSync.value = Date.now() }
    else scheduleReconcile()
    displaySettings(); await hydrateSavedDraft()
    syncUrl(); void loadSkills(result.thread.cwd, e, s)
    await refreshQueue(id, e, s)
    const statusStamp = clock.capture(), status = await connection.request('lanpower/status')
    if (e === epoch && s === selection) { applyStatus(status,statusStamp); await queryReceipt() }
  } catch (error) { if (e === epoch && s === selection) showError(error) } finally { if (s === selection) loadingChat.value = false }
}
function observeTurn(thread: any): void {
  const turn = (thread.turns || []).findLast((t: any) => t.status === 'inProgress')
  const next = { ...activeTurns.value }
  if (turn) next[thread.id] = turn.id; else if (thread.status?.type !== 'active') delete next[thread.id]
  activeTurns.value = next
}
function applyThreadSettings(thread: any): void {
  if (thread.id !== threadId.value) return
  observeSettings(threadSettings(),thread,modelId(nativeModels.value.find(m => m.isDefault) || nativeModels.value[0] || {})); displaySettings()
}
async function loadEarlier(id: string): Promise<void> {
  if (id !== threadId.value || !historyCursor.value || loadingEarlier.value || !ready.value) return
  const e = epoch, s = selection; loadingEarlier.value = true
  try {
    const result = await readPage(connection,id,historyCursor.value)
    if (e !== epoch || s !== selection || !current.value) return
    const existing = new Set(current.value.turns.map((t: any) => t.id))
    const older = result.data.slice().reverse().filter((t: any) => !existing.has(t.id))
    current.value = { ...current.value, turns: [...older, ...current.value.turns] }
    if (result.nextCursor && result.nextCursor === historyCursor.value) throw new Error('历史游标未推进，请刷新会话。')
    historyCursor.value = result.nextCursor || ''
  } catch (error) { if (e === epoch && s === selection) showError(error) } finally { if (e === epoch && s === selection) loadingEarlier.value = false }
}
async function refreshQueue(id = threadId.value, e = epoch, s = selection): Promise<void> {
  if (!queueSupported.value || !id) return
  const stamp = clock.capture(id), all: any[] = [], cursors = new Set<string>(); let cursor = ''
  try {
    do { const result = await connection.request('thread/queue/list',{threadId:id,limit:32,...(cursor ? {cursor} : {})}); if (e !== epoch || s !== selection) return; all.push(...(result.data || [])); cursor = result.nextCursor || ''; if (cursor && cursors.has(cursor)) throw new Error('队列游标未推进。'); cursors.add(cursor) } while (cursor)
    if (e === epoch && s === selection && id === threadId.value && clock.unchanged(stamp,id)) queue.value = [...new Map(all.map(entry => [entry.id,entry])).values()]
  } catch (error) { if (error instanceof RemoteError && error.code === 'unsupported_method') queueSupported.value = false; throw error }
}
async function refreshCurrent(): Promise<void> {
  if (!ready.value || !threadId.value || loadingChat.value || loadingEarlier.value || loadingAllHistory.value || busy.value || syncing) return
  if (beginningIndex.value >= 0) return
  const e = epoch, s = selection, id = threadId.value, stamp = clock.capture(id), statusStamp = clock.capture(); syncing = true
  try {
    const [result, status] = await Promise.all([readThread(connection,id), connection.request('lanpower/status')])
    if (e !== epoch || s !== selection) return
    let latest = result.thread.turns || [], cursor = result.thread.historyCursor || ''
    const previous = current.value?.turns || [], oldIds = new Set(previous.map((t: any) => t.id))
    // If many turns finished while disconnected, bridge the gap before merging.
    while (previous.length && latest.length && !latest.some((t: any) => oldIds.has(t.id)) && cursor) {
      const page = await readPage(connection,id,cursor)
      if (e !== epoch || s !== selection) return
      const next = page.nextCursor || ''; if (next && next === cursor) throw new Error('历史游标未推进，请刷新会话。')
      latest = [...(page.data || []).slice().reverse(), ...latest]; cursor = next
    }
    applyStatus(status,statusStamp)
    if (!clock.unchanged(stamp,id) || !clock.snapshot(id,result.thread.lanpowerRevision)) { scheduleReconcile(); return }
    if (!previous.length || previous[0]?.id === latest[0]?.id || latest.some((t: any) => t.id === previous[0]?.id)) historyCursor.value = cursor
    current.value = { ...result.thread, turns: mergeHistory(current.value?.turns || [], latest) }; observeTurn(current.value)
    applyThreadSettings(result.thread)
    lastSync.value = Date.now(); syncFailed.value = false
    await refreshQueue(id, e, s)
  } catch (error) { if (e === epoch && s === selection) { syncFailed.value = true; showError(error) } } finally { if (e === epoch && s === selection) syncing = false }
}
async function newThread(cwd?: string): Promise<void> {
  if (!cwd || !ready.value || busy.value) return
  busy.value = true
  try { const result = await connection.request('thread/start', { cwd, ...(selectedModel.value ? { model: selectedModel.value } : {}) }); busy.value = false; await loadThreads(); await selectThread(result.thread.id) }
  catch (error) { showError(error) } finally { busy.value = false }
}
async function submit(payload: SubmitPayload): Promise<void> {
  if (!canControl.value || busy.value || sendBlocked.value || changingPermissions.value) return
  const e = epoch, s = selection, id = threadId.value, key = sessionKey(), options = {...effectiveSettings(threadSettings())}
  const receipt: Receipt = {submissionId:crypto.randomUUID(),method:'',payload:JSON.parse(JSON.stringify(payload)),settings:options,state:'sending'}
  receipts.set(key,receipt); receiptVersion.value++
  busy.value = true; feedback.value = ''
  try {
    if (editingQueue.value && !queue.value.some(row => row.id === editingQueue.value)) throw new RemoteError('not_sent','排队消息已被处理或删除，请取消编辑后重新输入。')
    if (!activeTurn.value && !editingQueue.value) {
      if (options.effort && nativeModels.value.find(m => modelId(m) === options.model)?.supportedReasoningEfforts && !effortOptions.value.includes(options.effort)) throw new RemoteError('not_sent','所选模型不支持该思考强度，请重新选择。')
      if (options.mode === 'plan' && !planSupported.value) throw new RemoteError('not_sent','原窗口暂不支持计划模式，请采用原窗口参数。')
    }
    const input = prepareSubmissionInput(payload)
    let params: any = {threadId:id,input,...(receiptsSupported.value ? {submissionId:receipt.submissionId} : {})}
    if (editingQueue.value) { receipt.method = 'thread/queue/update'; params.queuedSubmissionId = editingQueue.value }
    else if (activeTurn.value && payload.mode === 'queue') { receipt.method = 'thread/queue/add'; params.clientUserMessageId = receipt.submissionId }
    else if (activeTurn.value) { receipt.method = 'turn/steer'; params.expectedTurnId = activeTurn.value }
    else { receipt.method = 'turn/start'; params = {...params,...(sharedControl.value ? {mode:options.mode} : {}),...(options.model ? {model:options.model} : {}),...(options.effort ? {effort:options.effort} : {})} }
    const result = await connection.request(receipt.method,params)
    receipt.state = result.receipt?.state === 'uncertain' || result.receipt?.state === 'sending' ? 'uncertain' : result.receipt?.state === 'failed' ? 'failed' : 'accepted'
    receipt.turnId = result.receipt?.turnId || result.turn?.id || result.turnId
    receiptVersion.value++
    if (receipt.state !== 'accepted') throw new RemoteError(receipt.state === 'failed' ? 'submission_failed' : 'submission_uncertain','此提交已有记录，请查询回执确认结果。',receipt.state !== 'failed')
    drafts.delete(key); queueEdits.delete(key)
    if (e === epoch && s === selection && receipt.method === 'turn/start') {
      threadSettings().overrides = {}; threadSettings().native = options; displaySettings()
      if (result.turn?.id) { rememberTiming(id,result.turn,true); overlay.value = {activityLabel:'Thinking',activityDetails:[],reasoningText:'',errorText:''}; activeTurns.value = { ...activeTurns.value, [id]: result.turn.id } }
    }
    if (e === epoch && s === selection) { editingQueue.value = ''; await refreshQueue(id, e, s) }
  } catch (error) {
    if (receipt.state !== 'accepted') {
      receipt.state = error instanceof RemoteError && !error.uncertain ? 'failed' : 'uncertain'; receiptVersion.value++
      if (receipt.state === 'failed') { drafts.set(key,payload); if (key === sessionKey()) await hydrateSavedDraft() }
    }
    if (key === sessionKey()) showError(error)
  }
  finally { if (e === epoch && s === selection) { busy.value = false; scheduleReconcile() } }
}
async function queryReceipt(): Promise<void> {
  const receipt = sendReceipt.value, key = sessionKey(), e = epoch
  if (!receipt || !ready.value || receipt.state === 'accepted' || receipt.state === 'failed' || queryingReceipt.value || !receiptsSupported.value) return
  queryingReceipt.value = true
  try {
    const result = await connection.request('lanpower/submission/read',{threadId:threadId.value,submissionId:receipt.submissionId})
    if (e !== epoch || key !== sessionKey()) return
    receipt.state = result.state === 'accepted' ? 'accepted' : result.state === 'failed' ? 'failed' : 'uncertain'; receipt.turnId = result.turnId; receiptVersion.value++
    if (receipt.state === 'accepted') { drafts.delete(key); queueEdits.delete(key); editingQueue.value = ''; feedback.value = '已查证：原窗口已接受，请勿重复发送。' }
    if (receipt.state === 'failed') { drafts.set(key,receipt.payload); await hydrateSavedDraft(); feedback.value = '原窗口明确拒绝了提交，草稿已恢复，可以修改后重试。' }
    if (receipt.state === 'uncertain') feedback.value = '电脑端尚不能确认提交结果，请查阅原窗口；确认未执行后才能恢复输入。'
  } catch (error) { if (key === sessionKey()) showError(error) }
  finally { queryingReceipt.value = false }
}
async function confirmNotAccepted(): Promise<void> {
  const receipt = sendReceipt.value
  if (!receipt || receipt.state !== 'uncertain' || !confirm('请先检查原窗口的消息、任务与队列。确认这条消息未执行，才恢复草稿；再次发送会生成新提交。已确认未执行吗？')) return
  receipt.state = 'failed'; receiptVersion.value++; drafts.set(sessionKey(),receipt.payload); await hydrateSavedDraft()
}
async function interrupt(): Promise<void> {
  if (!activeTurn.value || interrupting.value || !canControl.value) return
  const id = threadId.value, turnId = activeTurn.value, e = epoch, s = selection
  if (unsupportedMethods.value.includes('turn/interrupt')) { feedback.value = '原窗口版本暂不支持停止任务，请在电脑处理。'; return }
  interrupting.value = true
  try { await connection.request('turn/interrupt', { threadId:id,turnId }); if (e === epoch && s === selection) await refreshCurrent() } catch (error) { if (e === epoch && s === selection) { showError(error); scheduleReconcile() } } finally { if (e === epoch && s === selection) interrupting.value = false }
}
function editQueue(id: string): void {
  const row = queueRows.value.find(q => q.id === id)
  if (!row || busy.value || !canControl.value) return
  if (composer.value?.hasUnsavedDraft() && !confirm('用排队消息替换当前未发送的草稿？')) return
  editingQueue.value = id; queueEdits.set(sessionKey(),id); composer.value?.hydrateDraft({ text: row.text, imageUrls: row.imageUrls, skills: [], fileAttachments: [] })
}
function cancelQueueEdit(): void { editingQueue.value = ''; queueEdits.delete(sessionKey()); drafts.delete(sessionKey()); composer.value?.hydrateDraft({ text: '', imageUrls: [], skills: [], fileAttachments: [] }) }
async function queueAction(method: string, params: any): Promise<void> {
  if (busy.value || !canControl.value) return
  const e = epoch, s = selection, id = threadId.value; busy.value = true
  try { await connection.request(method, { threadId:id, ...params }); await refreshQueue(id, e, s) } catch (error) { if (e === epoch && s === selection) { showError(error); scheduleReconcile() } } finally { if (e === epoch && s === selection) busy.value = false }
}
async function deleteQueue(id: string): Promise<void> { await queueAction('thread/queue/delete', { queuedSubmissionId: id }); if (editingQueue.value === id && !queue.value.some(q => q.id === id)) cancelQueueEdit() }
async function startQueue(id: string): Promise<void> { await queueAction('thread/queue/start', { queuedSubmissionId: id }) }
async function reorderQueue({ draggedId, targetId }: { draggedId: string; targetId: string }): Promise<void> {
  const ids = queue.value.map(q => q.id), from = ids.indexOf(draggedId), to = ids.indexOf(targetId)
  if (from < 0 || to < 0) return
  ids.splice(from, 1); ids.splice(to, 0, draggedId)
  await queueAction('thread/queue/reorder', { queuedSubmissionIds: ids })
}
async function respondApproval(reply: { id: number; result?: unknown; error?: unknown; followUpMessageText?: string }): Promise<void> {
  const remoteId = remoteApprovalIds.get(reply.id)
  const request = selectedApprovals.value.find(r => r.id === reply.id), e = epoch, s = selection
  if (respondingApproval.value) return
  if (remoteId === undefined || !canControl.value || !request || request.turnId && request.turnId !== activeTurn.value) { feedback.value = '审批或任务已变化，请恢复会话后重新处理。'; scheduleReconcile(); return }
  respondingApproval.value = true
  try {
    if (reply.error) throw new Error('请在原窗口取消此请求。')
    await connection.decide(remoteId, reply.result)
    if (e !== epoch || s !== selection) return
    if (reply.followUpMessageText) await submit({text:reply.followUpMessageText,imageUrls:[],skills:[],fileAttachments:[],mode:'queue'})
    await refreshCurrent()
  } catch (error) { if (e === epoch && s === selection) { showError(error); scheduleReconcile() } }
  finally { if (e === epoch && s === selection) respondingApproval.value = false }
}
async function renameThread(): Promise<void> {
  if (!canControl.value) return; renameDraft.value = currentTitle.value; renameDialog.value = true
}
async function saveThreadName(): Promise<void> {
  const name = renameDraft.value.trim(); if (!name || !canControl.value) return
  try { await connection.request('thread/name/set', { threadId: threadId.value, name }); renameDialog.value = false; await refreshCurrent(); await loadThreads() } catch (error) { showError(error) }
}
async function forkThread(turnIndex?: number): Promise<void> {
  if (!canControl.value || busy.value) return
  const id = threadId.value, turnId = typeof turnIndex === 'number' ? current.value?.turns[turnIndex]?.id : undefined
  if (typeof turnIndex === 'number' && (!turnId || !targetedHistoryActions.value || !current.value?.historyTailTurnId)) { feedback.value = '请更新电脑端与 Cloud 后，再按指定历史轮次分支。'; return }
  const e = epoch, s = selection
  busy.value = true
  try {
    const result = turnId ? await connection.request('lanpower/history/action',{threadId:id,turnId,expectedTailTurnId:current.value.historyTailTurnId,action:'fork'}) : await connection.request('thread/fork', { threadId:id })
    if (e !== epoch || s !== selection) return
    busy.value = false; await loadThreads(); await selectThread(result.thread.id)
  } catch (error) { showError(error) } finally { busy.value = false }
}
async function rollback(turnId: string): Promise<void> {
  if (!canControl.value || activeTurn.value || busy.value) return
  if (!targetedHistoryActions.value || !current.value?.historyTailTurnId) { feedback.value = '请更新电脑端与 Cloud 后，再按指定历史轮次回退。'; return }
  const index = current.value.turns.findIndex((t: any) => t.id === turnId)
  if (index < 0 || !confirm('移除这轮及后续对话？已修改的文件会保留。')) return
  busy.value = true
  const id = threadId.value, e = epoch, s = selection
  try { const result = await connection.request('lanpower/history/action', { threadId:id,turnId,expectedTailTurnId:current.value.historyTailTurnId,action:'rollback' }); if (e !== epoch || s !== selection) return; resetHistory(); current.value = result.thread; historyCursor.value = result.thread.historyCursor || ''; feedback.value = '对话已回退，已有文件修改保留。' } catch (error) { if (e === epoch && s === selection) showError(error) } finally { if (e === epoch && s === selection) busy.value = false }
}
async function archiveThread(): Promise<void> {
  if (!canControl.value || activeTurn.value || !confirm('归档当前会话？')) return
  try { await connection.request('thread/archive', { threadId: threadId.value }); threads.value = threads.value.filter(t => t.id !== threadId.value); threadId.value = ''; current.value = null; chatOpen.value = false; syncUrl(); await loadThreads() } catch (error) { showError(error) }
}
function cancelHistory(): void { historyAbort?.abort() }
function historyError(error: unknown): void { historyProgress.value = error instanceof DOMException && error.name === 'AbortError' ? '读取已取消，可继续。' : `读取中断，可继续：${error instanceof Error ? error.message : '连接未完成'}` }
function resumeHistory(): void { if (historyResume.value === 'beginning') void jumpToBeginning() }
function retryContent(reference?: string, automatic = false): void {
  clearTimeout(contentRetry)
  if (!automatic) contentFailures.clear()
  const next = {...contentState.value}
  for (const turn of current.value?.turns || []) for (const item of turn.items || []) {
    if (item.type !== 'lanpowerLargeItem' || reference && item.reference !== reference || (contentFailures.get(`${turn.id}:${item.id}`) || 0) >= 3) continue
    if (next[item.reference]) next[item.reference] = {...next[item.reference]!,error:''}
  }
  contentState.value = next; void restoreContent()
}
async function restoreContent(): Promise<void> {
  if (!ready.value || !current.value || current.value.id !== threadId.value || restoringContent || loadingAllHistory.value) return
  const run = contentRun, id = threadId.value, s = selection
  contentReader ||= new HistoryContentReader(id)
  const reader = contentReader, controller = contentAbort ||= new AbortController()
  const valid = () => run === contentRun && s === selection && ready.value && current.value?.id === id
  restoringContent = true
  try {
    while (valid()) {
      const restored = reader.apply(current.value.turns || [])
      if (restored !== current.value.turns) current.value = {...current.value,turns:restored}
      reader.prune(restored)
      const pending = restored.flatMap((turn:any) => (turn.items || []).filter((item:any) =>
        item.type === 'lanpowerLargeItem' && !contentState.value[item.reference]?.error).map((item:any) => ({turnId:turn.id,item})))
      // Restore visible replies and pictures before long command output.
      pending.sort((a:any,b:any) => Number(b.item.wholeTurn || ['agentMessage','userMessage','imageGeneration','image_generation'].includes(b.item.originalType))
        - Number(a.item.wholeTurn || ['agentMessage','userMessage','imageGeneration','image_generation'].includes(a.item.originalType)))
      const target = pending[0]; if (!target) break
      const {item,turnId} = target
      const failureKey = `${turnId}:${item.id}`
      try {
        await reader.read(connection,item,controller.signal,loaded => {
          if (valid()) contentState.value = {...contentState.value,[item.reference]:{loaded,error:''}}
        })
        contentRetryDelay = 2000
        contentFailures.delete(failureKey)
      } catch (error) {
        if (!valid() || controller.signal.aborted) return
        const failures = (contentFailures.get(failureKey) || 0) + 1; contentFailures.set(failureKey,failures)
        if (failures < 3 && error instanceof RemoteError && ['history_reference_expired','history_reference_changed'].includes(error.code)) {
          reader.forget(item.reference)
          try {
            const turn = await refreshHistoryTurn(connection,id,turnId,controller.signal)
            if (!valid()) return
            current.value = {...current.value,turns:current.value.turns.map((value:any) => value.id === turnId ? turn : value)}
            continue
          } catch { if (!valid() || controller.signal.aborted) return }
        } else if (!(error instanceof RemoteError)) reader.forget(item.reference)
        contentState.value = {...contentState.value,[item.reference]:{loaded:contentState.value[item.reference]?.loaded || 0,error:failures < 3 ? '内容读取中断，正在自动重试。' : '内容读取已暂停，请点击重试或查看原窗口。'}}
      }
    }
  } finally {
    if (run === contentRun) {
      restoringContent = false
      const references = new Set((current.value?.turns || []).flatMap((turn:any) => (turn.items || []).filter((item:any) => item.type === 'lanpowerLargeItem').map((item:any) => item.reference)))
      contentState.value = Object.fromEntries(Object.entries(contentState.value).filter(([reference]) => references.has(reference)))
      if (ready.value && !controller.signal.aborted && [...contentFailures.values()].some(count => count < 3) && Object.values(contentState.value).some(value => value.error)) {
        contentRetry = setTimeout(() => retryContent(undefined,true),contentRetryDelay); contentRetryDelay = Math.min(30000,contentRetryDelay * 2)
      }
    }
  }
}
watch([current,loadingAllHistory],() => { void restoreContent() })
watch(ready,value => { if (!value) pauseContent(); else retryContent() })
function onEvent(event: RpcEvent): void {
  const p = event.params || {}, id = p.threadId || p.thread?.id
  if (id && !clock.event(id,p.lanpowerRevision)) return
  if (nativeUsage.event(event.method,p)) return
  if (event.method === 'turn/completed') { clearTimeout(quotaTimer); quotaTimer = setTimeout(() => { void nativeUsage.readQuota() },300) }
  if (event.id !== undefined) { addApproval(event); return }
  if (event.method === 'serverRequest/resolved') {
    const key = JSON.stringify(p.requestId), localId = approvalKeys.get(key)
    if (localId) { approvals.value = approvals.value.filter(a => a.id !== localId); approvalKeys.delete(key); remoteApprovalIds.delete(localId); respondingApproval.value = false }
    return
  }
  if (event.method === 'lanpower/error' || event.method === 'lanpower/approvalError') { respondingApproval.value = false; feedback.value = p.message || '操作未完成，请刷新会话确认状态。'; scheduleReconcile(); return }
  const oldTurn = event.method === 'turn/completed' && activeTurns.value[id] !== p.turn?.id
  if (event.method === 'turn/started' && id && p.turn?.id) { rememberTiming(id,p.turn,true); activeTurns.value = { ...activeTurns.value, [id]: p.turn.id } }
  if (event.method === 'turn/completed') { rememberTiming(id,p.turn,false); if (!oldTurn) { const next = { ...activeTurns.value }; delete next[id]; activeTurns.value = next } }
  if (event.method === 'thread/name/updated') { threads.value = threads.value.map(t => t.id === id ? { ...t, name: p.threadName || p.name } : t); if (current.value?.id === id) current.value = { ...current.value, name: p.threadName || p.name } }
  if (['thread/started','thread/archived','thread/unarchived'].includes(event.method)) { void loadThreads(); return }
  if (event.method === 'thread/name/updated' && libraryCatalog.value) void loadThreads()
  if (event.method === 'thread/status/changed') threads.value = threads.value.map(t => t.id === id ? {...t,status:p.status} : t)
  if (id && event.method === 'thread/settings/updated') {
    const key = sessionKey(id), settings = settingsByThread.get(key) || newSettings(); settingsByThread.set(key,settings)
    observeSettings(settings,p.threadSettings || p.settings || p,models.value[0] || '')
    if (id === threadId.value) displaySettings()
  }
  if (id && ['lanpower/historyChanged','lanpower/conversation/changed','lanpower/stream/changed','thread/status/changed'].includes(event.method) && id !== threadId.value) scheduleReconcile()
  if (id !== threadId.value || !current.value) return
  if (['lanpower/historyChanged','lanpower/conversation/changed','lanpower/stream/changed','thread/status/changed','thread/settings/updated'].includes(event.method)) { scheduleReconcile(); return }
  if (event.method === 'thread/queue/changed') { void refreshQueue().catch(showError); return }
  const turns = current.value.turns || (current.value.turns = [])
  if (event.method === 'turn/started' || event.method === 'turn/completed') {
    let turn = turns.find((t: any) => t.id === p.turn?.id)
    if (!turn) { turn = { ...p.turn, items: p.turn?.items || [] }; turns.push(turn) } else Object.assign(turn, p.turn, { items: p.turn?.items?.length ? p.turn.items : turn.items })
    if (!oldTurn) overlay.value = { activityLabel: event.method === 'turn/started' ? 'Thinking' : '', activityDetails: [], reasoningText: '', errorText: p.turn?.error?.message || '' }
  } else if (event.method === 'item/started' || event.method === 'item/completed' || event.method.endsWith('/delta') || event.method.endsWith('/outputDelta') || event.method === 'item/reasoning/summaryTextDelta') {
    let turn = turns.find((t: any) => t.id === p.turnId)
    if (!turn) { turn = { id: p.turnId, status: 'inProgress', items: [] }; turns.push(turn) }
    const itemId = p.item?.id || p.itemId
    let item = turn.items.find((i: any) => i.id === itemId)
    if (p.item) { if (item) Object.assign(item, p.item); else turn.items.push(p.item) }
    else if (event.method === 'item/agentMessage/delta') {
      if (!item) { item = { id: itemId, type: 'agentMessage', text: '' }; turn.items.push(item) }
      item.text = `${item.text || ''}${p.delta || ''}`
    } else if (event.method === 'item/commandExecution/outputDelta' && item) item.aggregatedOutput = `${item.aggregatedOutput || ''}${p.delta || ''}`
    else if (event.method === 'item/plan/delta') { if (!item) { item = {id:itemId,type:'plan',text:''}; turn.items.push(item) }; item.text = `${item.text || ''}${p.delta || ''}` }
    else if (event.method === 'item/reasoning/summaryTextDelta') {
      if (!item) { item = {id:itemId,type:'reasoning',summary:[]}; turn.items.push(item) }
      const index = Number.isSafeInteger(p.summaryIndex) && p.summaryIndex >= 0 ? p.summaryIndex : 0
      item.summary ||= []; item.summary[index] = `${item.summary[index] || ''}${p.delta || ''}`
    }
    const phase = event.method === 'item/completed' ? 'Thinking' : item?.type === 'agentMessage' ? 'Writing response' : item?.type === 'commandExecution' ? 'Running command' : 'Thinking'
    if (!p.turnId || p.turnId === activeTurn.value) overlay.value = {...overlay.value,activityLabel:phase}
  } else if (event.method === 'turn/plan/updated' && (!p.turnId || p.turnId === activeTurn.value)) overlay.value = { ...overlay.value, activityDetails: (p.plan || []).map((step: any) => `${step.status === 'completed' ? '✓' : '○'} ${step.step}`) }
  else if (event.method === 'error' && (!p.turnId || p.turnId === activeTurn.value)) overlay.value = { ...overlay.value, errorText: p.error?.message || '任务出错，请查看原窗口。' }
  // Many token notifications share one render, keeping long conversations responsive.
  if (!streamFrame) streamFrame = requestAnimationFrame(() => { streamFrame = 0; if (current.value) current.value = { ...current.value, turns: [...current.value.turns] } })
  if (event.method === 'turn/completed') scheduleReconcile()
}
function scheduleReconcile(): void {
  clearTimeout(reconcileTimer)
  reconcileTimer = setTimeout(() => {
    if (!ready.value) return
    if (busy.value || syncing || loadingChat.value || loadingEarlier.value || loadingAllHistory.value) { scheduleReconcile(); return }
    void refreshCurrent(); void refreshStatus()
  }, 500)
}
let refreshingStatus = false
async function refreshStatus(): Promise<void> {
  if (!ready.value || refreshingStatus) return
  const e = epoch, stamp = clock.capture(); refreshingStatus = true
  try { const status = await connection.request('lanpower/status'); if (e === epoch) applyStatus(status,stamp) }
  catch (error) { if (e === epoch) showError(error) }
  finally { refreshingStatus = false }
}
function saveLibrary(preferences: LibraryPreferences): void {
  libraryDraft = preferences; libraryState.value = {...libraryState.value,preferences}
  clearTimeout(libraryTimer); libraryTimer = setTimeout(() => { void flushLibrary() },250)
}
async function flushLibrary(): Promise<void> {
  if (librarySaving || !ready.value || !libraryDraft) return
  const e = epoch; librarySaving = true
  try {
    while (libraryDraft && e === epoch && ready.value) {
      const draft = libraryDraft; libraryDraft = null
      let result = await connection.request('lanpower/library/update',{revision:libraryState.value.revision,preferences:draft})
      if (e !== epoch) return
      if (result.conflict) result = await connection.request('lanpower/library/update',{revision:result.revision,preferences:draft})
      if (e !== epoch) return
      if (result.conflict) throw new Error('项目整理状态已变化，请刷新后重试。')
      libraryState.value = {revision:result.revision,preferences:libraryDraft || result.preferences}
    }
  } catch (error) { if (e === epoch) { libraryDraft = null; showError(error); const status = await connection.request('lanpower/status').catch(() => null); if (status?.library && e === epoch) libraryState.value = status.library } }
  finally { librarySaving = false; if (libraryDraft && ready.value) void flushLibrary() }
}
async function updatePower(): Promise<void> {
  const id = deviceId.value; if (!id) return
  try { const response = await fetch(`/api/v2/devices/${encodeURIComponent(id)}`, { cache: 'no-store' }); if (!response.ok) return; const status = await response.json(); if (id !== deviceId.value) return; powerText.value = ({ online: 'Windows 在线', offline: 'Windows 离线', transitioning: '正在执行电源操作' } as Record<string, string>)[status.state] || '电脑状态未知'; wakeAvailable.value = Boolean(status.wake_available) } catch {}
}
async function wake(): Promise<void> {
  waking.value = true
  try { const response = await fetch(`/api/v2/devices/${encodeURIComponent(deviceId.value)}/commands`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-csrf-token': config.csrf }, body: '{"action":"wake"}' }); if (!response.ok) throw new Error('唤醒请求未被接收，请检查网关。'); feedback.value = '唤醒请求已发送，电脑上线并登录后会自动连接。' } catch (error) { showError(error) } finally { waking.value = false }
}
function changeDevice(id: string): void {
  saveDraft(); resetHistory(); clock.clear()
  permissionsSupported.value = false
  epoch++; selection++; nativeUsage.reset(); capabilityPaging.value = false; deviceId.value = id; threadId.value = ''; current.value = null; threads.value = []; projects.value = []; models.value = []; queue.value = []; resetApprovals(); activeTurns.value = {}; editingQueue.value = ''; listCursor.value = ''; historyCursor.value = ''; powerText.value = ''; wakeAvailable.value = false; feedback.value = ''; chatOpen.value = false
  loadingChat.value = false; loadingLibrary.value = false; loadingEarlier.value = false; loadingAllHistory.value = false; busy.value = false; skills.value = []; filesCwd.value = ''; chatSupported.value = false; view.value = 'chat'; archivedView.value = false; newThreadDialog.value = false; renameDialog.value = false
  libraryDraft = null; libraryQuery.value = ''; searchRows.value = []; libraryCatalog.value = false; libraryState.value = {revision:0,preferences:defaultLibraryPreferences()}; filePath.value = ''; clearTimeout(libraryTimer); clearTimeout(reconcileTimer); resetRemoteImages()
  selectedModel.value = ''; selectedEffort.value = ''; selectedMode.value = 'default'; nativeModels.value = []; lastSync.value = 0; syncFailed.value = false; queryingReceipt.value = false; receiptVersion.value++; interrupting.value = false
  connection.connect(id); if (!id) state.value = 'idle'; else void updatePower()
}
function reconnect(): void { connection.connect(deviceId.value) }
function toggleTheme(): void { setTheme(document.documentElement.classList.contains('dark') ? 'light' : 'dark') }
function setTheme(mode: string): void { document.documentElement.classList.toggle('dark',mode === 'dark' || mode === 'system' && matchMedia('(prefers-color-scheme: dark)').matches); try { localStorage.setItem('lanpower-codex-theme',mode) } catch {} }
function setSendWithEnter(value: boolean): void { sendWithEnter.value = value; try { localStorage.setItem('lanpower-codex-send-enter',String(value)) } catch {} }
function setInProgressMode(value: 'queue' | 'steer'): void { inProgressMode.value = value; try { localStorage.setItem('lanpower-codex-send-mode',value) } catch {} }
function toggleSidebar(): void { if (innerWidth < 768 && threadId.value) chatOpen.value = true; else sidebarCollapsed.value = !sidebarCollapsed.value }
function syncUrl(): void { history.replaceState(null,'',`#/device/${encodeURIComponent(deviceId.value)}${threadId.value ? `/thread/${encodeURIComponent(threadId.value)}` : ''}`) }
async function openThread(id: string): Promise<void> { view.value = 'chat'; await selectThread(id) }
function navigate(target: string): void { view.value = target; chatOpen.value = true }
function openNewThread(cwd?: string): void { if (cwd) { view.value = 'chat'; void newThread(cwd) } else { newThreadDialog.value = true } }
async function createFromDialog(): Promise<void> { await newThread(projectCwd.value); if (threadId.value) { newThreadDialog.value = false; view.value = 'chat' } }
async function newChat(): Promise<void> { if (!ready.value || busy.value || !chatSupported.value) return; busy.value = true; try { const result = await connection.request('lanpower/chat/start',selectedModel.value ? {model:selectedModel.value} : {}); busy.value = false; view.value = 'chat'; await loadThreads(); await selectThread(result.thread.id) } catch(error) { showError(error) } finally { busy.value = false } }
async function toggleArchived(): Promise<void> { if (loadingLibrary.value) return; archivedView.value = !archivedView.value; listCursor.value = ''; threads.value = []; await loadThreads() }
async function sidebarThreadAction(action: string, id: string): Promise<void> { if (id !== threadId.value) await openThread(id); if (threadId.value !== id || loadingChat.value) return; if (action === 'rename') await renameThread(); else if (action === 'fork') await forkThread(); else if (action === 'archive') await archiveThread(); else if (action === 'unarchive') { try { await connection.request('thread/unarchive',{threadId:id}); await toggleArchived() } catch(error) { showError(error) } } }
async function jumpToBeginning(): Promise<void> {
  if (!ready.value || !threadId.value || loadingAllHistory.value || loadingEarlier.value) return
  pauseContent()
  const key = sessionKey(); beginningJob ||= newBeginning(); historyAbort = new AbortController(); loadingAllHistory.value = true; historyResume.value = 'beginning'
  try {
    const page = await findBeginning(connection,threadId.value,beginningJob,historyAbort.signal,count => { historyProgress.value = `正在定位对话开头，已检查 ${count} 轮…` })
    if (key !== sessionKey()) return
    beginningIndex.value = beginningJob.pages.length - 1; historyCursor.value = ''; current.value = {...current.value,turns:(page.data || []).slice().reverse()}
    historyProgress.value = `已定位对话开头，共 ${beginningJob.count} 轮。`; historyResume.value = ''; await nextTick(); await conversation.value?.jumpToStart()
  } catch (error) { if (key === sessionKey()) historyError(error) }
  finally { if (key === sessionKey()) loadingAllHistory.value = false }
}
async function loadLater(): Promise<void> {
  if (!beginningJob || beginningIndex.value <= 0 || loadingEarlier.value || !ready.value) return
  const key = sessionKey(), index = beginningIndex.value - 1; loadingEarlier.value = true
  try { const page = await readPage(connection,threadId.value,beginningJob.pages[index]); if (key === sessionKey()) { current.value = {...current.value,turns:(page.data || []).slice().reverse()}; beginningIndex.value = index; await nextTick(); await conversation.value?.jumpToStart() } }
  catch (error) { if (key === sessionKey()) showError(error) }
  finally { if (key === sessionKey()) loadingEarlier.value = false }
}
async function returnLatest(): Promise<void> {
  resetHistory()
  if (current.value) current.value = {...current.value,turns:[]}
  historyCursor.value = ''
  await refreshCurrent(); conversation.value?.jumpToLatest()
}
async function loadSkills(cwd: string, e = epoch, s = selection): Promise<void> { skills.value = []; if (!sharedControl.value || !cwd) return; try { const result = await connection.request('skills/list',{cwd}); if (e === epoch && s === selection) skills.value = [...new Map((result.data || []).flatMap((entry:any) => entry.skills || []).filter((skill:any) => skill.enabled !== false).map((skill:any) => [skill.path,skill])).values()] as any[] } catch {} }
function openFiles(cwd: string, path = ''): void { filePath.value = path; filesCwd.value = cwd }
async function attachProjectFile(path: string): Promise<void> { if (!threadId.value || !canControl.value) { feedback.value = '请先打开此项目的聊天，再添加文件。'; return }; view.value = 'chat'; chatOpen.value = true; await nextTick(); composer.value?.addProjectFile(path); filesCwd.value = '' }
async function useSkill(skill: {name:string;path:string}): Promise<void> { if (!threadId.value || !canControl.value) { feedback.value = '请先打开聊天，再选择技能。'; view.value = 'chat'; return }; view.value = 'chat'; chatOpen.value = true; await nextTick(); composer.value?.addSkill(skill) }
onMounted(() => {
  try { setTheme(localStorage.getItem('lanpower-codex-theme') || 'light'); sendWithEnter.value = localStorage.getItem('lanpower-codex-send-enter') !== 'false'; inProgressMode.value = localStorage.getItem('lanpower-codex-send-mode') === 'steer' ? 'steer' : 'queue' } catch {}
  connection.onEvent = onEvent; connection.onState = onState
  const route = location.hash.match(/^#\/device\/([^/]+)(?:\/thread\/([^/]+))?$/)
  if (devices.length) { const target = devices.find(d => d.id === decodeURIComponent(route?.[1] || '')); changeDevice(target?.id || devices[0]!.id); if (target && route?.[2]) { threadId.value = decodeURIComponent(route[2]); chatOpen.value = true } }
  document.addEventListener('visibilitychange',restoreVisible)
  polling = setInterval(() => { if (document.visibilityState === 'visible') { void updatePower(); void refreshCurrent(); void refreshStatus(); void loadThreads(); void queryReceipt() } }, 30000)
})
function restoreVisible(): void { if (document.visibilityState !== 'visible') return; if (ready.value) { void refreshCurrent(); void refreshStatus(); void queryReceipt() } else if (deviceId.value && state.value !== 'update_required' && state.value !== 'revoked') reconnect() }
onBeforeUnmount(() => { document.removeEventListener('visibilitychange',restoreVisible); historyAbort?.abort(); resetContent(); drafts.clear(); queueEdits.clear(); settingsByThread.clear(); receipts.clear(); clearInterval(polling); clearTimeout(libraryTimer); clearTimeout(reconcileTimer); clearTimeout(quotaTimer); nativeUsage.reset(); cancelAnimationFrame(streamFrame); resetRemoteImages(); connection.stop() })
</script>
