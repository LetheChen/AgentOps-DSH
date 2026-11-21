[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectRoot,

  [Parameter(Mandatory = $true)]
  [string]$BuildContext,

  [Parameter(Mandatory = $true)]
  [string]$Output,

  [Parameter(Mandatory = $true)]
  [string]$ImageName
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-AbsolutePath {
  param([Parameter(Mandatory = $true)][string]$Path)
  return [System.IO.Path]::GetFullPath($Path)
}

function Assert-ContainedPath {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Root
  )

  $absoluteRoot = Get-AbsolutePath $Root
  $absolutePath = Get-AbsolutePath $Path
  $prefix = $absoluteRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
  if (-not $absolutePath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to modify path outside build context: $absolutePath"
  }
}

$project = (Resolve-Path -LiteralPath $ProjectRoot).Path
$context = (Resolve-Path -LiteralPath $BuildContext).Path
$outputPath = Get-AbsolutePath $Output
$outputDir = Split-Path -Parent $outputPath

if (-not (Test-Path -LiteralPath (Join-Path $context 'Dockerfile') -PathType Leaf)) {
  throw "Dockerfile not found in build context: $context"
}
if (-not (Test-Path -LiteralPath (Join-Path $project 'src') -PathType Container)) {
  throw "Project source directory not found: $(Join-Path $project 'src')"
}

$copies = @(
  @{ Source = (Join-Path $project 'src'); Target = (Join-Path $context 'src'); Directory = $true },
  @{ Source = (Join-Path $project 'alembic'); Target = (Join-Path $context 'alembic'); Directory = $true },
  @{ Source = (Join-Path $project 'pyproject.toml'); Target = (Join-Path $context 'pyproject.toml'); Directory = $false },
  @{ Source = (Join-Path $project 'alembic.ini'); Target = (Join-Path $context 'alembic.ini'); Directory = $false },
  @{ Source = (Join-Path $project 'README.md'); Target = (Join-Path $context 'README.md'); Directory = $false }
)

foreach ($copy in $copies) {
  Assert-ContainedPath -Path $copy.Target -Root $context
  if (-not (Test-Path -LiteralPath $copy.Source)) {
    throw "Build input missing: $($copy.Source)"
  }
  if (Test-Path -LiteralPath $copy.Target) {
    Remove-Item -LiteralPath $copy.Target -Recurse -Force
  }
  Copy-Item -LiteralPath $copy.Source -Destination $copy.Target -Recurse:$copy.Directory
}

New-Item -ItemType Directory -Path $outputDir -Force | Out-Null

Write-Output "[agentops-build] docker build -t $ImageName $context"
& docker build -t $ImageName $context
if ($LASTEXITCODE -ne 0) {
  throw "docker build failed with exit code $LASTEXITCODE"
}

Write-Output "[agentops-build] docker save -o $outputPath $ImageName"
& docker save -o $outputPath $ImageName
if ($LASTEXITCODE -ne 0) {
  throw "docker save failed with exit code $LASTEXITCODE"
}

if (-not (Test-Path -LiteralPath $outputPath -PathType Leaf)) {
  throw "Image archive was not created: $outputPath"
}
Write-Output "[agentops-build] complete: $outputPath"
