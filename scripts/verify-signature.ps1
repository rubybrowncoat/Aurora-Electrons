[CmdletBinding()]
param(
    [string]$Path,
    [string]$ExpectedFileName,
    [string]$ExpectedSubject,
    [string]$ExpectedProduct,
    [string]$ExpectedVersion,
    [string]$OriginalPath,
    [switch]$Inspect,
    [switch]$SelfTest
)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-SignatureResult {
    param($Result, [string]$Name, [string]$Subject, [string]$Product, [string]$Version)
    foreach ($value in @($Name, $Subject, $Product, $Version)) {
        if ([string]::IsNullOrWhiteSpace($value)) { throw 'Missing expected signature identity/configuration' }
    }
    if ($Result.FileName -cne $Name) { throw 'Unexpected exact target filename' }
    if ($Result.Status -cne 'Valid') { throw "Untrusted or invalid Authenticode signature: $($Result.Status)" }
    if ([string]::IsNullOrWhiteSpace($Result.Subject) -or $Result.Subject -cne $Subject) { throw 'Unexpected certificate subject' }
    if (-not $Result.TimestampPresent) { throw 'Missing trusted Authenticode timestamp' }
    if ($Result.Product -cne $Product) { throw 'Unexpected ProductName' }
    if ($Result.Version -cne $Version) { throw 'Unexpected ProductVersion' }
}

function Get-SignatureResult {
    param([string]$File)
    $item = Get-Item -LiteralPath $File
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Signature target must be an ordinary file' }
    $signature = Get-AuthenticodeSignature -LiteralPath $item.FullName
    # Status Valid is Windows WinVerifyTrust's file/chain/timestamp-policy decision, not merely a certificate's presence.
    [pscustomobject]@{
        FileName = $item.Name
        Status = $signature.Status.ToString()
        Subject = if ($null -ne $signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { '' }
        TimestampPresent = $null -ne $signature.TimeStamperCertificate
        TimestampSubject = if ($null -ne $signature.TimeStamperCertificate) { $signature.TimeStamperCertificate.Subject } else { '' }
        Product = $item.VersionInfo.ProductName
        Version = $item.VersionInfo.ProductVersion
        SHA256 = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
}

function Get-PeContent {
    param([string]$File)
    [byte[]]$bytes = [IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $File).Path)
    if ($bytes.Length -lt 256 -or $bytes[0] -ne 0x4d -or $bytes[1] -ne 0x5a) { throw 'Not a PE executable' }
    $pe = [BitConverter]::ToInt32($bytes, 0x3c)
    if ($pe -lt 64 -or ($pe + 160) -gt $bytes.Length -or [BitConverter]::ToUInt32($bytes, $pe) -ne 0x4550) { throw 'Invalid PE header' }
    $optional = $pe + 24
    $magic = [BitConverter]::ToUInt16($bytes, $optional)
    if ($magic -ne 0x10b -and $magic -ne 0x20b) { throw 'Unsupported PE optional header' }
    $directory = $optional + $(if ($magic -eq 0x20b) { 112 } else { 96 }) + 32
    $certificateOffset = [BitConverter]::ToUInt32($bytes, $directory)
    $certificateSize = [BitConverter]::ToUInt32($bytes, $directory + 4)
    if (($certificateOffset -eq 0) -ne ($certificateSize -eq 0)) { throw 'Invalid PE certificate directory' }
    if ($certificateSize -gt 0 -and ($certificateOffset -lt ($directory + 8) -or ($certificateOffset + $certificateSize) -ne $bytes.Length)) { throw 'Certificate table must terminate the PE' }
    $end = if ($certificateSize -gt 0) { [int]$certificateOffset } else { $bytes.Length }
    [byte[]]$content = New-Object byte[] $end
    [Array]::Copy($bytes, $content, $end)
    [Array]::Clear($content, $optional + 64, 4)
    [Array]::Clear($content, $directory, 8)
    [byte[]]$certificates = @()
    if ($certificateSize -gt 0) { $certificates = $bytes[$certificateOffset..($bytes.Length - 1)] }
    return @{ Content = $content; Certificates = $certificates }
}

function Assert-SamePeContent {
    param([string]$Original, [string]$Signed)
    $before = Get-PeContent $Original
    $after = Get-PeContent $Signed
    if ($after.Content.Length -lt $before.Content.Length -or ($after.Content.Length - $before.Content.Length) -gt 7) { throw 'Signing changed PE payload length' }
    $hasher = [Security.Cryptography.SHA256]::Create()
    try {
        $beforeHash = [Convert]::ToBase64String($hasher.ComputeHash($before.Content))
        $afterHash = [Convert]::ToBase64String($hasher.ComputeHash($after.Content, 0, $before.Content.Length))
        if ($beforeHash -cne $afterHash) { throw 'Signing changed PE content' }
        for ($i = $before.Content.Length; $i -lt $after.Content.Length; $i++) {
            if ($after.Content[$i] -ne 0) { throw 'Signing appended non-alignment payload bytes' }
        }
        if ($before.Certificates.Length -gt $after.Certificates.Length) { throw 'Signing removed an upstream signature' }
        if ($before.Certificates.Length -gt 0) {
            $beforeSignature = [Convert]::ToBase64String($hasher.ComputeHash($before.Certificates))
            $afterSignature = [Convert]::ToBase64String($hasher.ComputeHash($after.Certificates, 0, $before.Certificates.Length))
            if ($beforeSignature -cne $afterSignature) { throw 'Signing replaced an upstream signature' }
        }
    } finally { $hasher.Dispose() }
}

if ($SelfTest) {
    $good = @{ FileName = 'test.exe'; Status = 'Valid'; Subject = 'CN=Trusted Control'; TimestampPresent = $true; Product = 'Control'; Version = '1.2.3' }
    Assert-SignatureResult $good 'test.exe' 'CN=Trusted Control' 'Control' '1.2.3'
    $cases = @(@{ Status = 'NotTrusted' }, @{ Status = 'HashMismatch' }, @{ TimestampPresent = $false }, @{ Subject = '' }, @{ Product = 'Other' }, @{ Version = '9.9.9' }, @{ FileName = 'other.exe' })
    foreach ($case in $cases) {
        $bad = $good.Clone()
        foreach ($key in $case.Keys) { $bad[$key] = $case[$key] }
        $rejected = $false
        try { Assert-SignatureResult $bad 'test.exe' 'CN=Trusted Control' 'Control' '1.2.3' } catch { $rejected = $true }
        if (-not $rejected) { throw "Verifier accepted invalid collected result: $($case | ConvertTo-Json -Compress)" }
    }
    @{ passed = $true; collectedResultCases = $cases.Length + 1; scope = 'Decision controls only; not a certificate or project signature' } | ConvertTo-Json -Compress
    exit 0
}
if ([string]::IsNullOrWhiteSpace($Path)) { throw 'Missing signature target path' }
$result = Get-SignatureResult $Path
if (-not $Inspect) {
    Assert-SignatureResult $result $ExpectedFileName $ExpectedSubject $ExpectedProduct $ExpectedVersion
    if (-not [string]::IsNullOrWhiteSpace($OriginalPath)) { Assert-SamePeContent $OriginalPath $Path }
}
$result | ConvertTo-Json -Compress
