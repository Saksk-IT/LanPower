import type { UiMessage } from '../types/codex'
import { withoutPlanMessages } from '../utils/planProgress'
import { formatWorkDuration } from './turnPresentation'

export type ActivitySummary = {
  id: string
  label: string
  hasFiles: boolean
  notice: string
  expanded: boolean
}

export type ConversationMessage = UiMessage & {
  activitySummary?: ActivitySummary
  turnProcess?: { id: string; expanded: boolean }
}

function turnKey(message: UiMessage): string {
  return message.turnId || (typeof message.turnIndex === 'number' ? `index:${message.turnIndex}` : `message:${message.id}`)
}

function isActivity(message: UiMessage): boolean {
  return (message.messageType === 'commandExecution' && !!message.commandExecution)
    || (message.messageType === 'fileChange' && (message.fileChanges?.length ?? 0) > 0)
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
    // Generated images are deliverables even when the following answer has no text.
    ...messages.filter(message => message.role === 'assistant' && (message.images?.length ?? 0) > 0).map(message => message.id),
  ])
}

/** A display projection only: never mutate the history used by export or reconciliation. */
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
      && message.messageType !== 'turnError' && !finals.has(message.id))
    const canFold = first.turnStatus === 'completed' && finals.size > 0 && process.length > 0
    const processId = `process:${turnKey(first)}`
    const processExpanded = expandedTurns.has(processId)
    if (canFold) {
      processIds.add(processId)
      finals.forEach(id => finalMessageIds.add(id))
      process.forEach(message => processMessageIds.add(message.id))
    }

    // Group across command/file events, but never across commentary or a turn boundary.
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
      const running = commands.some(command => command.status === 'inProgress')
      const failed = commands.some(command => command.status === 'failed'
        || (command.status === 'completed' && command.exitCode !== null && command.exitCode !== 0))
      const stopped = commands.some(command => command.status === 'interrupted' || command.status === 'declined')
      const label = running ? '正在运行命令' : hasFiles
        ? commands.length ? '编辑了文件，运行了命令' : '编辑了文件'
        : '运行了命令'
      const expanded = expandedActivities.has(id)
      grouped.push({
        ...message, id, role: 'system', messageType: 'activityGroup', text: label,
        commandExecution: undefined, fileChanges: undefined,
        activitySummary: {id, label, hasFiles, expanded, notice: failed ? '含失败命令' : stopped ? '含停止或拒绝的命令' : ''},
      })
      if (expanded) grouped.push(...members)
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
      if (message.role === 'user' || finals.has(message.id) || message.messageType === 'turnError' || processExpanded) messages.push(message)
    }
  }
  return {messages, activityIds, activityMemberIds, processIds, finalMessageIds, processMessageIds}
}
