# Copyright 2026 Andy (@andy-mira)
# SPDX-License-Identifier: Apache-2.0
param([ValidateSet('scalar', 'simd')][string]$Variant = 'scalar', [switch]$UseDocker)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$compiler = Get-Command emcc -ErrorAction SilentlyContinue
if (-not $compiler -and -not $UseDocker) { throw 'Emscripten emcc is not on PATH. Activate the pinned SDK or use -UseDocker with the official pinned image.' }
if (-not $UseDocker) {
  $compilerVersion = & $compiler.Source --version
  if ($LASTEXITCODE -ne 0 -or ($compilerVersion -join "`n") -notmatch '\b4\.0\.15\b') { throw 'This build is pinned to Emscripten 4.0.15; use the recorded SDK or -UseDocker.' }
}
$output = Join-Path $repo "packages/compute/artifacts/$Variant"
New-Item -ItemType Directory -Force -Path $output | Out-Null
$arguments = @((Join-Path $repo 'native/common/preprocess.cpp'), '-std=c++17', '-O2', '--no-entry',
  '-sMODULARIZE=1', '-sEXPORT_ES6=1', '-sENVIRONMENT=web,worker,node', '-sALLOW_MEMORY_GROWTH=0',
  '-sINITIAL_MEMORY=67108864', '-sFILESYSTEM=0',
  '-sEXPORTED_FUNCTIONS=["_e_rgba_gray","_e_pyr_down","_malloc","_free"]',
  '-sEXPORTED_RUNTIME_METHODS=["HEAPU8"]',
  '-o', (Join-Path $output 'compute.mjs'))
if ($Variant -eq 'simd') { $arguments += '-msimd128' }
if ($UseDocker) {
  $arguments[0] = '/work/native/common/preprocess.cpp'
  $arguments[$arguments.IndexOf('-o') + 1] = "/work/packages/compute/artifacts/$Variant/compute.mjs"
  & docker run --rm --network none --mount "type=bind,source=$repo,target=/work" -w /work emscripten/emsdk@sha256:27bc6267cb285223b8aebb7627bfebae7cb3ad2aaa0d5923b8aa5321793033e8 emcc @arguments
} else { & $compiler.Source @arguments }
if ($LASTEXITCODE -ne 0) { throw "Emscripten failed: $LASTEXITCODE" }
