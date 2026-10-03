import { describe, expect, it } from 'vitest'
import { normalizeThreadMessagesV2 } from '../src/api/normalizers/v2'
import { presentConversation } from '../src/lanpower/conversationPresentation'

const user = {id: 'user', type: 'userMessage', content: [{type: 'text', text: '开始工作'}]}
const commentary = {id: 'commentary', type: 'agentMessage', phase: 'commentary', text: '正在检查文件'}
const final = {id: 'final', type: 'agentMessage', phase: 'final_answer', text: '已完成'}
const command = (id = 'command', exitCode = 0) => ({id, type: 'commandExecution', status: 'completed', command: 'fixture-command', aggregatedOutput: '完整输出末尾', exitCode})
const file = {id: 'file', type: 'fileChange', status: 'completed', changes: [{path: 'README.md', kind: {type: 'update'}, diff: '@@ -1 +1 @@\n-old\n+new'}]}
const reasoning = {id: 'reasoning', type: 'reasoning', summary: ['公开的工作摘要'], content: ['不公开的内容']}
function normalize(items: unknown[], status = 'completed', timing = {}, id = 'turn') {
  return normalizeThreadMessagesV2({thread: {turns: [{id, status, items, ...timing}]}} as any)
}

describe('conversation process folding', () => {
  it('preserves desktop phase, turn status and actual duration through normalization', () => {
    expect(normalize([final], 'completed', {durationMs: 65000})[1]).toMatchObject({agentPhase: 'final_answer', turnStatus: 'completed', turnDurationMs: 65000})
  })

  it('collapses a command/file sequence into one summary and keeps full member data accessible', () => {
    const source = normalize([user, commentary, command(), file, command('failed', 2)], 'inProgress')
    const collapsed = presentConversation(source)
    const group = collapsed.messages.find(message => message.activitySummary)!
    expect(group.activitySummary).toMatchObject({label: '编辑了文件，运行了命令', hasFiles: true, notice: '含失败命令', expanded: false})
    expect(collapsed.messages.map(message => message.id)).toEqual(['user', 'commentary', group.id])
    const expanded = presentConversation(source, new Set(), new Set([group.id]))
    expect(expanded.messages.find(message => message.id === 'command')?.commandExecution?.aggregatedOutput).toBe('完整输出末尾')
    expect(expanded.messages.find(message => message.id === 'file')?.fileChanges?.[0]?.diff).toContain('+new')
    expect(expanded.activityMemberIds.size).toBe(3)
  })

  it('automatically folds commentary, reasoning and activities when a final answer completes', () => {
    const source = normalize([user, commentary, command(), reasoning, final], 'completed', {durationMs: 2659000})
    const before = JSON.stringify(source)
    const result = presentConversation(source)
    expect(result.messages.map(message => message.text)).toEqual(['开始工作', '用时 44分钟 19秒', '已完成'])
    expect(result.messages[1]?.turnProcess).toMatchObject({expanded: false})
    expect([...result.finalMessageIds]).toEqual(['final'])
    expect(result.processMessageIds.has('commentary')).toBe(true)
    expect(JSON.stringify(source)).toBe(before)
  })

  it('supports independent outer process and inner activity expansion', () => {
    const source = normalize([user, commentary, command(), reasoning, final])
    const collapsed = presentConversation(source)
    const processId = [...collapsed.processIds][0]!
    const activityId = [...collapsed.activityIds][0]!
    const process = presentConversation(source, new Set([processId]))
    expect(process.messages.some(message => message.id === 'reasoning')).toBe(true)
    expect(process.messages.some(message => message.id === 'command')).toBe(false)
    const all = presentConversation(source, new Set([processId]), new Set([activityId]))
    expect(all.messages.some(message => message.id === 'command')).toBe(true)
    expect(all.messages.find(message => message.id === 'reasoning')?.text).toBe('公开的工作摘要')
    expect(all.messages.some(message => message.text.includes('不公开的内容'))).toBe(false)
  })

  it.each(['inProgress', 'failed', 'interrupted'])('does not auto-hide a %s turn behind a final-answer fold', status => {
    const result = presentConversation(normalize([user, commentary, command(), final], status))
    expect(result.processIds.size).toBe(0)
    expect(result.messages.some(message => message.id === 'commentary')).toBe(true)
  })

  it('does not mistake phase-aware commentary or an empty final for a finished answer', () => {
    expect(presentConversation(normalize([user, commentary, command()])).processIds.size).toBe(0)
    expect(presentConversation(normalize([user, commentary, command(), {...final, text: ''}])).processIds.size).toBe(0)
  })

  it('supports old histories without phase and without invented timing', () => {
    const source = normalize([user, {...commentary, phase: undefined}, command(), {...final, phase: undefined}])
    const result = presentConversation(source)
    expect(result.messages.map(message => message.text)).toEqual(['开始工作', '查看工作过程', '已完成'])
    expect(presentConversation(source.map(message => ({...message, turnStatus: undefined}))).processIds.size).toBe(0)
    expect(presentConversation(normalize([user, {...commentary, phase: undefined}, command()])).processIds.size).toBe(0)
  })

  it('keeps generated images and all explicit final parts outside the process', () => {
    const source = normalize([user, commentary, command(), final, {...final, id: 'final-two', text: '补充结果'}, {...commentary, id: 'later-commentary'}])
    source.splice(3, 0, {id: 'image', role: 'assistant', text: '', messageType: 'imageView', images: ['data:image/png;base64,fixture'], turnId: 'turn', turnIndex: 0, turnStatus: 'completed'})
    const result = presentConversation(source)
    expect(result.messages.filter(message => message.role === 'assistant').map(message => message.id)).toEqual(['image', 'final', 'final-two'])
  })

  it('keeps group keys stable during streaming and does not group across commentary or turns', () => {
    const first = normalize([user, command()], 'inProgress')
    const key = [...presentConversation(first).activityIds][0]!
    const updated = normalize([user, command(), command('new'), commentary, command('after-commentary')], 'inProgress')
    const result = presentConversation([...updated, ...normalize([command('another-turn')], 'inProgress', {}, 'other')], new Set(), new Set([key]))
    expect(result.activityIds.size).toBe(3)
    expect(result.messages.find(message => message.id === key)?.activitySummary?.expanded).toBe(true)
    expect(result.messages.some(message => message.id === 'new')).toBe(true)
  })

  it('projects long histories before the display window without truncating the process', () => {
    const source = normalize([user, commentary, ...Array.from({length: 180}, (_, index) => command(`command-${index}`)), final])
    const collapsed = presentConversation(source)
    expect(collapsed.messages).toHaveLength(3)
    const expanded = presentConversation(source, collapsed.processIds, collapsed.activityIds)
    expect(expanded.messages.filter(message => message.commandExecution)).toHaveLength(180)
    expect(expanded.messages.some(message => message.id === 'user')).toBe(true)
    expect(expanded.messages.some(message => message.id === 'final')).toBe(true)
  })
})
