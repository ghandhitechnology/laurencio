import path from 'node:path'
import type { CredentialStore } from './keyring'
import {
  createWindowsCredentialBroker,
  WindowsCredentialError,
  type WindowsCredentialRunner,
} from './windows-keyring-broker'

export { WindowsCredentialError, type WindowsCredentialRunner } from './windows-keyring-broker'

// Use Windows' inbox PowerShell and Win32 API rather than an optional .node
// module, so the same backend works in a standalone, cross-compiled executable.
// The program is fixed; credential values travel only through anonymous pipes.
const PROGRAM = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  [Console]::Error.WriteLine('LAURENCIO_CREDENTIAL_STAGE:initializing Win32 bindings')
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class LaurencioCredential {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct Credential {
    public uint Flags, Type;
    public string TargetName, Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist, AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias, UserName;
  }
  [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool Write(ref Credential credential, uint flags);
  [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool Read(string target, uint type, uint flags, out IntPtr credential);
  [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool Delete(string target, uint type, uint flags);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr credential);
  public static string Get(string target) {
    IntPtr pointer;
    if (!Read(target, 1, 0, out pointer)) {
      int error = Marshal.GetLastWin32Error();
      if (error == 1168) return null;
      throw new Win32Exception(error);
    }
    try {
      Credential credential = (Credential)Marshal.PtrToStructure(pointer, typeof(Credential));
      byte[] bytes = new byte[credential.CredentialBlobSize];
      try {
        Marshal.Copy(credential.CredentialBlob, bytes, 0, bytes.Length);
        return Convert.ToBase64String(bytes);
      } finally { Array.Clear(bytes, 0, bytes.Length); }
    } finally { CredFree(pointer); }
  }
  public static void Set(string target, string account, string encoded) {
    byte[] bytes = Convert.FromBase64String(encoded);
    IntPtr pointer = Marshal.AllocHGlobal(bytes.Length);
    try {
      Marshal.Copy(bytes, 0, pointer, bytes.Length);
      Credential credential = new Credential();
      credential.Type = 1;
      credential.TargetName = target;
      credential.UserName = account;
      credential.CredentialBlobSize = (uint)bytes.Length;
      credential.CredentialBlob = pointer;
      credential.Persist = 2;
      if (!Write(ref credential, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
    } finally {
      Array.Clear(bytes, 0, bytes.Length);
      Marshal.Copy(bytes, 0, pointer, bytes.Length);
      Marshal.FreeHGlobal(pointer);
    }
  }
  public static void Remove(string target) {
    if (!Delete(target, 1, 0)) {
      int error = Marshal.GetLastWin32Error();
      if (error != 1168) throw new Win32Exception(error);
    }
  }
}
'@
} catch {
  [Console]::Out.WriteLine('{"id":null,"ok":false,"code":0}')
  exit 1
}
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $request = $null
  try {
  [Console]::Error.WriteLine('LAURENCIO_CREDENTIAL_STAGE:reading request')
  $request = $line | ConvertFrom-Json
  [Console]::Error.WriteLine('LAURENCIO_CREDENTIAL_STAGE:calling Credential Manager')
  $target = $request.account + '.' + $request.service
  $value = $null
  switch ($request.operation) {
    'get' { $value = [LaurencioCredential]::Get($target) }
    'set' { [LaurencioCredential]::Set($target, $request.account, $request.secret) }
    'delete' { [LaurencioCredential]::Remove($target) }
    default { throw 'Invalid operation' }
  }
  [Console]::Out.WriteLine((@{ id = $request.id; ok = $true; secret = $value } | ConvertTo-Json -Compress))
} catch {
  $exception = $_.Exception
  while ($null -ne $exception.InnerException) { $exception = $exception.InnerException }
  $code = 0
  if ($exception -is [System.ComponentModel.Win32Exception]) { $code = $exception.NativeErrorCode }
  [Console]::Out.WriteLine((@{ id = $request.id; ok = $false; code = $code } | ConvertTo-Json -Compress))
  } finally {
    $request = $null
    $value = $null
    $line = $null
  }
}
`
const runPowerShell = createWindowsCredentialBroker().run

export function windowsCredentialStore(
  run: WindowsCredentialRunner = runPowerShell,
): CredentialStore {
  const executable = path.win32.join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  )
  const args = [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    Buffer.from(PROGRAM, 'utf16le').toString('base64'),
  ]
  async function request(operation: string, service: string, account: string, secret?: Uint8Array) {
    if (`${account}.${service}`.length > 32767 || /\0/.test(service + account)) {
      throw new WindowsCredentialError('Invalid Windows Credential Manager target.')
    }
    if (secret && secret.length > 2560) {
      throw new WindowsCredentialError(
        'Windows Credential Manager credentials must not exceed 2560 bytes.',
      )
    }
    let response: { ok?: boolean; secret?: unknown; code?: unknown }
    try {
      const raw = await run(
        executable,
        args,
        JSON.stringify({
          operation,
          service,
          account,
          secret: secret && Buffer.from(secret).toString('base64'),
        }),
      )
      response = JSON.parse(raw)
      if (!response || typeof response !== 'object') throw new Error()
    } catch (error) {
      if (error instanceof WindowsCredentialError) throw error
      throw new WindowsCredentialError(
        'Windows Credential Manager helper failed; check Windows PowerShell availability.',
      )
    }
    if (response.ok !== true) {
      const code = typeof response.code === 'number' ? response.code : 0
      throw new WindowsCredentialError(
        code === 1312
          ? 'Windows Credential Manager requires a user logon with a loaded profile (Win32 1312); run in the signed-in user session.'
          : `Windows Credential Manager operation failed (Win32 ${code}).`,
      )
    }
    if (operation !== 'get' || response.secret === null) return null
    if (
      typeof response.secret !== 'string' ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(response.secret)
    ) {
      throw new WindowsCredentialError('Windows Credential Manager returned an invalid credential.')
    }
    return new Uint8Array(Buffer.from(response.secret, 'base64'))
  }
  return {
    backend: 'keychain',
    get: (service, account) => request('get', service, account),
    async set(service, account, secret) {
      await request('set', service, account, secret)
    },
    async delete(service, account) {
      await request('delete', service, account)
    },
  }
}
