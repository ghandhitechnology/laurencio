import type { DevicePolicy } from '@laurencio/core'
import type { CommandContext } from './context'
import { askChoice, askYesNo, interactive } from './prompt'

export type SetupScope = 'existing' | 'skills' | 'portable' | 'custom'

export interface SetupSurface {
  id: string
  harness: string
  policy: string
  description: string
}

export interface SetupScopeResult {
  policy: DevicePolicy
  scope: SetupScope
}

const MACHINE_INSTRUCTION_SURFACES = new Set([
  'claude.instructions',
  'claude.rules',
  'codex.instructions',
  'codex.instructions-override',
  'opencode.instructions',
  // This mixed source can contain a machine-specific AGENTS.md beside skills.
  'opencode.source',
])

function copyPolicy(policy: DevicePolicy): DevicePolicy {
  const harnesses: DevicePolicy['harnesses'] = {}
  for (const [id, harness] of Object.entries(policy.harnesses)) {
    if (harness === undefined) continue
    harnesses[id as 'claude' | 'codex' | 'opencode'] = {
      enabled: harness.enabled,
      surfaces: { ...harness.surfaces },
    }
  }
  return {
    version: policy.version,
    harnesses,
    ignore: [...policy.ignore],
    prune: policy.prune,
    cadence: { ...policy.cadence },
  }
}

function currentToggle(policy: DevicePolicy, surface: SetupSurface): 'on' | 'off' {
  const harness = policy.harnesses[surface.harness as 'claude' | 'codex' | 'opencode']
  const configured = harness?.surfaces[surface.id]
  if (configured === 'on' || configured === 'off') return configured
  return surface.policy === 'opt-in' ? 'off' : 'on'
}

function setToggle(policy: DevicePolicy, surface: SetupSurface, toggle: 'on' | 'off'): void {
  const harnessId = surface.harness as 'claude' | 'codex' | 'opencode'
  const harness = policy.harnesses[harnessId] ?? { enabled: true, surfaces: {} }
  harness.surfaces[surface.id] = toggle
  policy.harnesses[harnessId] = harness
}

function isSkillSurface(surface: SetupSurface): boolean {
  return surface.id.split(/[.-]/).includes('skills')
}

function isPortableDefault(surface: SetupSurface): boolean {
  return surface.policy === 'sync' && !MACHINE_INSTRUCTION_SURFACES.has(surface.id)
}

export function hasSurfaceChoices(policy: DevicePolicy): boolean {
  return Object.values(policy.harnesses).some(
    (harness) => harness !== undefined && Object.keys(harness.surfaces).length > 0,
  )
}

function applyPreset(
  policy: DevicePolicy,
  surfaces: readonly SetupSurface[],
  enabled: (surface: SetupSurface) => boolean,
): DevicePolicy {
  const next = copyPolicy(policy)
  for (const surface of surfaces) {
    if (surface.policy === 'never') continue
    setToggle(next, surface, enabled(surface) ? 'on' : 'off')
  }
  return next
}

/**
 * Gives a fresh device one safe, understandable scope decision. Existing local
 * choices remain the default, and scripted runs preserve their explicit policy.
 */
export async function chooseSetupScope(
  ctx: CommandContext,
  policy: DevicePolicy,
  surfaces: readonly SetupSurface[],
  enrolled = false,
): Promise<SetupScopeResult> {
  const configured = hasSurfaceChoices(policy)
  if (!interactive(ctx)) {
    if (configured || enrolled) return { policy: copyPolicy(policy), scope: 'existing' }
    return { policy: applyPreset(policy, surfaces, isSkillSurface), scope: 'skills' }
  }

  const options = configured
    ? [
        { key: 'k', label: 'keep current selection' },
        { key: 's', label: 'skills only' },
        { key: 'p', label: 'portable config, instructions stay local' },
        { key: 'c', label: 'choose each surface' },
      ]
    : [
        { key: 's', label: 'skills only' },
        { key: 'p', label: 'portable config, instructions stay local' },
        { key: 'c', label: 'choose each surface' },
      ]
  const choice = await askChoice(
    ctx,
    'What should this device sync?',
    options,
    configured ? 'k' : 's',
  )

  if (choice === 'k') return { policy: copyPolicy(policy), scope: 'existing' }
  if (choice === 's') {
    return { policy: applyPreset(policy, surfaces, isSkillSurface), scope: 'skills' }
  }
  if (choice === 'p') {
    return { policy: applyPreset(policy, surfaces, isPortableDefault), scope: 'portable' }
  }

  const custom = applyPreset(policy, surfaces, () => false)
  for (const surface of surfaces) {
    if (surface.policy === 'never') continue
    const selected = await askYesNo(
      ctx,
      `Sync ${surface.id} (${surface.description})?`,
      currentToggle(policy, surface) === 'on',
    )
    setToggle(custom, surface, selected ? 'on' : 'off')
  }
  return { policy: custom, scope: 'custom' }
}
