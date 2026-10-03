import type { ReasoningEffort } from '../types/codex'

export type ModelCapability = { id?: string; model?: string; displayName?: string; isDefault?: boolean; defaultReasoningEffort?: ReasoningEffort; supportedReasoningEfforts?: Array<{reasoningEffort: ReasoningEffort; description?: string}> }
export type SendSettings = { model: string; effort: ReasoningEffort | ''; mode: 'default' | 'plan' }
export type ThreadSettings = { native: SendSettings; overrides: Partial<SendSettings>; initialized: boolean }
export const blankSettings = (): SendSettings => ({model:'',effort:'',mode:'default'})
export const newSettings = (): ThreadSettings => ({native:blankSettings(),overrides:{},initialized:false})
export function observeSettings(state: ThreadSettings, thread: any, fallback: string): void {
  if (!state.initialized) { state.native = {...blankSettings(),model:fallback}; state.initialized = true }
  if (thread.model) state.native.model = thread.model
  if ('reasoningEffort' in thread) state.native.effort = thread.reasoningEffort || ''
  const mode = thread.collaborationMode?.mode || thread.collaborationMode
  if (mode === 'default' || mode === 'plan') state.native.mode = mode
}
export function effectiveSettings(state: ThreadSettings): SendSettings { return {...state.native,...state.overrides} }
export function modelId(model: ModelCapability): string { return model.model || model.id || '' }
export function validEfforts(model?: ModelCapability): ReasoningEffort[] {
  return (model?.supportedReasoningEfforts || []).map(e => e.reasoningEffort)
}
