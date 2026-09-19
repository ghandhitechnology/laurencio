import type { HarnessAdapter } from '../../types'
import { codexDetect } from './detect'
import { codexSurfaces } from './surfaces'

export const codexAdapter: HarnessAdapter = {
  id: 'codex',
  displayName: 'Codex CLI',
  detect: codexDetect,
  surfaces: codexSurfaces,
}

export * from './detect'
export * from './surfaces'
export * from './transforms'
