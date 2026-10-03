<template>
  <div class="lp-codex" :class="{ 'lp-chat-open': chatOpen }">
    <aside class="lp-library" aria-label="电脑、项目和会话">
      <header class="lp-library-heading"><a href="/dashboard" aria-label="返回 LanPower">‹</a><strong>Codex</strong><button @click="toggleTheme" aria-label="切换明暗主题">◐</button></header>
      <label class="lp-device-label" for="lp-device">开发电脑</label>
      <select id="lp-device" :value="deviceId" @change="changeDevice(($event.target as HTMLSelectElement).value)">
        <option value="">选择电脑</option><option v-for="d in devices" :key="d.id" :value="d.id">{{ d.name }}</option>
      </select>
      <div class="lp-connection" role="status"><span :class="{ 'is-ready': ready }" />{{ stateLabel }}<button v-if="!ready && deviceId" @click="reconnect">重连</button></div>
      <p class="lp-power"><span>{{ powerText }}</span><button v-if="wakeAvailable" :disabled="waking" @click="wake">唤醒</button></p>
      <input v-model="search" class="lp-search" placeholder="搜索会话或项目" aria-label="搜索会话或项目" maxlength="120" />
      <div class="lp-thread-list">
        <section v-for="group in groups" :key="group.projectName" class="lp-project">
          <header><span :title="group.threads[0]?.cwd">{{ group.projectName }}</span><button :disabled="!ready" @click="newThread(group.threads[0]?.cwd)" aria-label="在此项目新建会话">＋</button></header>
          <button v-for="t in group.threads" :key="t.id" class="lp-thread" :class="{ selected: t.id === threadId }" @click="selectThread(t.id)">
            <span class="lp-thread-title">{{ t.title }}</span><span v-if="activeTurns[t.id]" class="lp-working" aria-label="正在工作" /><small>{{ dateLabel(t.updatedAtIso) }}</small>
          </button>
        </section>
        <p v-if="!groups.length" class="lp-library-empty">{{ loadingLibrary ? '正在读取原窗口的项目和会话…' : ready ? '选择项目，开始新会话。' : stateHint }}</p>
        <button v-if="listCursor" class="lp-more" :disabled="loadingLibrary" @click="loadThreads(true)">加载更早的会话</button>
      </div>
      <footer><select v-model="projectCwd" aria-label="新会话所在项目"><option value="">选择项目</option><option v-for="p in projects" :key="p.path" :value="p.path">{{ p.name }}</option></select><button class="lp-new" :disabled="!ready || !projectCwd || busy" @click="newThread(projectCwd)">＋ 新会话</button></footer>
    </aside>
    <main class="lp-conversation">
      <header class="lp-chat-header"><button class="lp-back" @click="chatOpen = false" aria-label="返回会话列表">‹</button><div><h1>{{ currentTitle }}</h1><p>{{ currentCwd ? projectName(currentCwd) : '在电脑与手机间继续同一会话' }}</p></div><details v-if="threadId" class="lp-actions"><summary aria-label="会话操作">•••</summary><div><button @click="refreshCurrent">刷新会话</button><button @click="renameThread">重命名</button><button @click="forkThread()">分支会话</button><button @click="archiveThread">归档</button><button @click="exportChat">导出会话</button></div></details></header>
      <div class="lp-chat-status"><span>{{ activeTurn ? '正在工作' : threadId ? '已同步' : stateLabel }}</span><span>{{ desktopControl ? '原 Codex 窗口' : sharedControl ? '备用共享窗口' : '本机 Codex' }}</span></div>
      <p v-if="feedback" class="lp-feedback" role="status">{{ feedback }}<button @click="feedback = ''" aria-label="关闭提示">×</button></p>
      <template v-if="threadId">
        <ThreadConversation :messages="messages" :pending-requests="selectedApprovals" :live-overlay="liveOverlay" :is-loading="loadingChat" :active-thread-id="threadId" :cwd="currentCwd" :has-more-persisted-above="Boolean(historyCursor)" :is-loading-persisted-above="loadingEarlier" :load-earlier-messages="loadEarlier" :allow-file-actions="false" @fork-thread="forkThread($event.turnIndex)" @rollback="rollback($event.turnId)" @respond-server-request="respondApproval" />
        <div class="lp-compose-area">
          <p v-if="editingQueue" class="lp-edit-queue">正在修改排队消息 <button @click="cancelQueueEdit">取消</button></p>
          <QueuedMessages :messages="queueRows" @edit="editQueue" @delete="deleteQueue" @steer="startQueue" @reorder="reorderQueue" />
          <ThreadPendingRequestPanel v-if="selectedApprovals.length" :request="selectedApprovals[0]!" :request-count="selectedApprovals.length" :has-queue-above="queueRows.length > 0" :single-turn-only="true" :is-responding="respondingApproval" @respond-server-request="respondApproval" />
          <ThreadComposer v-show="!selectedApprovals.length" :key="`${deviceId}:${threadId}`" ref="composer" :active-thread-id="threadId" :cwd="currentCwd" :models="models" :selected-model="selectedModel" :selected-reasoning-effort="selectedEffort" selected-collaboration-mode="default" selected-speed-mode="standard" :is-turn-in-progress="Boolean(activeTurn)" :is-interrupting-turn="interrupting" :disabled="!canControl || busy || loadingChat" :has-queue-above="queueRows.length > 0" :send-with-enter="true" in-progress-submit-mode="queue" :remote-mode="true" @submit="submit" @interrupt="interrupt" @update:selected-model="selectedModel = $event" @update:selected-reasoning-effort="selectedEffort = $event" />
          <p class="lp-compose-hint">{{ canControl ? '输入与操作同步到电脑上的同一会话' : ready ? '请在电脑的 LanPower 连接原 Codex 窗口后继续此会话' : stateHint }}</p>
        </div>
      </template>
      <div v-else class="lp-welcome"><div>✳</div><h2>继续你的工作</h2><p>选择最近会话，或在项目中新建会话。</p><p v-if="!ready">{{ stateHint }}</p></div>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import ThreadConversation from './components/content/ThreadConversation.vue'
import ThreadComposer, { type SubmitPayload, type ThreadComposerExposed } from './components/content/ThreadComposer.vue'
import QueuedMessages from './components/content/QueuedMessages.vue'
import ThreadPendingRequestPanel from './components/content/ThreadPendingRequestPanel.vue'
import { normalizeThreadGroupsV2, normalizeThreadMessagesV2 } from './api/normalizers/v2'
import type { ReasoningEffort, UiServerRequest, UiLiveOverlay } from './types/codex'
import { connection, type RpcEvent } from './lanpower/connection'

const config = JSON.parse(document.getElementById('lanpower-codex-config')?.textContent || '{"devices":[]}')
const devices: Array<{ id: string; name: string }> = config.devices
const deviceId = ref(''), state = ref('idle'), threadId = ref(''), search = ref(''), chatOpen = ref(false)
const ready = computed(() => state.value === 'runtime_ready')
const threads = shallowRef<any[]>([]), current = shallowRef<any>(null), projects = ref<Array<{ name: string; path: string }>>([])
const projectCwd = ref(''), listCursor = ref(''), historyCursor = ref(''), models = ref<string[]>([])
const selectedModel = ref(''), selectedEffort = ref<ReasoningEffort | ''>('')
const desktopControl = ref(false), sharedControl = ref(false), queueSupported = ref(false)
const activeTurns = ref<Record<string, string>>({}), approvals = ref<UiServerRequest[]>([])
const queue = ref<any[]>([]), editingQueue = ref(''), composer = ref<ThreadComposerExposed | null>(null)
const loadingChat = ref(false), loadingLibrary = ref(false), loadingEarlier = ref(false), busy = ref(false), interrupting = ref(false)
const feedback = ref(''), powerText = ref(''), wakeAvailable = ref(false), waking = ref(false)
const respondingApproval = ref(false)
const overlay = ref<UiLiveOverlay>({ activityLabel: '', activityDetails: [], reasoningText: '', errorText: '' })
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
const groups = computed(() => normalizeThreadGroupsV2({ data: threads.value.filter(t => !search.value || `${t.name || ''} ${t.preview || ''} ${t.cwd || ''}`.toLowerCase().includes(search.value.toLowerCase())), nextCursor: null } as any))
const messages = computed(() => current.value ? normalizeThreadMessagesV2({ thread: current.value } as any) : [])
const selectedApprovals = computed(() => approvals.value.filter(a => a.threadId === threadId.value))
const liveOverlay = computed(() => activeTurn.value || overlay.value.errorText ? overlay.value : null)
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
  if (!ready.value) { epoch++; busy.value = false; syncing = false; resetApprovals(); queue.value = []; overlay.value = { activityLabel: '', activityDetails: [], reasoningText: '', errorText: '' } }
  else if (!wasReady) void restore()
}
async function restore(): Promise<void> {
  const e = epoch
  try {
    const [status, modelList] = await Promise.all([connection.request('lanpower/status'), connection.request('model/list', { limit: 50 })])
    if (e !== epoch || !ready.value) return
    applyStatus(status)
    models.value = (modelList.data || []).map((m: any) => m.id || m.model).filter(Boolean)
    selectedModel.value = models.value.includes(selectedModel.value) ? selectedModel.value : (modelList.data || []).find((m: any) => m.isDefault)?.id || models.value[0] || ''
    await loadThreads()
    if (threadId.value) await selectThread(threadId.value, true)
  } catch (error) { if (e === epoch) showError(error) }
}
function applyStatus(status: any): void {
  desktopControl.value = Boolean(status.desktopControl); sharedControl.value = Boolean(status.sharedControl); queueSupported.value = Boolean(status.queueSupported)
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
    const result = await connection.request('thread/list', { limit: 50, ...(more && listCursor.value ? { cursor: listCursor.value } : {}) })
    if (e !== epoch) return
    const all = more ? [...threads.value, ...result.data] : result.data
    threads.value = [...new Map(all.map((t: any) => [t.id, t])).values()].slice(0, 500)
    listCursor.value = threads.value.length < 500 ? result.nextCursor || '' : ''
  } catch (error) { if (e === epoch) showError(error) } finally { loadingLibrary.value = false }
}
async function selectThread(id: string, restoring = false): Promise<void> {
  if (!ready.value || busy.value) return
  if (!restoring && id !== threadId.value && composer.value?.hasUnsavedDraft() && !confirm('切换会话将清空当前未发送的草稿，继续吗？')) return
  const e = epoch, s = ++selection
  threadId.value = id; chatOpen.value = true; loadingChat.value = true; current.value = null; queue.value = []; editingQueue.value = ''; historyCursor.value = ''
  overlay.value = { activityLabel: '', activityDetails: [], reasoningText: '', errorText: '' }
  try {
    const result = await connection.request('thread/read', { threadId: id, includeTurns: true })
    if (e !== epoch || s !== selection) return
    current.value = result.thread; historyCursor.value = result.thread.historyCursor || ''
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
async function loadEarlier(id: string): Promise<void> {
  if (id !== threadId.value || !historyCursor.value || loadingEarlier.value || !ready.value) return
  const e = epoch, s = selection; loadingEarlier.value = true
  try {
    const result = await connection.request('thread/turns/list', { threadId: id, cursor: historyCursor.value, limit: 8 })
    if (e !== epoch || s !== selection || !current.value) return
    const existing = new Set(current.value.turns.map((t: any) => t.id))
    const older = result.data.slice().reverse().filter((t: any) => !existing.has(t.id))
    current.value = { ...current.value, turns: [...older, ...current.value.turns] }
    historyCursor.value = current.value.turns.length < 128 ? result.nextCursor || '' : ''
  } catch (error) { if (e === epoch && s === selection) showError(error) } finally { loadingEarlier.value = false }
}
async function refreshQueue(id = threadId.value, e = epoch, s = selection): Promise<void> {
  if (!queueSupported.value || !id) return
  const result = await connection.request('thread/queue/list', { threadId: id, limit: 32 })
  if (e === epoch && s === selection && id === threadId.value) queue.value = result.data || []
}
async function refreshCurrent(): Promise<void> {
  if (!ready.value || !threadId.value || loadingChat.value || busy.value || syncing) return
  const e = epoch, s = selection, id = threadId.value; syncing = true
  try {
    const [result, status] = await Promise.all([connection.request('thread/read', { threadId: id, includeTurns: true }), connection.request('lanpower/status')])
    if (e !== epoch || s !== selection) return
    const latest = result.thread.turns || [], latestIds = new Set(latest.map((t: any) => t.id))
    const previous = current.value?.turns || [], boundary = previous.findIndex((t: any) => t.id === latest[0]?.id)
    const older = boundary > 0 ? previous.slice(0, boundary).filter((t: any) => !latestIds.has(t.id)) : []
    current.value = { ...result.thread, turns: [...older, ...latest].slice(-128) }; applyStatus(status); observeTurn(current.value)
    await refreshQueue(id, e, s)
  } catch (error) { if (e === epoch && s === selection) showError(error) } finally { syncing = false }
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
    if (payload.fileAttachments.length || payload.skills.length) throw new Error('请在原窗口添加电脑文件或技能。')
    const input = [...(payload.text.trim() ? [{ type: 'text', text: payload.text.trim() }] : []), ...payload.imageUrls.map(url => ({ type: 'image', url }))]
    if (editingQueue.value) await connection.request('thread/queue/update', { threadId: id, queuedSubmissionId: editingQueue.value, input })
    else if (activeTurn.value && payload.mode === 'queue') await connection.request('thread/queue/add', { threadId: id, clientUserMessageId: crypto.randomUUID(), input })
    else if (activeTurn.value) await connection.request('turn/steer', { threadId: id, expectedTurnId: activeTurn.value, input })
    else {
      const result = await connection.request('turn/start', { threadId: id, input, ...(selectedModel.value ? { model: selectedModel.value } : {}), ...(selectedEffort.value ? { effort: selectedEffort.value } : {}) })
      if (e === epoch && s === selection && result.turn?.id) activeTurns.value = { ...activeTurns.value, [id]: result.turn.id }
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
  const name = prompt('会话名称', currentTitle.value)?.trim(); if (!name || !canControl.value) return
  try { await connection.request('thread/name/set', { threadId: threadId.value, name: name.slice(0, 1000) }); await refreshCurrent(); await loadThreads() } catch (error) { showError(error) }
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
  try { const result = await connection.request('thread/rollback', { threadId: threadId.value, numTurns: current.value.turns.length - index }); current.value = result.thread; historyCursor.value = ''; feedback.value = '对话已回退，已有文件修改保留。' } catch (error) { showError(error) } finally { busy.value = false }
}
async function archiveThread(): Promise<void> {
  if (!canControl.value || activeTurn.value || !confirm('归档当前会话？')) return
  try { await connection.request('thread/archive', { threadId: threadId.value }); threadId.value = ''; current.value = null; chatOpen.value = false; await loadThreads() } catch (error) { showError(error) }
}
function exportChat(): void {
  const data = messages.value.map(m => `${m.role === 'user' ? '你' : 'Codex'}：\n${m.text}`).join('\n\n')
  const url = URL.createObjectURL(new Blob([`${currentTitle.value}\n\n${data}`], { type: 'text/plain;charset=utf-8' }))
  const link = document.createElement('a'); link.href = url; link.download = 'codex-conversation.txt'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
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
  if (event.method === 'turn/started') activeTurns.value = { ...activeTurns.value, [id]: p.turn?.id }
  if (event.method === 'turn/completed') { const next = { ...activeTurns.value }; delete next[id]; activeTurns.value = next }
  if (event.method === 'thread/name/updated') { threads.value = threads.value.map(t => t.id === id ? { ...t, name: p.threadName || p.name } : t); if (current.value?.id === id) current.value = { ...current.value, name: p.threadName || p.name } }
  if (id !== threadId.value || !current.value) return
  if (event.method === 'thread/queue/changed') { void refreshQueue().catch(showError); return }
  const turns = current.value.turns || (current.value.turns = [])
  if (event.method === 'turn/started' || event.method === 'turn/completed') {
    let turn = turns.find((t: any) => t.id === p.turn?.id)
    if (!turn) { turn = { ...p.turn, items: p.turn?.items || [] }; turns.push(turn) } else Object.assign(turn, p.turn, { items: p.turn?.items?.length ? p.turn.items : turn.items })
    overlay.value = { activityLabel: event.method === 'turn/started' ? '正在工作' : '', activityDetails: [], reasoningText: '', errorText: p.turn?.error?.message || '' }
  } else if (event.method === 'item/started' || event.method === 'item/completed' || event.method.endsWith('/delta') || event.method.endsWith('/outputDelta')) {
    let turn = turns.find((t: any) => t.id === p.turnId)
    if (!turn) { turn = { id: p.turnId, status: 'inProgress', items: [] }; turns.push(turn) }
    const itemId = p.item?.id || p.itemId
    let item = turn.items.find((i: any) => i.id === itemId)
    if (p.item) { if (item) Object.assign(item, p.item); else turn.items.push(p.item) }
    else if (event.method === 'item/agentMessage/delta') {
      if (!item) { item = { id: itemId, type: 'agentMessage', text: '' }; turn.items.push(item) }
      item.text = `${item.text || ''}${p.delta || ''}`.slice(-64000)
    } else if (event.method === 'item/commandExecution/outputDelta' && item) item.aggregatedOutput = `${item.aggregatedOutput || ''}${p.delta || ''}`.slice(-64000)
  } else if (event.method === 'turn/plan/updated') overlay.value = { ...overlay.value, activityDetails: (p.plan || []).map((step: any) => `${step.status === 'completed' ? '✓' : '○'} ${step.step}`) }
  else if (event.method === 'error') overlay.value = { ...overlay.value, errorText: p.error?.message || '任务出错，请查看原窗口。' }
  // Many token notifications share one render, keeping long conversations responsive.
  if (!streamFrame) streamFrame = requestAnimationFrame(() => { streamFrame = 0; if (current.value) current.value = { ...current.value, turns: current.value.turns.slice(-128) } })
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
  loadingChat.value = false; loadingLibrary.value = false; busy.value = false
  connection.connect(id); if (!id) state.value = 'idle'; else void updatePower()
}
function reconnect(): void { connection.connect(deviceId.value) }
function toggleTheme(): void { const dark = document.documentElement.classList.toggle('dark'); try { localStorage.setItem('lanpower-codex-theme', dark ? 'dark' : 'light') } catch {} }
onMounted(() => {
  try { document.documentElement.classList.toggle('dark', localStorage.getItem('lanpower-codex-theme') === 'dark') } catch {}
  connection.onEvent = onEvent; connection.onState = onState
  if (devices.length) changeDevice(devices[0]!.id)
  polling = setInterval(() => { if (document.visibilityState === 'visible') { void updatePower(); void refreshCurrent() } }, 8000)
})
onBeforeUnmount(() => { clearInterval(polling); cancelAnimationFrame(streamFrame); connection.stop() })
</script>
