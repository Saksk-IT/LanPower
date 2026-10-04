import { describe, expect, it } from 'vitest'
import { newSettings, observeSettings } from '../src/lanpower/settings'
import { permissionMode } from '../src/lanpower/permissions'

const cwd = 'D:/Work/Project'
const ask = {approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:{type:'workspaceWrite',networkAccess:false,writableRoots:[cwd]}}
describe('native conversation permissions', () => {
  it('reads native modes and keeps missing or custom policies distinct', () => {
    expect(permissionMode(null,cwd)).toBe('unknown')
    expect(permissionMode({approvalPolicy:'on-request',sandbox:ask.sandbox},cwd)).toBe('unknown')
    expect(permissionMode(ask,cwd)).toBe('ask')
    expect(permissionMode({...ask,approvalsReviewer:'auto_review'},cwd)).toBe('auto-review')
    expect(permissionMode({...ask,approvalPolicy:'never',sandbox:{type:'dangerFullAccess'}},cwd)).toBe('full-access')
    expect(permissionMode({...ask,sandbox:{...ask.sandbox,networkAccess:true}},cwd)).toBe('custom')
    expect(permissionMode({...ask,sandbox:{...ask.sandbox,writableRoots:['D:/Other']}},cwd)).toBe('custom')
    expect(permissionMode({...ask,approvalPolicy:{granular:{sandbox_approval:false}}},cwd)).toBe('custom')
    expect(permissionMode({...ask,activePermissionProfile:{id:'company-profile',extends:null}},cwd)).toBe('custom')
  })
  it('follows native notifications and refresh without transferring permissions between threads', () => {
    const one = newSettings(), two = newSettings()
    observeSettings(one,ask,'gpt-6')
    observeSettings(one,{approvalsReviewer:'auto_review',sandboxPolicy:ask.sandbox,effort:'high'},'gpt-6')
    expect(permissionMode(one.permissions,cwd)).toBe('auto-review')
    expect(one.native.effort).toBe('high')
    expect(permissionMode(two.permissions,cwd)).toBe('unknown')
    observeSettings(one,{approvalPolicy:'never',approvalsReviewer:'user',sandbox:{type:'dangerFullAccess'}},'gpt-6')
    expect(permissionMode(one.permissions,cwd)).toBe('full-access')
    expect(one.overrides).toEqual({})
    observeSettings(one,{id:'one',model:'gpt-6'},'gpt-6')
    expect(permissionMode(one.permissions,cwd)).toBe('unknown')
  })
})
