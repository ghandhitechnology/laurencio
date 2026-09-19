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
  const dev = options.allowDevSignin
    ? `<h2>Development sign-in</h2>
<form method="post" action="/sign-in/dev">
  <input type="hidden" name="next" value="${next}">
  <label for="email">Email</label>
  <input id="email" type="email" name="email" value="dev@localhost" required>
  <div class="row"><button type="submit">Sign in without GitHub</button></div>
</form>`
    : ''
  return layout({
    title: 'Sign in',
    body: `<h1>Sign in</h1>
<p class="lede">Sign in to approve a device or manage enrolled devices.</p>
${options.error ? `<div class="notice error">${escapeHtml(options.error)}</div>` : ''}
<form method="post" action="/sign-in/github">
  <input type="hidden" name="next" value="${next}">
  <div class="row"><button class="primary" type="submit">Continue with GitHub</button></div>
</form>
${dev}`,
  })
}

export function deviceEnterPage(options: { userCode?: string; error?: string }): string {
  return layout({
    title: 'Approve a device',
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
}): string {
  const details = [
    options.clientId ? `<p class="muted">Client: ${escapeHtml(options.clientId)}</p>` : '',
    options.scope ? `<p class="muted">Scopes: ${escapeHtml(options.scope)}</p>` : '',
  ].join('')
  return layout({
    title: 'Confirm device',
    body: `<h1>Confirm device</h1>
<p>Authorize a device that has this code:</p>
<p class="code">${escapeHtml(options.userCode)}</p>
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

export function deviceDonePage(options: { approved: boolean; userCode: string }): string {
  return layout({
    title: options.approved ? 'Device approved' : 'Device denied',
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
  const rows = options.devices
    .map(
      (device) => `<tr>
  <td>
    <div class="${device.revokedAt ? 'revoked' : ''}">${escapeHtml(device.name)}</div>
    <div class="muted">${escapeHtml(device.platform)} · added ${escapeHtml(device.createdAt.slice(0, 10))}${
      device.lastSeenAt ? ` · last seen ${escapeHtml(device.lastSeenAt.slice(0, 10))}` : ''
    }</div>
    ${
      device.revokedAt
        ? '<div class="muted">revoked</div>'
        : `<form method="post" action="/account/devices/${escapeHtml(device.id)}/rename" class="rename">
    <input type="text" name="name" value="${escapeHtml(device.name)}" maxlength="80" aria-label="Device name">
    <button type="submit">Rename</button>
  </form>`
    }
  </td>
  <td class="actions">${
    device.revokedAt
      ? ''
      : `<form method="post" action="/account/devices/${escapeHtml(device.id)}/revoke">
    <button class="danger" type="submit">Revoke</button>
  </form>`
  }</td>
</tr>`,
    )
    .join('')
  return layout({
    title: 'Devices',
    user: options.user,
    body: `<h1>Devices</h1>
<p class="lede">Devices enrolled on this account. Revoking a device invalidates its token immediately.</p>
${options.flash ? `<div class="notice">${escapeHtml(options.flash)}</div>` : ''}
<table>
<thead><tr><th>Device</th><th></th></tr></thead>
<tbody>${rows || '<tr><td class="muted">No devices yet. Run <code>laurencio init</code> to enroll one.</td><td></td></tr>'}</tbody>
</table>
<form method="post" action="/sign-out">
  <div class="row"><button type="submit">Sign out</button></div>
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
