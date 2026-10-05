import type { UiMessage } from '../types/codex'
import { withoutPlanMessages } from '../utils/planProgress'
import { formatWorkDuration } from './turnPresentation'

export type ActivitySummary = {
  id: string
  label: string
  hasFiles: boolean
  hasCommands: boolean
  hasSearches: boolean
  notice: string
  expanded: boolean
}

export type ConversationMessage = UiMessage & {
  activitySummary?: ActivitySummary
  activityGroupId?: string
  turnProcess?: { id: string; expanded: boolean }
}

function turnKey(message: UiMessage): string {
  return message.turnId || (typeof message.turnIndex === 'number' ? `index:${message.turnIndex}` : `message:${message.id}`)
}

function isActivity(message: UiMessage): boolean {
  return (message.messageType === 'commandExecution' && !!message.commandExecution)
    || (message.messageType === 'fileChange' && (message.fileChanges?.length ?? 0) > 0)
    || !!message.toolResult?.webSearch
    || (message.messageType === 'reasoning' && !!message.text.trim())
}

/** Place live timing after this turn's leading user messages, even in a clipped display window. */
export function liveWorkStartId(messages: UiMessage[]): string | undefined {
  const running = messages.filter(message => message.turnStatus === 'inProgress').at(-1)
  return running ? messages.find(message => turnKey(message) === turnKey(running) && message.role !== 'user')?.id : undefined
}

function finalAnswerIds(messages: UiMessage[]): Set<string> {
  const answers = messages.filter(message => message.role === 'assistant' && message.messageType === 'agentMessage' && message.text.trim())
  const explicitFinals = answers.filter(message => message.agentPhase === 'final_answer')
  const lastAnswer = answers.at(-1)
  const lastItem = messages.filter(message => message.messageType !== 'worked' && message.messageType !== 'turnError').at(-1)
  // A phase-aware commentary-only turn has no final answer yet. Keep its process visible.
  const final = explicitFinals.length ? explicitFinals : answers.some(message => message.agentPhase)
    ? [] : lastAnswer && lastItem?.id === lastAnswer.id ? [lastAnswer] : []
  return new Set([
    ...final.map(message => message.id),
    // Only generated results are deliverables. Viewed images and commentary belong to the process.
    ...messages.filter(message => message.role === 'assistant' && message.messageType === 'imageView'
      && message.imageAction === 'generate' && (message.images?.length ?? 0) > 0).map(message => message.id),
  ])
}

/** A display projection only: never mutate the original history used by reconciliation. */
export function presentConversation(
  source: UiMessage[],
  expandedTurns: ReadonlySet<string> = new Set(),
  expandedActivities: ReadonlySet<string> = new Set(),
) {
  const messages: ConversationMessage[] = []
  const activityIds = new Set<string>()
  const activityMemberIds = new Set<string>()
  const processIds = new Set<string>()
  const finalMessageIds = new Set<string>()
  const processMessageIds = new Set<string>()
  const turns: UiMessage[][] = []
  for (const message of withoutPlanMessages(source)) {
    const previous = turns.at(-1)
    if (previous && turnKey(previous[0]!) === turnKey(message)) previous.push(message)
    else turns.push([message])
  }

  for (const turn of turns) {
    const first = turn[0]!
    const finals = first.turnStatus === 'completed' ? finalAnswerIds(turn) : new Set<string>()
    const process = turn.filter(message => message.role !== 'user' && message.messageType !== 'worked'
      && message.messageType !== 'turnError' && !message.historyContent && !finals.has(message.id))
    const canFold = first.turnStatus === 'completed' && finals.size > 0 && process.length > 0
    const processId = `process:${turnKey(first)}`
    const processExpanded = expandedTurns.has(processId)
    if (canFold) {
      processIds.add(processId)
      finals.forEach(id => finalMessageIds.add(id))
      process.forEach(message => processMessageIds.add(message.id))
    }

    // Keep commands, files, web searches and public reasoning together in their original order.
    const grouped: ConversationMessage[] = []
    for (let index = 0; index < turn.length;) {
      const message = turn[index]!
      if (!isActivity(message)) { grouped.push(message); index++; continue }
      const members: UiMessage[] = []
      while (index < turn.length && isActivity(turn[index]!)) members.push(turn[index++]!)
      const id = `activity:${turnKey(first)}:${message.id}`
      activityIds.add(id)
      members.forEach(member => activityMemberIds.add(member.id))
      const commands = members.flatMap(member => member.commandExecution ? [member.commandExecution] : [])
      const hasFiles = members.some(member => member.messageType === 'fileChange')
      const searches = members.flatMap(member => member.toolResult?.webSearch ? [member.toolResult] : [])
      const running = commands.some(command => command.status === 'inProgress')
      const failed = commands.some(command => command.status === 'failed'
        || (command.status === 'completed' && command.exitCode !== null && command.exitCode !== 0))
      const stopped = commands.some(command => command.status === 'interrupted' || command.status === 'declined')
      const commandLabel = running ? '正在运行命令' : hasFiles
        ? commands.length ? '编辑了文件，运行了命令' : '编辑了文件'
        : commands.length ? '运行了命令' : ''
      const searchLabel = !searches.length ? '' : searches.some(search => search.status === 'inProgress') ? '正在搜索网页'
        : searches.every(search => search.status === 'failed') ? '网页搜索失败'
        : searches.every(search => search.status === 'interrupted') ? '网页搜索已停止' : '已搜索网页'
      const label = [commandLabel, searchLabel].filter(Boolean).join('，') || '思考过程'
      const searchNotice = searches.some(search => search.status === 'failed') ? '含失败搜索' : searches.some(search => search.status === 'interrupted') ? '含停止的搜索' : ''
      const expanded = expandedActivities.has(id)
      grouped.push({
        ...message, id, role: 'system', messageType: 'activityGroup', text: label,
        commandExecution: undefined, fileChanges: undefined, toolResult: undefined, rawPayload: undefined,
        activitySummary: {id, label, hasFiles, hasCommands: commands.length > 0, hasSearches: searches.length > 0, expanded, notice: [failed ? '含失败命令' : stopped ? '含停止或拒绝的命令' : '', searchNotice].filter(Boolean).join('，')},
      })
      if (expanded) grouped.push(...members.map(member => ({...member, activityGroupId: id})))
    }

    if (!canFold) {
      messages.push(...grouped.map(message => message.messageType === 'worked' && message.turnDurationMs !== undefined
        ? {...message, text: `用时 ${formatWorkDuration(message.turnDurationMs)}`} : message))
      continue
    }
    const worked = turn.find(message => message.messageType === 'worked')
    const header: ConversationMessage = {
      id: worked?.id ?? `worked:${turnKey(first)}`, role: 'system', messageType: 'worked',
      turnId: first.turnId, turnIndex: first.turnIndex, turnStatus: first.turnStatus,
      text: first.turnDurationMs === undefined ? '查看工作过程' : `用时 ${formatWorkDuration(first.turnDurationMs)}`,
      turnProcess: {id: processId, expanded: processExpanded},
    }
    let insertedHeader = false
    for (const message of grouped) {
      if (!insertedHeader && message.role !== 'user') { messages.push(header); insertedHeader = true }
      if (message.messageType === 'worked') continue
      if (message.role === 'user' || finals.has(message.id) || message.messageType === 'turnError' || message.historyContent || processExpanded) messages.push(message)
    }
  }
  return {messages, activityIds, activityMemberIds, processIds, finalMessageIds, processMessageIds}
}

/** Wrap visible members in one bounded list; a clipped member remains readable on its own. */
export function conversationBlocks(messages: ConversationMessage[]) {
  const blocks: {id: string; activity: boolean; expanded: boolean; messages: ConversationMessage[]}[] = []
  for (const message of messages) {
    const previous = blocks.at(-1)
    if (message.activityGroupId && previous?.id === message.activityGroupId) previous.messages.push(message)
    else blocks.push({id: message.id, activity: !!message.activitySummary, expanded: !!message.activitySummary?.expanded, messages: [message]})
  }
  return blocks
}
