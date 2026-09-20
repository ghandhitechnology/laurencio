import type { CommandSpec } from './command'
import { initCommand } from './init'

/** Full-mode enrollment. `init` remains as a compatibility alias for v1 clients. */
export const enrollCommand: CommandSpec = {
  ...initCommand,
  name: 'enroll',
  summary: 'Migrate this device into the synced workbench',
  usage:
    'laurencio enroll [--server <url>] [--device-name <name>] [--passphrase-file <path>] [--yes] [--json]',
  details: [
    'Creates a backup, applies the selected agent-workbench surfaces, and enables full sync.',
  ],
}
