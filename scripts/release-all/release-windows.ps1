# Windows half of a release without GitHub Actions (see RELEASING.md).
#
# scripts/release-all/release.sh prepare (Linux) attaches this script to the draft release. On the
# Windows PC it checks out the release commit, builds the Windows x64 binaries
# with Visual Studio 2022 and vcpkg (static Arrow, Parquet, HDF5), runs the
# tests, and attaches windows-x64-<repo>-<version>.zip to the draft; release.sh
# publish then builds every package from it.
#
#   powershell -ExecutionPolicy Bypass -File release-windows.ps1 -Repo <repo> -Tag v<version>
#
# Needs: Visual Studio 2022 (Desktop development with C++), Git, CMake, Python 3,
# GitHub CLI (gh auth login), and Node.js for msentity-spectrum-viewer.
# Work files: %USERPROFILE%\msentity-release (vcpkg, sources, builds).

param(
  [Parameter(Mandatory = $true)][ValidateSet("msentity", "msentity-similarity", "msentity-spectrum-viewer")][string]$Repo,
  [Parameter(Mandatory = $true)][string]$Tag
)

$ErrorActionPreference = "Stop"
$Owner = "MotohiroOGAWA"
$Work = Join-Path $env:USERPROFILE "msentity-release"
$Version = $Tag.TrimStart("v")

function Step([string]$Text) { Write-Host "`n> $Text" -ForegroundColor Cyan }
# Run a program and stop when it fails. A plain function (no param block): its
# arguments, including ones like -e or -C, all go to the program unchanged.
# An advanced function would take -e as PowerShell's -ErrorAction/-ErrorVariable.
function Run {
  $program, $arguments = $args
  & $program @arguments
  if ($LASTEXITCODE -ne 0) { throw "$program $($arguments -join ' ') failed (exit $LASTEXITCODE)" }
}

Step "Checking the tools"
$needed = @("git", "gh", "cmake", "python")
if ($Repo -eq "msentity-spectrum-viewer") { $needed += @("node", "npm") }
foreach ($tool in $needed) {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "$tool is not installed or not on PATH" }
}
Run gh auth status

$draft = gh release view $Tag --repo "$Owner/$Repo" --json isDraft,targetCommitish | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or -not $draft.isDraft) { throw "$Repo has no draft release $Tag; run release.sh prepare on Linux first" }
$Commit = $draft.targetCommitish
Write-Host "  $Repo $Tag, commit $($Commit.Substring(0, 7))"

Step "Source at the release commit"
New-Item -ItemType Directory -Force -Path $Work | Out-Null
$Source = Join-Path $Work $Repo
if (-not (Test-Path (Join-Path $Source ".git"))) { Run git clone --quiet "https://github.com/$Owner/$Repo.git" $Source }
Run git -C $Source fetch --quiet --tags origin
Run git -C $Source checkout --quiet --force $Commit
Run git -C $Source submodule update --init --recursive --quiet
Run git -C $Source clean -fdxq -e build-release/

Step "vcpkg at the manifest baseline"
$baseline = (Get-Content (Join-Path $Source "vcpkg.json") -Raw | ConvertFrom-Json)."builtin-baseline"
$env:VCPKG_ROOT = Join-Path $Work "vcpkg"
$env:VCPKG_DEFAULT_BINARY_CACHE = Join-Path $Work "vcpkg-binary"
New-Item -ItemType Directory -Force -Path $env:VCPKG_DEFAULT_BINARY_CACHE | Out-Null
if (-not (Test-Path (Join-Path $env:VCPKG_ROOT ".git"))) { Run git clone --quiet https://github.com/microsoft/vcpkg.git $env:VCPKG_ROOT }
if ((git -C $env:VCPKG_ROOT rev-parse HEAD) -ne $baseline -or -not (Test-Path (Join-Path $env:VCPKG_ROOT "vcpkg.exe"))) {
  Run git -C $env:VCPKG_ROOT fetch --quiet origin
  Run git -C $env:VCPKG_ROOT checkout --quiet $baseline
  Run (Join-Path $env:VCPKG_ROOT "bootstrap-vcpkg.bat") -disableMetrics
}

Step "Building and testing (the first build of Arrow/Parquet/HDF5 takes a while)"
$Build = Join-Path $Source "build-release"
$toolchain = (Join-Path $env:VCPKG_ROOT "scripts\buildsystems\vcpkg.cmake")
$common = @("-S", $Source, "-B", $Build, "-G", "Visual Studio 17 2022", "-A", "x64",
  "-DCMAKE_TOOLCHAIN_FILE=$toolchain", "-DMSENTITY_STATIC_DEPS=ON")
$files = @()
switch ($Repo) {
  "msentity" {
    Run cmake @common "-DVCPKG_TARGET_TRIPLET=x64-windows-static-md" "-DVCPKG_OVERLAY_TRIPLETS=$Source\triplets" `
      "-DVCPKG_MANIFEST_FEATURES=tests" "-DMSENTITY_TEST_BINDINGS=OFF"
    Run cmake --build $Build --config Release --parallel
    Run ctest --test-dir $Build -C Release --output-on-failure
    $files = @("$Build\bin\Release\msentity_c.dll", "$Build\Release\msentity_c.lib")
  }
  "msentity-similarity" {
    Run cmake @common "-DVCPKG_TARGET_TRIPLET=x64-windows-static-md" "-DVCPKG_OVERLAY_TRIPLETS=$Source\triplets" `
      "-DMSENTITY_SIMILARITY_TEST_BINDINGS=OFF"
    Run cmake --build $Build --config Release --parallel
    Run ctest --test-dir $Build -C Release --output-on-failure
    $files = @("$Build\bin\Release\msentity_similarity_c.dll", "$Build\bin\Release\msentity_c.dll",
      "$Build\Release\msentity_similarity_c.lib", "$Build\_deps\msentity-build\Release\msentity_c.lib")
  }
  "msentity-spectrum-viewer" {
    Run cmake @common "-DVCPKG_TARGET_TRIPLET=x64-windows-static"
    Run cmake --build $Build --config Release --parallel --target msentity-viewer-backend
    $exe = "$Build\backend\Release\msentity-viewer-backend.exe"
    Push-Location (Join-Path $Source "host"); try { Run npm ci --ignore-scripts --silent } finally { Pop-Location }
    Run node (Join-Path $Source "scripts\smoke-backend.js") $exe
    $files = @($exe)
  }
}

Step "Attaching the Windows build to the draft release"
$Out = Join-Path $Work "out\$Repo"
Remove-Item -Recurse -Force $Out -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $Out | Out-Null
foreach ($file in $files) {
  if (-not (Test-Path $file)) { throw "the build did not produce $file" }
  Copy-Item $file $Out
}
$zip = Join-Path $Work "windows-x64-$Repo-$Version.zip"
Remove-Item -Force $zip -ErrorAction SilentlyContinue
Compress-Archive -Path (Join-Path $Out "*") -DestinationPath $zip
Run gh release upload $Tag $zip --repo "$Owner/$Repo" --clobber

Write-Host "`nWindows build attached: $(Split-Path $zip -Leaf)" -ForegroundColor Green
Write-Host "Next, on Linux (Ubuntu 22.04 / WSL):  bash <msentity-spectrum-viewer>/scripts/release-all/release.sh publish $Repo"
