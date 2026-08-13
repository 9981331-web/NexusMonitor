$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath 'C:\NEXUS\nexus-court-monitor'
& 'C:\Program Files\nodejs\node.exe' 'src\russian-post-cli.js' scheduled
exit $LASTEXITCODE
