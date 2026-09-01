/** Model-visible environment snapshot content. */

import { describe, expect, it } from 'vitest'
import { ServerBindingId, ServerDeviceId } from '../src/environments.ts'
import { renderContext } from '../src/environment-context.ts'

describe('server environment context', () => {
  it('states every environment, the active binding, epoch, platform, shell, and no-sync rule', () => {
    const text = renderContext({
      sessionId: 'session-1',
      activeBindingId: ServerBindingId('local:desktop-1'),
      environmentEpoch: 7,
      environments: [
        {
          bindingId: ServerBindingId('cloud'), environmentId: 'cloud', type: 'cloud', status: 'online',
          rootPath: '/cloud/alpha', platform: 'linux', arch: 'x64', shell: 'bash',
          capabilities: ['filesystem', 'subprocess', 'shell'],
        },
        {
          bindingId: ServerBindingId('local:desktop-1'), environmentId: 'local:desktop-1',
          type: 'local', status: 'online', rootPath: 'D:\\projects\\alpha',
          deviceId: ServerDeviceId('desktop-1'), deviceName: 'Alice PC',
          platform: 'win32', arch: 'x64', shell: 'powershell',
          capabilities: ['filesystem', 'subprocess'],
        },
      ],
    })

    expect(text).toContain('epoch 7')
    expect(text).toContain('cloud; available; status=online; platform=linux; arch=x64; shell=bash')
    expect(text).toContain('local:desktop-1: local device "Alice PC"; ACTIVE')
    expect(text).toContain('platform=win32; arch=x64; shell=powershell; root="D:\\\\projects\\\\alpha"')
    expect(text).toContain('capabilities=filesystem,subprocess,shell')
    expect(text).toContain('never synchronized implicitly')
    expect(text).toContain('always requires the user to approve')
  })
})
