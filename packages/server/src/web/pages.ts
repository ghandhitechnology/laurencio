export interface PageUser {
  name: string
  email: string
}

export interface LayoutOptions {
  title: string
  body: string
  user?: PageUser | null
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

const styles = `
  :root {
    color-scheme: light dark;
    --ink: #191b20;
    --muted: #5f6774;
    --line: #dcdfe4;
    --paper: #fcfcfb;
    --card: #ffffff;
    --accent: #2f4fd8;
    --danger: #a3231f;
  }
  @media (prefers-color-scheme: dark) {
    :root { --ink: #eceef2; --muted: #9aa1ad; --line: #33373f; --paper: #14161a; --card: #1b1e23; }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--paper);
    color: var(--ink);
    font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  main { max-width: 34rem; margin: 0 auto; padding: 3rem 1.25rem 4rem; }
  header.site { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 2rem; }
  header.site a { color: var(--ink); text-decoration: none; font-weight: 600; letter-spacing: -0.01em; }
  h1 { font-size: 1.3rem; margin: 0 0 0.4rem; letter-spacing: -0.01em; }
  h2 { font-size: 1rem; margin: 2rem 0 0.6rem; }
  p { margin: 0 0 1rem; }
  p.lede, .muted { color: var(--muted); }
  code, .code { font: 500 1.05rem/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 0.06em; }
  form { margin: 0 0 1rem; }
  label { display: block; font-size: 0.85rem; color: var(--muted); margin-bottom: 0.3rem; }
  input[type="text"], input[type="email"] {
    width: 100%; padding: 0.6rem 0.7rem; font: inherit; color: var(--ink);
    background: var(--card); border: 1px solid var(--line); border-radius: 6px;
  }
  .row { display: flex; gap: 0.6rem; align-items: center; flex-wrap: wrap; margin-top: 1rem; }
  button {
    font: inherit; padding: 0.5rem 0.9rem; border-radius: 6px; cursor: pointer;
    background: var(--card); color: var(--ink); border: 1px solid var(--line);
  }
  button.primary { background: var(--ink); color: var(--paper); border-color: var(--ink); }
  button.danger { color: var(--danger); border-color: var(--line); }
  .notice { padding: 0.7rem 0.85rem; border: 1px solid var(--line); border-radius: 6px; margin-bottom: 1.25rem; }
  .notice.error { color: var(--danger); }
  table { width: 100%; border-collapse: collapse; margin-top: 0.5rem; }
  th, td { text-align: left; padding: 0.6rem 0.35rem; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }
  td.actions { text-align: right; white-space: nowrap; }
  .revoked { color: var(--muted); text-decoration: line-through; }
  .device { border: 1px solid var(--line); border-radius: 12px; padding: 1.1rem; margin: 0 0 1rem; }
  .device h2 { margin: 0; font-size: 1.05rem; }
  .device-head { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; }
  .status { font-size: 0.8rem; color: var(--muted); }
  .status.active { color: #287550; }
  .device p { margin: 0.4rem 0; }
  .device details { margin-top: 0.8rem; }
  summary { cursor: pointer; }
  .device form { margin: 0.8rem 0 0; }
  .device-id { font-size: 0.72rem; overflow-wrap: anywhere; letter-spacing: 0; }
  .account-email { overflow-wrap: anywhere; }
  a { color: var(--accent); text-underline-offset: 0.2em; }
  :focus-visible { outline: 3px solid var(--accent); outline-offset: 3px; }
`

export function layout(options: LayoutOptions): string {
  const nav = options.user
    ? `<a href="/account/devices">${escapeHtml(options.user.name || options.user.email)}</a>`
    : ''
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title)} · Laurencio</title>
<style>${styles}</style>
</head>
<body>
<main>
<header class="site"><a href="/">Laurencio</a><span class="muted">${nav}</span></header>
${options.body}
</main>
</body>
</html>
`
}

export function signInPage(options: {
  next: string
  allowDevSignin: boolean
  error?: string
}): string {
  const next = escapeHtml(options.next)
  const form = options.allowDevSignin
    ? `<div class="notice">Staging access. Email addresses are not verified on this server.</div>
<form method="post" action="/sign-in/dev">
  <input type="hidden" name="next" value="${next}">
  <label for="email">Email</label>
  <input id="email" type="email" name="email" autocomplete="email" placeholder="you@example.com" autofocus required>
  <div class="row"><button class="primary" type="submit">Continue with email</button></div>
</form>`
    : '<div class="notice">Email sign-in is not available on this server yet. Contact the server owner.</div>'
  return layout({
    title: 'Sign in',
    body: `<h1>Sign in</h1>
<p class="lede">Use the same email on every computer to keep your devices together.</p>
${options.error ? `<div class="notice error">${escapeHtml(options.error)}</div>` : ''}
${form}`,
  })
}

export function deviceEnterPage(options: {
  userCode?: string
  error?: string
  user?: PageUser
}): string {
  return layout({
    title: 'Approve a device',
    user: options.user ?? null,
    body: `<h1>Approve a device</h1>
<p class="lede">Enter the code shown in your terminal.</p>
${options.error ? `<div class="notice error">${escapeHtml(options.error)}</div>` : ''}
<form method="post" action="/device">
  <label for="user_code">Device code</label>
  <input id="user_code" type="text" name="user_code" value="${escapeHtml(options.userCode ?? '')}" autocomplete="off" autocapitalize="characters" maxlength="16" required>
  <div class="row"><button class="primary" type="submit">Continue</button></div>
</form>`,
  })
}

export function deviceConfirmPage(options: {
  userCode: string
  clientId: string | null
  scope: string | null
  user?: PageUser
  deviceName?: string
  platform?: string
}): string {
  const details = [
    options.clientId ? `<p class="muted">Client: ${escapeHtml(options.clientId)}</p>` : '',
    options.scope ? `<p class="muted">Scopes: ${escapeHtml(options.scope)}</p>` : '',
  ].join('')
  return layout({
    title: 'Confirm device',
    user: options.user ?? null,
    body: `<h1>Confirm device</h1>
${options.deviceName ? `<p>Connect <strong>${escapeHtml(options.deviceName.slice(0, 80))}</strong>${options.platform ? ` (${escapeHtml(options.platform.slice(0, 40))})` : ''}.</p>` : ''}
<p>Authorize a device that has this code:</p>
<p class="code">${escapeHtml(options.userCode)}</p>
${options.user ? `<p class="account-email">Linking to <strong>${escapeHtml(options.user.email)}</strong>.</p>` : ''}
${details}
<p class="muted">Approve only if you started this on a device you control.</p>
<form method="post" action="/device/decision">
  <input type="hidden" name="user_code" value="${escapeHtml(options.userCode)}">
  <div class="row">
    <button class="primary" type="submit" name="decision" value="approve">Approve</button>
    <button type="submit" name="decision" value="deny">Deny</button>
  </div>
</form>`,
  })
}

export function deviceDonePage(options: {
  approved: boolean
  userCode: string
  user?: PageUser
}): string {
  return layout({
    title: options.approved ? 'Device approved' : 'Device denied',
    user: options.user ?? null,
    body: `<h1>${options.approved ? 'Device approved' : 'Device denied'}</h1>
<p>${
      options.approved
        ? `Code <span class="code">${escapeHtml(options.userCode)}</span> is authorized. Return to your terminal to finish enrolling.`
        : `Code <span class="code">${escapeHtml(options.userCode)}</span> was denied and cannot be used.`
    }</p>
<p><a href="/account/devices">Manage devices</a></p>`,
  })
}

export interface DeviceListItem {
  id: string
  name: string
  platform: string
  createdAt: string
  lastSeenAt: string | null
  revokedAt: string | null
}

export function devicesPage(options: {
  user: PageUser
  devices: DeviceListItem[]
  flash?: string
}): string {
  const active = options.devices.filter((device) => !device.revokedAt)
  const revoked = options.devices.filter((device) => device.revokedAt)
  const cards = [...active, ...revoked]
    .map(
      (device) => `<article class="device">
    <div class="device-head"><h2>${escapeHtml(device.name)}</h2><span class="status ${device.revokedAt ? '' : 'active'}">${device.revokedAt ? 'Revoked' : 'Active'}</span></div>
    <p class="muted">${escapeHtml(device.platform === 'darwin' ? 'macOS' : device.platform)} · Added ${timestamp(device.createdAt)}</p>
    <p class="muted">${device.revokedAt ? `Access revoked ${timestamp(device.revokedAt)}` : device.lastSeenAt ? `Last connected ${timestamp(device.lastSeenAt)}` : 'Waiting for its first connection'}</p>
    <code class="muted device-id">${escapeHtml(device.id)}</code>
    ${
      device.revokedAt
        ? ''
        : `<details><summary>Rename device</summary><form method="post" action="/account/devices/${escapeHtml(device.id)}/rename" class="rename">
    <label for="name-${escapeHtml(device.id)}">Device name</label>
    <input id="name-${escapeHtml(device.id)}" type="text" name="name" value="${escapeHtml(device.name)}" maxlength="80" required>
    <button type="submit">Rename</button>
  </form></details>
  <p><a href="/account/devices/${escapeHtml(device.id)}/revoke">Revoke access</a></p>`
    }
</article>`,
    )
    .join('')
  return layout({
    title: 'Devices',
    user: options.user,
    body: `<h1>Devices</h1>
<p class="account-email">${escapeHtml(options.user.email)}</p>
<p class="lede">${active.length} active ${active.length === 1 ? 'device' : 'devices'}. Devices stay signed in while they sync. After 90 days without connecting, sign in again.</p>
${options.flash ? `<div class="notice">${escapeHtml(options.flash)}</div>` : ''}
<div class="notice"><strong>Add another device</strong><br>Run <code>laurencio init</code> on that computer, then sign in with ${escapeHtml(options.user.email)}. Have your recovery passphrase ready to unlock your files.</div>
${cards || '<p class="muted">Your devices will appear here after setup.</p>'}
<form method="post" action="/sign-out">
  <div class="row"><button type="submit">Sign out</button></div>
</form>`,
  })
}

function timestamp(value: string): string {
  return `<time datetime="${escapeHtml(value)}">${escapeHtml(value.replace('T', ' ').slice(0, 16))} UTC</time>`
}

export function revokeDevicePage(options: { user: PageUser; device: DeviceListItem }): string {
  return layout({
    title: 'Revoke device access',
    user: options.user,
    body: `<h1>Revoke ${escapeHtml(options.device.name)}?</h1>
<p>This computer will stop syncing immediately. Its local files stay on the computer. Your other devices keep syncing.</p>
<p class="muted">To reconnect it later, run <code>laurencio init</code> there and sign in again.</p>
<form method="post" action="/account/devices/${escapeHtml(options.device.id)}/revoke">
  <input type="hidden" name="confirm" value="${escapeHtml(options.device.id)}">
  <div class="row"><button class="danger" type="submit">Revoke access</button><a href="/account/devices">Keep device connected</a></div>
</form>`,
  })
}

export function errorPage(options: { status: number; message: string }): string {
  return layout({
    title: 'Error',
    body: `<h1>${options.status}</h1>
<p>${escapeHtml(options.message)}</p>
<p><a href="/account/devices">Back to devices</a></p>`,
  })
}
