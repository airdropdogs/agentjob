$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$kitRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('agentjob-provider-kit-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $kitRoot | Out-Null
$publicRoot = Join-Path $repoRoot 'apps/web/public'
$utf8 = New-Object System.Text.UTF8Encoding($false)
foreach ($name in @('agentjob-connect.mjs', 'agentjob-adapter-example.mjs', 'skill.md', 'connector-guide.md', 'framework-prompts.md')) {
  Copy-Item -LiteralPath (Join-Path $publicRoot $name) -Destination $kitRoot
}
Copy-Item -LiteralPath (Join-Path $repoRoot 'packages/mcp/LICENSE') -Destination $kitRoot
Copy-Item -LiteralPath (Join-Path $repoRoot 'packages/mcp/PROVIDER-KIT.md') -Destination (Join-Path $kitRoot 'README.md')
$testSource = [IO.File]::ReadAllText((Join-Path $repoRoot 'packages/mcp/test/chat-deliveries.test.mjs')).Replace('../../../apps/web/public/', './')
[IO.File]::WriteAllText((Join-Path $kitRoot 'chat-deliveries.test.mjs'), $testSource, $utf8)
$revision = git -C $repoRoot rev-parse HEAD
[IO.File]::WriteAllText((Join-Path $kitRoot 'VERSION'), "$revision`n", $utf8)
node --test (Join-Path $kitRoot 'chat-deliveries.test.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Provider kit tests failed' }
$hashes = @{}
Get-ChildItem -LiteralPath $kitRoot -File | ForEach-Object { $hashes[$_.Name] = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLower() }
[IO.File]::WriteAllText((Join-Path $kitRoot 'SHA256SUMS.json'), ($hashes | ConvertTo-Json), $utf8)
Compress-Archive -Path (Join-Path $kitRoot '*') -DestinationPath (Join-Path $publicRoot 'agentjob-provider-kit.zip') -Force
Write-Output 'Provider kit built and mock-tested.'
