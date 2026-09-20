$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$repository = 'ghandhitechnology/laurencio'
$version = if ($env:LAURENCIO_VERSION) { $env:LAURENCIO_VERSION } else { 'latest' }
$installDir = if ($env:LAURENCIO_INSTALL_DIR) { $env:LAURENCIO_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Laurencio\bin' }
$machineArch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
$arch = switch ($machineArch) {
    'AMD64' { 'x64' }
    'ARM64' { 'arm64' }
    default { throw "Laurencio requires Windows x64 or ARM64." }
}
$asset = "laurencio-bun-windows-$arch.exe"
if ($version -eq 'latest') {
    $baseUrl = "https://github.com/$repository/releases/latest/download"
} else {
    $tag = if ($version.StartsWith('v')) { $version } else { "v$version" }
    $baseUrl = "https://github.com/$repository/releases/download/$tag"
}

$downloadDir = Join-Path ([IO.Path]::GetTempPath()) ('laurencio-install-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $downloadDir | Out-Null
try {
    $download = Join-Path $downloadDir $asset
    $checksum = "$download.sha256"
    Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/$asset" -OutFile $download
    Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/$asset.sha256" -OutFile $checksum
    $record = (Get-Content -LiteralPath $checksum -Raw).Trim()
    if ($record -notmatch '^([0-9a-fA-F]{64})\s+\*?(.+)$' -or $Matches[2] -ne $asset) {
        throw 'The release checksum record is invalid.'
    }
    $expectedHash = $Matches[1]
    if ((Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash -ne $expectedHash) {
        throw 'Release checksum verification failed.'
    }
    New-Item -ItemType Directory -Path $installDir -Force | Out-Null
    $destination = Join-Path $installDir 'laurencio.exe'
    if (Test-Path -LiteralPath $destination) {
        Copy-Item -LiteralPath $destination -Destination "$destination.previous" -Force
    }
    Copy-Item -LiteralPath $download -Destination $destination -Force
    [string]$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (($userPath -split ';') -notcontains $installDir) {
        [Environment]::SetEnvironmentVariable('Path', (($userPath.TrimEnd(';') + ';' + $installDir).TrimStart(';')), 'User')
    }
    if (($env:Path -split ';') -notcontains $installDir) { $env:Path += ";$installDir" }
    Write-Host "Installed Laurencio to $destination"
    & $destination --version
    if ($LASTEXITCODE -ne 0) { throw 'The installed executable failed its version check.' }
    Write-Host 'Run laurencio enroll to set up this computer.'
} finally {
    Remove-Item -LiteralPath $downloadDir -Recurse -Force
}
