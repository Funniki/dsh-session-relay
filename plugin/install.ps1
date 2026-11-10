[CmdletBinding()]
param(
	[string]$Profile = "desktop",
	[switch]$SkipChecks,
	[switch]$FromRegistry,
	[string]$Version = ""
)

# Install dsh-session-relay into one DSH profile — one command, both channels.
#
# The plugin ships as a single self-contained package: the bundle row and the browser
# half live in the same package, so one `dsh plugin add` is the whole install.
#
# This script therefore:
#   1. installs the package (this folder when it is the extracted zip, the registry
#      otherwise), pinning $Version when one was given;
#   2. checks that the package is resolvable from the profile root;
#   3. checks that the profile recorded it as a bundle (a plain dependency sits inert).

$ErrorActionPreference = "Stop"

$pluginRoot = $PSScriptRoot
$packName = "dsh-session-relay"

$dsh = @(
	(Join-Path $env:LOCALAPPDATA "Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"),
	(Join-Path $env:ProgramFiles "DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd")
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

if (-not $dsh) {
	$command = Get-Command dsh -ErrorAction SilentlyContinue
	if ($command) {
		$dsh = $command.Source
	}
}
if (-not $dsh) {
	throw "DeepSeek Harness CLI was not found. Install DSH or put dsh on PATH."
}
if (-not $FromRegistry -and -not (Test-Path -LiteralPath (Join-Path $pluginRoot "package.json"))) {
	throw "package.json is missing next to install.ps1 (pass -FromRegistry to install the published package instead)."
}

function Add-ProfilePackage {
	param([Parameter(Mandatory)][string]$Target)
	Write-Host "Adding $Target"
	& $dsh plugin --profile $Profile add $Target
	if ($LASTEXITCODE -ne 0) {
		throw "dsh plugin add failed for $Target (exit $LASTEXITCODE)."
	}
}

# 1. The package: this folder when it is the extracted zip, the registry otherwise.
$isLocalFolder = (-not $FromRegistry) -and (Test-Path -LiteralPath (Join-Path $pluginRoot "cordis.patch.yml"))
if ($isLocalFolder) {
	Add-ProfilePackage -Target $pluginRoot
} else {
	$target = if ($Version -ne "") { "$packName@$Version" } else { $packName }
	Add-ProfilePackage -Target $target
}

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME ".dsh" }
$profileDir = Join-Path (Join-Path $dshHome "profiles") $Profile
$nodeModules = Join-Path $profileDir "node_modules"
$profileManifest = Join-Path $profileDir "package.json"
$installedManifest = Join-Path (Join-Path $nodeModules $packName) "package.json"

if ($SkipChecks) {
	Write-Host ""
	Write-Host "Installed $packName into profile '$Profile' (post-install checks skipped)."
	return
}

if (-not (Test-Path -LiteralPath $profileManifest)) {
	throw "Profile manifest not found: $profileManifest"
}
# 2. The row resolves the package BY NAME from the profile root.
if (-not (Test-Path -LiteralPath $installedManifest)) {
	throw "$packName is not resolvable from the profile root ($nodeModules)."
}

# 3. A plugin that is only a dependency is not loaded by the bundle row.
$manifest = Get-Content -LiteralPath $profileManifest -Raw | ConvertFrom-Json
$registered = ($manifest.dsh.profile.bundles) -contains $packName
if (-not $registered) {
	throw "The profile did not register $packName as a bundle."
}

$version = (Get-Content -LiteralPath $installedManifest -Raw | ConvertFrom-Json).version
Write-Host ""
Write-Host "Installed $packName@$version into profile '$Profile'."
Write-Host "Restart DSH, or disable and re-enable the bundle in Plugins if it is already running."
