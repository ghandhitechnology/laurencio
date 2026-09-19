import type { HarnessAdapter } from '../../types'
import { detectOpenCode } from './detect'
import { opencodeSurfaces } from './surfaces'

export const opencodeAdapter: HarnessAdapter = {
  id: 'opencode',
  displayName: 'OpenCode',
  detect: (ctx) => {
    const report = detectOpenCode(ctx)
    return {
      installed: report.installed,
      ...(report.version === null ? {} : { version: report.version }),
      configRoots: report.configRoots,
      notes: report.notes,
    }
  },
  surfaces: opencodeSurfaces,
}

export * from './detect'
export * from './surfaces'
export * from './transforms'
