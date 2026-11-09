$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$env:CHAINS = 'bsc'
$env:SCAN_WINDOW = '100000'
$env:CPU_MAX = '1490'
$env:BSC_RPC_URL = 'https://bsc-rpc.publicnode.com'

node indexer.mjs
if ($LASTEXITCODE -ne 0) { throw "indexer failed: $LASTEXITCODE" }

git add data/state.json public/site-index.json
git diff --cached --quiet
if ($LASTEXITCODE -ne 0) {
  git commit -m "local index update"
  git push origin main
}
