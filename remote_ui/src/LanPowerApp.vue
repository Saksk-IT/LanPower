<template>
  <div class="lp-codex" :class="{ 'lp-chat-open': chatOpen, 'lp-sidebar-collapsed': sidebarCollapsed }">
    <aside class="lp-library" aria-label="电脑、项目和会话">
      <LanPowerThreadTree :device-id="deviceId" :projects="projects" :threads="threads" :selected-thread-id="threadId" :active-turns="activeTurns" :approval-threads="approvals.map(a => a.threadId)" :ready="ready" :loading="loadingLibrary" :next-cursor="listCursor" :archived="archivedView" :chat-supported="chatSupported" :saved-preferences="libraryState.preferences" @update-library="saveLibrary" @select="openThread" @new-thread="openNewThread" @new-chat="newChat" @toggle-sidebar="toggleSidebar" @load-more="loadThreads(true)" @toggle-archived="toggleArchived" @navigate="navigate" @thread-action="sidebarThreadAction" @browse-files="openFiles">
      <template #connection><div class="lp-device-context"><ComposerDropdown class="lp-device-picker" :model-value="deviceId" :options="devices.map(d => ({value:d.id,label:d.name}))" placeholder="选择开发电脑" enable-search search-placeholder="搜索电脑" @update:model-value="changeDevice" />
      <div class="lp-connection" role="status"><span :class="{ 'is-ready': ready }" />{{ stateLabel }}<button v-if="!ready && deviceId" @click="reconnect">重连</button></div>
      <p v-if="wakeAvailable" class="lp-power"><span>{{ powerText }}</span><button :disabled="waking" @click="wake">唤醒</button></p></div></template>
      </LanPowerThreadTree>
    </aside>
    <main v-show="view === 'chat'" class="lp-conversation">
      <header class="lp-chat-header"><button class="lp-back" @click="chatOpen = false" aria-label="返回会话列表"><IconTablerLayoutSidebar /></button><button v-if="sidebarCollapsed" class="lp-expand lp-icon-button" @click="sidebarCollapsed = false" aria-label="展开侧栏"><IconTablerLayoutSidebar /></button><div><h1>{{ currentTitle }}</h1></div><button v-if="currentCwd" class="lp-header-pill" @click="openFiles(currentCwd)" aria-label="浏览项目文件"><IconTablerFolder /><span>{{ projectName(currentCwd) }}</span></button><details v-if="threadId" class="lp-actions"><summary aria-label="会话操作">•••</summary><div><button @click="refreshCurrent">刷新会话</button><button :disabled="loadingAllHistory" @click="jumpToBeginning">跳至对话开头</button><button @click="renameThread">重命名</button><button @click="forkThread()">分支会话</button><button @click="archiveThread">归档</button><button :disabled="loadingAllHistory" @click="exportChat">导出完整会话</button></div></details></header>
      <div class="lp-chat-status"><span>{{ !ready ? stateLabel : activeTurn ? '正在工作' : threadId ? '已同步' : stateLabel }}</span><span>{{ desktopControl ? '原 Codex 窗口' : sharedControl ? '备用共享窗口' : '本机 Codex' }}</span></div>
      <p v-if="feedback" class="lp-feedback" role="status">{{ feedback }}<button @click="feedback = ''" aria-label="关闭提示">×</button></p>
      <template v-if="threadId">
        <p v-if="loadingAllHistory" class="lp-history-progress" role="status">正在读取完整对话，已读取 {{ current?.turns?.length || 0 }} 轮…</p>
        <ThreadConversation ref="conversation" :messages="messages" :pending-requests="selectedApprovals" :live-overlay="liveOverlay" :is-loading="loadingChat" :active-thread-id="threadId" :cwd="currentCwd" :has-more-persisted-above="Boolean(historyCursor)" :is-loading-persisted-above="loadingEarlier" :load-earlier-messages="loadEarlier" :allow-file-actions="false" @fork-thread="forkThread($event.turnIndex)" @rollback="rollback($event.turnId)" @respond-server-request="respondApproval" @open-file="openFiles(currentCwd,$event)" />
        <div class="lp-compose-area">
          <p v-if="editingQueue" class="lp-edit-queue">正在修改排队消息 <button @click="cancelQueueEdit">取消</button></p>
          <QueuedMessages :messages="queueRows" @edit="editQueue" @delete="deleteQueue" @steer="startQueue" @reorder="reorderQueue" />
          <ThreadPendingRequestPanel v-if="selectedApprovals.length" :request="selectedApprovals[0]!" :request-count="selectedApprovals.length" :has-queue-above="queueRows.length > 0" :single-turn-only="true" :is-responding="respondingApproval" @respond-server-request="respondApproval" />
          <ThreadComposer v-show="!selectedApprovals.length" :key="`${deviceId}:${threadId}`" ref="composer" :active-thread-id="threadId" :cwd="currentCwd" :models="models" :skills="skills" :supports-plan-mode="planSupported" :selected-model="selectedModel" :selected-reasoning-effort="selectedEffort" :selected-collaboration-mode="selectedMode" selected-speed-mode="standard" :is-turn-in-progress="Boolean(activeTurn)" :is-interrupting-turn="interrupting" :disabled="!canControl || busy || loadingChat" :has-queue-above="queueRows.length > 0" :send-with-enter="sendWithEnter" :in-progress-submit-mode="inProgressMode" :remote-mode="true" @submit="submit" @interrupt="interrupt" @update:selected-model="selectedModel = $event" @update:selected-reasoning-effort="selectedEffort = $event" @update:selected-collaboration-mode="selectedMode = $event" />
          <p class="lp-compose-hint">{{ canControl ? '输入与操作同步到电脑上的同一会话' : ready ? '请在电脑的 LanPower 连接原 Codex 窗口后继续此会话' : stateHint }}</p>
        </div>
      </template>
      <div v-else class="lp-welcome"><div>✳</div><h2>继续你的工作</h2><p>选择最近聊天，或在项目中新建聊天。</p><button class="lp-primary" :disabled="!ready" @click="openNewThread()">＋ 新聊天</button><p v-if="!ready">{{ stateHint }}</p></div>
    </main>
    <RemoteFeaturePage v-if="view !== 'chat'" :view="view" :ready="ready" :projects="projects" :cwd="currentCwd || projectCwd" :send-with-enter="sendWithEnter" :in-progress-mode="inProgressMode" @back="chatOpen = false" @close="view = 'chat'; chatOpen = true" @use-skill="useSkill" @theme="setTheme" @update:send-with-enter="setSendWithEnter" @update:in-progress-mode="setInProgressMode" />
    <RemoteFilesPanel v-if="filesCwd" :key="`${deviceId}:${filesCwd}:${filePath}`" :cwd="filesCwd" :ready="ready" :initial-path="filePath" @close="filesCwd = ''; filePath = ''" @attach="attachProjectFile" />
    <Teleport to="body"><div v-if="newThreadDialog" class="lp-dialog-overlay" @click.self="newThreadDialog = false"><form class="lp-dialog" role="dialog" aria-modal="true" aria-label="新建聊天" @submit.prevent="createFromDialog"><h2>新建聊天</h2><p>选择已授权的项目目录。</p><ComposerDropdown v-model="projectCwd" :options="projects.filter(p => p.kind !== 'chat').map(p => ({value:p.path,label:p.name}))" placeholder="选择项目" enable-search search-placeholder="搜索项目" /><footer><button type="button" @click="newThreadDialog = false">取消</button><button class="lp-primary" :disabled="!projectCwd || busy">创建聊天</button></footer></form></div><div v-if="renameDialog" class="lp-dialog-overlay" @click.self="renameDialog = false"><form class="lp-dialog" role="dialog" aria-modal="true" aria-label="重命名聊天" @submit.prevent="saveThreadName"><h2>重命名聊天</h2><input v-model="renameDraft" aria-label="聊天名称" autofocus maxlength="1000" /><footer><button type="button" @click="renameDialog = false">取消</button><button class="lp-primary" :disabled="!renameDraft.trim()">保存</button></footer></form></div></Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import ThreadConversation from './components/content/ThreadConversation.vue'
import ThreadComposer, { type SubmitPayload, type ThreadComposerExposed } from './components/content/ThreadComposer.vue'
import QueuedMessages from './components/content/QueuedMessages.vue'
import ThreadPendingRequestPanel from './components/content/ThreadPendingRequestPanel.vue'
import { normalizeThreadMessagesV2 } from './api/normalizers/v2'
import LanPowerThreadTree from './components/sidebar/LanPowerThreadTree.vue'
import ComposerDropdown from './components/content/ComposerDropdown.vue'
import IconTablerLayoutSidebar from './components/icons/IconTablerLayoutSidebar.vue'
import IconTablerFolder from './components/icons/IconTablerFolder.vue'
import RemoteFeaturePage from './components/content/RemoteFeaturePage.vue'
import RemoteFilesPanel from './components/content/RemoteFilesPanel.vue'
import { mergeHistory } from './lanpower/history'
import { reasoningSummary, timestampMs } from './lanpower/turnPresentation'
import { defaultLibraryPreferences, type LibraryPreferences } from './lanpower/library'
import { resetRemoteImages } from './lanpower/images'
import type { ReasoningEffort, UiServerRequest, UiLiveOverlay } from './types/codex'
import { connection, type RpcEvent } from './lanpower/connection'

const config = JSON.parse(document.getElementById('lanpower-codex-config')?.textContent || '{"devices":[]}')
const devices: Array<{ id: string; name: string }> = config.devices
const deviceId = ref(''), state = ref('idle'), threadId = ref(''), chatOpen = ref(false)
const sidebarCollapsed = ref(false), view = ref('chat'), archivedView = ref(false), chatSupported = ref(false), filesCwd = ref('')
const newThreadDialog = ref(false), renameDialog = ref(false), renameDraft = ref(''), loadingAllHistory = ref(false)
const sendWithEnter = ref(true), inProgressMode = ref<'queue' | 'steer'>('queue'), selectedMode = ref<'default' | 'plan'>('default')
const skills = ref<Array<{name:string;path:string;description:string;scope?:string;enabled?:boolean}>>([])
const conversation = ref<{jumpToStart:()=>Promise<void>;jumpToLatest:()=>void} | null>(null)
const ready = computed(() => state.value === 'runtime_ready')
const threads = shallowRef<any[]>([]), current = shallowRef<any>(null), projects = ref<Array<{ name: string; path: string; kind?:string }>>([])
const projectCwd = ref(''), listCursor = ref(''), historyCursor = ref(''), models = ref<string[]>([])
const selectedModel = ref(''), selectedEffort = ref<ReasoningEffort | ''>('')
const desktopControl = ref(false), sharedControl = ref(false), queueSupported = ref(false)
const planSupported = ref(false)
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
  cloud_offline: ['电脑未连接', '电脑上线并登录 Windows 后会自动连接。'], host_offline: ['等待电脑登录', '请登录 Windows 并打开 LanPower。'],
  disabled: ['尚未授权', '请在电脑的 LanPower 启用 Codex Remote 并保存授权。'], host_ready: ['正在读取 Codex', '正在连接电脑上的 Codex。'],
  runtime_starting: ['正在读取 Codex', '正在读取原窗口的项目与最近会话。'], runtime_ready: ['已连接', ''],
  runtime_error: ['Codex 未就绪', '请在电脑的 LanPower 点击「连接原 Codex 窗口」。'],
  disconnected: ['连接已断开', '正在重连；电脑上的任务会继续运行。'], controller_busy: ['另一页面正在控制', '关闭另一控制页面后点击重连。'],
}
const stateLabel = computed(() => labels[state.value]?.[0] || '连接未就绪')
const stateHint = computed(() => labels[state.value]?.[1] || '请检查电脑上的连接状态。')
const activeTurn = computed(() => activeTurns.value[threadId.value] || '')
const canControl = computed(() => ready.value && Boolean(threadId.value) && (sharedControl.value || current.value?.control === 'remote'))
const currentTitle = computed(() => current.value?.name || current.value?.preview?.slice(0, 60) || (threadId.value ? '新会话' : 'Codex Remote'))
const currentCwd = computed(() => current.value?.cwd || '')
const messages = computed(() => current.value ? normalizeThreadMessagesV2({ thread: {...current.value,turns:(current.value.turns || []).map((turn:any) => {
  const timing = turnTimings.get(timingKey(current.value.id,turn.id))
  return timing ? {...turn,startedAt:turn.startedAt ?? timing.startedAt,completedAt:turn.completedAt ?? timing.completedAt} : turn
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
  if (!ready.value) { epoch++; busy.value = false; syncing = false; libraryDraft = null; resetRemoteImages(); resetApprovals(); queue.value = []; overlay.value = { activityLabel: '', activityDetails: [], reasoningText: '', errorText: '' } }
  else if (!wasReady) void restore()
}
async function restore(): Promise<void> {
  const e = epoch
  try {
    const [status, modelList, modes] = await Promise.all([connection.request('lanpower/status'), connection.request('model/list', { limit: 50 }), connection.request('collaborationMode/list').catch(() => ({data:[]}))])
    if (e !== epoch || !ready.value) return
    applyStatus(status)
    planSupported.value = (modes.data || []).some((mode:any) => mode.mode === 'plan')
    models.value = (modelList.data || []).map((m: any) => m.id || m.model).filter(Boolean)
    selectedModel.value = models.value.includes(selectedModel.value) ? selectedModel.value : (modelList.data || []).find((m: any) => m.isDefault)?.id || models.value[0] || ''
    await loadThreads()
    if (threadId.value) { if (current.value?.id === threadId.value) await refreshCurrent(); else await selectThread(threadId.value, true) }
  } catch (error) { if (e === epoch) showError(error) }
}
function applyStatus(status: any): void {
  desktopControl.value = Boolean(status.desktopControl); sharedControl.value = Boolean(status.sharedControl); queueSupported.value = Boolean(status.queueSupported)
  chatSupported.value = Boolean(status.chatSupported)
  if (status.library && !librarySaving && !libraryDraft) libraryState.value = status.library
  projects.value = status.projects || []; if (!projects.value.some(p => p.path === projectCwd.value)) projectCwd.value = projects.value[0]?.path || ''
  activeTurns.value = Object.fromEntries((status.activeTurns || []).map((t: any) => [t.threadId, t.turnId]))
  // Reconcile requests; a desktop reply can have arrived while the browser was disconnected.
  const incoming = new Set((status.pendingApprovals || []).map((request: RpcEvent) => JSON.stringify(request.id)))
  for (const [key, localId] of approvalKeys) if (!incoming.has(key)) { approvalKeys.delete(key); remoteApprovalIds.delete(localId) }
  approvals.value = approvals.value.filter(a => remoteApprovalIds.has(a.id))
  if (!approvals.value.length) respondingApproval.value = false
  for (const request of status.pendingApprovals || []) addApproval(request)
}
async function loadThreads(more = false): Promise<void> {
  if (!ready.value || loadingLibrary.value) return
  const e = epoch; loadingLibrary.value = true
  try {
    const result = await connection.request('thread/list', { limit: 50, archived: archivedView.value, ...(more && listCursor.value ? { cursor: listCursor.value } : {}) })
    if (e !== epoch) return
    const all = [...threads.value, ...result.data]
    threads.value = [...new Map(all.map((t: any) => [t.id, t])).values()]
    if (more || threads.value.length <= result.data.length) listCursor.value = result.nextCursor || ''
  } catch (error) { if (e === epoch) showError(error) } finally { if (e === epoch) loadingLibrary.value = false }
}
async function selectThread(id: string, restoring = false): Promise<void> {
  if (!ready.value || busy.value) return
  if (!restoring && id !== threadId.value && composer.value?.hasUnsavedDraft() && !confirm('切换会话将清空当前未发送的草稿，继续吗？')) return
  const e = epoch, s = ++selection
  loadingEarlier.value = false; loadingAllHistory.value = false; syncing = false
  threadId.value = id; chatOpen.value = true; loadingChat.value = true; current.value = null; queue.value = []; editingQueue.value = ''; historyCursor.value = ''
  overlay.value = { activityLabel: '', activityDetails: [], reasoningText: '', errorText: '' }
  try {
    const result = await connection.request('thread/read', { threadId: id, includeTurns: true })
    if (e !== epoch || s !== selection) return
    current.value = result.thread; historyCursor.value = result.thread.historyCursor || ''
    applyThreadSettings(result.thread)
    syncUrl(); void loadSkills(result.thread.cwd, e, s)
    observeTurn(result.thread)
    await refreshQueue(id, e, s)
    const status = await connection.request('lanpower/status')
    if (e === epoch && s === selection) applyStatus(status)
  } catch (error) { if (e === epoch && s === selection) showError(error) } finally { if (s === selection) loadingChat.value = false }
}
function observeTurn(thread: any): void {
  const turn = (thread.turns || []).findLast((t: any) => t.status === 'inProgress')
  const next = { ...activeTurns.value }
  if (turn) next[thread.id] = turn.id; else if (thread.status?.type !== 'active') delete next[thread.id]
  activeTurns.value = next
}
function applyThreadSettings(thread: any): void {
  if (thread.model) selectedModel.value = thread.model
  if ('reasoningEffort' in thread) selectedEffort.value = thread.reasoningEffort || ''
  const mode = thread.collaborationMode?.mode || thread.collaborationMode
  if (mode === 'default' || mode === 'plan') selectedMode.value = mode
}
async function loadEarlier(id: string): Promise<void> {
  if (id !== threadId.value || !historyCursor.value || loadingEarlier.value || !ready.value) return
  const e = epoch, s = selection; loadingEarlier.value = true
  try {
    const result = await connection.request('thread/turns/list', { threadId: id, cursor: historyCursor.value, limit: 8 })
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
  const result = await connection.request('thread/queue/list', { threadId: id, limit: 32 })
  if (e === epoch && s === selection && id === threadId.value) queue.value = result.data || []
}
async function refreshCurrent(): Promise<void> {
  if (!ready.value || !threadId.value || loadingChat.value || loadingEarlier.value || loadingAllHistory.value || busy.value || syncing) return
  const e = epoch, s = selection, id = threadId.value; syncing = true
  try {
    const [result, status] = await Promise.all([connection.request('thread/read', { threadId: id, includeTurns: true }), connection.request('lanpower/status')])
    if (e !== epoch || s !== selection) return
    let latest = result.thread.turns || [], cursor = result.thread.historyCursor || ''
    const previous = current.value?.turns || [], oldIds = new Set(previous.map((t: any) => t.id))
    // If many turns finished while disconnected, bridge the gap before merging.
    while (previous.length && latest.length && !latest.some((t: any) => oldIds.has(t.id)) && cursor) {
      const page = await connection.request('thread/turns/list', {threadId:id,cursor,limit:8})
      if (e !== epoch || s !== selection) return
      const next = page.nextCursor || ''; if (next && next === cursor) throw new Error('历史游标未推进，请刷新会话。')
      latest = [...(page.data || []).slice().reverse(), ...latest]; cursor = next
    }
    if (!previous.length || previous[0]?.id === latest[0]?.id || latest.some((t: any) => t.id === previous[0]?.id)) historyCursor.value = cursor
    current.value = { ...result.thread, turns: mergeHistory(current.value?.turns || [], latest) }; applyStatus(status); observeTurn(current.value)
    applyThreadSettings(result.thread)
    await refreshQueue(id, e, s)
  } catch (error) { if (e === epoch && s === selection) showError(error) } finally { if (e === epoch && s === selection) syncing = false }
}
async function newThread(cwd?: string): Promise<void> {
  if (!cwd || !ready.value || busy.value) return
  busy.value = true
  try { const result = await connection.request('thread/start', { cwd, ...(selectedModel.value ? { model: selectedModel.value } : {}) }); busy.value = false; await loadThreads(); await selectThread(result.thread.id) }
  catch (error) { showError(error) } finally { busy.value = false }
}
async function submit(payload: SubmitPayload): Promise<void> {
  if (!canControl.value || busy.value) return
  const e = epoch, s = selection, id = threadId.value
  busy.value = true; feedback.value = ''
  try {
    const text = payload.fileAttachments.length ? `# Files mentioned by the user:\n${payload.fileAttachments.map(file => `## ${file.label}: ${file.fsPath}`).join('\n')}\n\n## My request for Codex:\n${payload.text.trim()}` : payload.text.trim()
    const input = [...(text ? [{ type: 'text', text }] : []), ...payload.imageUrls.map(url => ({ type: 'image', url })), ...payload.skills.map(skill => ({type:'skill',name:skill.name,path:skill.path}))]
    if (editingQueue.value) await connection.request('thread/queue/update', { threadId: id, queuedSubmissionId: editingQueue.value, input })
    else if (activeTurn.value && payload.mode === 'queue') await connection.request('thread/queue/add', { threadId: id, clientUserMessageId: crypto.randomUUID(), input })
    else if (activeTurn.value) await connection.request('turn/steer', { threadId: id, expectedTurnId: activeTurn.value, input })
    else {
      const result = await connection.request('turn/start', { threadId: id, input, ...(sharedControl.value ? {mode:selectedMode.value} : {}), ...(selectedModel.value ? { model: selectedModel.value } : {}), ...(selectedEffort.value ? { effort: selectedEffort.value } : {}) })
      if (e === epoch && s === selection && result.turn?.id) { rememberTiming(id,result.turn,true); overlay.value = {activityLabel:'Thinking',activityDetails:[],reasoningText:'',errorText:''}; activeTurns.value = { ...activeTurns.value, [id]: result.turn.id } }
    }
    if (e === epoch && s === selection) { editingQueue.value = ''; await refreshQueue(id, e, s) }
  } catch (error) { if (e === epoch && s === selection) { showError(error); composer.value?.hydrateDraft(payload) } }
  finally { if (e === epoch) busy.value = false }
}
async function interrupt(): Promise<void> {
  if (!activeTurn.value || interrupting.value || !canControl.value) return
  interrupting.value = true
  try { await connection.request('turn/interrupt', { threadId: threadId.value, turnId: activeTurn.value }); await refreshCurrent() } catch (error) { showError(error) } finally { interrupting.value = false }
}
function editQueue(id: string): void {
  const row = queueRows.value.find(q => q.id === id)
  if (!row || busy.value || !canControl.value) return
  if (composer.value?.hasUnsavedDraft() && !confirm('用排队消息替换当前未发送的草稿？')) return
  editingQueue.value = id; composer.value?.hydrateDraft({ text: row.text, imageUrls: row.imageUrls, skills: [], fileAttachments: [] })
}
function cancelQueueEdit(): void { editingQueue.value = ''; composer.value?.hydrateDraft({ text: '', imageUrls: [], skills: [], fileAttachments: [] }) }
async function queueAction(method: string, params: any): Promise<void> {
  if (busy.value || !canControl.value) return
  const e = epoch, s = selection; busy.value = true
  try { await connection.request(method, { threadId: threadId.value, ...params }); await refreshQueue(threadId.value, e, s) } catch (error) { if (e === epoch) showError(error) } finally { if (e === epoch) busy.value = false }
}
async function deleteQueue(id: string): Promise<void> { await queueAction('thread/queue/delete', { queuedSubmissionId: id }); if (editingQueue.value === id && !queue.value.some(q => q.id === id)) cancelQueueEdit() }
async function startQueue(id: string): Promise<void> { await queueAction('thread/queue/start', { queuedSubmissionId: id }) }
async function reorderQueue({ draggedId, targetId }: { draggedId: string; targetId: string }): Promise<void> {
  const ids = queue.value.map(q => q.id), from = ids.indexOf(draggedId), to = ids.indexOf(targetId)
  if (from < 0 || to < 0) return
  ids.splice(from, 1); ids.splice(to, 0, draggedId)
  await queueAction('thread/queue/reorder', { queuedSubmissionIds: ids })
}
function respondApproval(reply: { id: number; result?: unknown; error?: unknown; followUpMessageText?: string }): void {
  const remoteId = remoteApprovalIds.get(reply.id)
  if (remoteId === undefined || !ready.value || respondingApproval.value) return
  try {
    if (reply.error) throw new Error('请在原窗口取消此请求。')
    connection.decide(remoteId, reply.result); respondingApproval.value = true
    if (reply.followUpMessageText) void queueAction('thread/queue/add', { clientUserMessageId: crypto.randomUUID(), input: [{ type: 'text', text: reply.followUpMessageText }] })
  } catch (error) { respondingApproval.value = false; showError(error) }
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
  busy.value = true
  try {
    const result = await connection.request('thread/fork', { threadId: threadId.value })
    const later = typeof turnIndex === 'number' ? (current.value.turns.length - turnIndex - 1) : 0
    if (later > 0) await connection.request('thread/rollback', { threadId: result.thread.id, numTurns: later })
    busy.value = false; await loadThreads(); await selectThread(result.thread.id)
  } catch (error) { showError(error) } finally { busy.value = false }
}
async function rollback(turnId: string): Promise<void> {
  if (!canControl.value || activeTurn.value || busy.value) return
  const index = current.value.turns.findIndex((t: any) => t.id === turnId)
  if (index < 0 || !confirm('移除这轮及后续对话？已修改的文件会保留。')) return
  busy.value = true
  try { const result = await connection.request('thread/rollback', { threadId: threadId.value, numTurns: current.value.turns.length - index }); current.value = result.thread; historyCursor.value = result.thread.historyCursor || ''; feedback.value = '对话已回退，已有文件修改保留。' } catch (error) { showError(error) } finally { busy.value = false }
}
async function archiveThread(): Promise<void> {
  if (!canControl.value || activeTurn.value || !confirm('归档当前会话？')) return
  try { await connection.request('thread/archive', { threadId: threadId.value }); threads.value = threads.value.filter(t => t.id !== threadId.value); threadId.value = ''; current.value = null; chatOpen.value = false; syncUrl(); await loadThreads() } catch (error) { showError(error) }
}
async function exportChat(): Promise<void> {
  if (!await loadAllHistory()) return
  const url = URL.createObjectURL(new Blob([JSON.stringify(current.value,null,2)], { type: 'application/json;charset=utf-8' }))
  const link = document.createElement('a'); link.href = url; link.download = 'codex-conversation.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
}
function onEvent(event: RpcEvent): void {
  const p = event.params || {}, id = p.threadId || p.thread?.id
  if (event.id !== undefined) { addApproval(event); return }
  if (event.method === 'serverRequest/resolved') {
    const key = JSON.stringify(p.requestId), localId = approvalKeys.get(key)
    if (localId) { approvals.value = approvals.value.filter(a => a.id !== localId); approvalKeys.delete(key); remoteApprovalIds.delete(localId); respondingApproval.value = false }
    return
  }
  if (event.method === 'lanpower/error' || event.method === 'lanpower/approvalError') { respondingApproval.value = false; feedback.value = '操作未完成，请刷新会话确认状态。'; return }
  if (event.method === 'turn/started') { rememberTiming(id,p.turn,true); activeTurns.value = { ...activeTurns.value, [id]: p.turn?.id } }
  if (event.method === 'turn/completed') { rememberTiming(id,p.turn,false); const next = { ...activeTurns.value }; delete next[id]; activeTurns.value = next }
  if (event.method === 'thread/name/updated') { threads.value = threads.value.map(t => t.id === id ? { ...t, name: p.threadName || p.name } : t); if (current.value?.id === id) current.value = { ...current.value, name: p.threadName || p.name } }
  if (event.method === 'thread/started') { void loadThreads(); return }
  if (event.method === 'thread/status/changed') threads.value = threads.value.map(t => t.id === id ? {...t,status:p.status} : t)
  if (id !== threadId.value || !current.value) return
  if (['lanpower/historyChanged','lanpower/conversation/changed','lanpower/stream/changed','thread/status/changed','thread/settings/updated'].includes(event.method)) { scheduleReconcile(); return }
  if (event.method === 'thread/queue/changed') { void refreshQueue().catch(showError); return }
  const turns = current.value.turns || (current.value.turns = [])
  if (event.method === 'turn/started' || event.method === 'turn/completed') {
    let turn = turns.find((t: any) => t.id === p.turn?.id)
    if (!turn) { turn = { ...p.turn, items: p.turn?.items || [] }; turns.push(turn) } else Object.assign(turn, p.turn, { items: p.turn?.items?.length ? p.turn.items : turn.items })
    overlay.value = { activityLabel: event.method === 'turn/started' ? 'Thinking' : '', activityDetails: [], reasoningText: '', errorText: p.turn?.error?.message || '' }
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
    overlay.value = {...overlay.value,activityLabel:phase}
  } else if (event.method === 'turn/plan/updated') overlay.value = { ...overlay.value, activityDetails: (p.plan || []).map((step: any) => `${step.status === 'completed' ? '✓' : '○'} ${step.step}`) }
  else if (event.method === 'error') overlay.value = { ...overlay.value, errorText: p.error?.message || '任务出错，请查看原窗口。' }
  // Many token notifications share one render, keeping long conversations responsive.
  if (!streamFrame) streamFrame = requestAnimationFrame(() => { streamFrame = 0; if (current.value) current.value = { ...current.value, turns: [...current.value.turns] } })
  if (event.method === 'turn/completed') scheduleReconcile()
}
function scheduleReconcile(): void {
  clearTimeout(reconcileTimer)
  reconcileTimer = setTimeout(() => {
    if (!ready.value || !threadId.value) return
    if (busy.value || syncing || loadingChat.value || loadingEarlier.value || loadingAllHistory.value) { scheduleReconcile(); return }
    void refreshCurrent()
  }, 500)
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
  if (composer.value?.hasUnsavedDraft() && !confirm('切换电脑将清空当前未发送的草稿，继续吗？')) return
  epoch++; selection++; deviceId.value = id; threadId.value = ''; current.value = null; threads.value = []; projects.value = []; models.value = []; queue.value = []; resetApprovals(); activeTurns.value = {}; editingQueue.value = ''; listCursor.value = ''; historyCursor.value = ''; powerText.value = ''; wakeAvailable.value = false; feedback.value = ''; chatOpen.value = false
  loadingChat.value = false; loadingLibrary.value = false; loadingEarlier.value = false; loadingAllHistory.value = false; busy.value = false; skills.value = []; filesCwd.value = ''; chatSupported.value = false; view.value = 'chat'; archivedView.value = false; newThreadDialog.value = false; renameDialog.value = false
  libraryDraft = null; libraryState.value = {revision:0,preferences:defaultLibraryPreferences()}; filePath.value = ''; clearTimeout(libraryTimer); clearTimeout(reconcileTimer); resetRemoteImages()
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
async function sidebarThreadAction(action: string, id: string): Promise<void> { if (id !== threadId.value) await openThread(id); if (threadId.value !== id || loadingChat.value) return; if (action === 'rename') await renameThread(); else if (action === 'fork') await forkThread(); else if (action === 'export') await exportChat(); else if (action === 'archive') await archiveThread(); else if (action === 'unarchive') { try { await connection.request('thread/unarchive',{threadId:id}); await toggleArchived() } catch(error) { showError(error) } } }
async function loadAllHistory(): Promise<boolean> { if (!threadId.value || !ready.value || loadingAllHistory.value || loadingEarlier.value) return false; const e = epoch, s = selection; loadingAllHistory.value = true; try { while (historyCursor.value && e === epoch && s === selection) { const cursor = historyCursor.value; await loadEarlier(threadId.value); if (historyCursor.value === cursor) return false }; return e === epoch && s === selection } finally { if (e === epoch && s === selection) loadingAllHistory.value = false } }
async function jumpToBeginning(): Promise<void> { if (await loadAllHistory()) await conversation.value?.jumpToStart() }
async function loadSkills(cwd: string, e = epoch, s = selection): Promise<void> { skills.value = []; if (!sharedControl.value || !cwd) return; try { const result = await connection.request('skills/list',{cwd}); if (e === epoch && s === selection) skills.value = [...new Map((result.data || []).flatMap((entry:any) => entry.skills || []).filter((skill:any) => skill.enabled !== false).map((skill:any) => [skill.path,skill])).values()] as any[] } catch {} }
function openFiles(cwd: string, path = ''): void { filePath.value = path; filesCwd.value = cwd }
async function attachProjectFile(path: string): Promise<void> { if (!threadId.value || !canControl.value) { feedback.value = '请先打开此项目的聊天，再添加文件。'; return }; view.value = 'chat'; chatOpen.value = true; await nextTick(); composer.value?.addProjectFile(path); filesCwd.value = '' }
async function useSkill(skill: {name:string;path:string}): Promise<void> { if (!threadId.value || !canControl.value) { feedback.value = '请先打开聊天，再选择技能。'; view.value = 'chat'; return }; view.value = 'chat'; chatOpen.value = true; await nextTick(); composer.value?.addSkill(skill) }
onMounted(() => {
  try { setTheme(localStorage.getItem('lanpower-codex-theme') || 'light'); sendWithEnter.value = localStorage.getItem('lanpower-codex-send-enter') !== 'false'; inProgressMode.value = localStorage.getItem('lanpower-codex-send-mode') === 'steer' ? 'steer' : 'queue' } catch {}
  connection.onEvent = onEvent; connection.onState = onState
  const route = location.hash.match(/^#\/device\/([^/]+)(?:\/thread\/([^/]+))?$/)
  if (devices.length) { const target = devices.find(d => d.id === decodeURIComponent(route?.[1] || '')); changeDevice(target?.id || devices[0]!.id); if (target && route?.[2]) { threadId.value = decodeURIComponent(route[2]); chatOpen.value = true } }
  polling = setInterval(() => { if (document.visibilityState === 'visible') { void updatePower(); void refreshCurrent(); void loadThreads() } }, 30000)
})
onBeforeUnmount(() => { clearInterval(polling); clearTimeout(libraryTimer); clearTimeout(reconcileTimer); cancelAnimationFrame(streamFrame); resetRemoteImages(); connection.stop() })
</script>
