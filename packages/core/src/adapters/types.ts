import type { AdapterContext, AdapterDetection, HarnessAdapter, Surface } from '../types'

/** An adapter together with one of the surfaces it declared for a single context. */
export interface RegisteredSurface {
  adapter: HarnessAdapter
  surface: Surface
}

/** A detection result normalized for diagnostics: optional fields become explicit nulls. */
export interface DetectionReport {
  adapterId: HarnessAdapter['id']
  displayName: string
  installed: boolean
  version: string | null
  configRoots: string[]
  notes: string[]
}

export function detectionReport(adapter: HarnessAdapter, ctx: AdapterContext): DetectionReport {
  const detection: AdapterDetection = adapter.detect(ctx)
  return {
    adapterId: adapter.id,
    displayName: adapter.displayName,
    installed: detection.installed,
    version: detection.version ?? null,
    configRoots: [...detection.configRoots],
    notes: [...detection.notes],
  }
}
