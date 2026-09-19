import type { HarnessAdapter } from '../../types'
import { detectClaude } from './detect'
import { claudeSurfaces } from './surfaces'

export * from './detect'
export * from './surfaces'
export * from './transforms'

export const claudeAdapter: HarnessAdapter = {
  id: 'claude',
  displayName: 'Claude Code',
  detect: detectClaude,
  surfaces: claudeSurfaces,
}
