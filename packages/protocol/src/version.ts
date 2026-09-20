export const PROTOCOL_VERSION = 1
export const PROFILE_VERSION_HEADER = 'x-laurencio-profile-version'
export const CURRENT_PROFILE_VERSION = 2

export type ProtocolCompatibility = { ok: true } | { ok: false; reason: string }

export function checkProtocolVersion(remote: number): ProtocolCompatibility {
  if (remote === PROTOCOL_VERSION) return { ok: true }
  if (remote > PROTOCOL_VERSION) {
    return {
      ok: false,
      reason: `server speaks protocol v${remote}, this client speaks v${PROTOCOL_VERSION}. Upgrade the client.`,
    }
  }
  return {
    ok: false,
    reason: `server speaks protocol v${remote}, this client speaks v${PROTOCOL_VERSION}. Upgrade the server.`,
  }
}
