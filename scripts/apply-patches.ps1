# 把 patches/ 下的本地补丁重放到 deepseek-harness 源码检出。
#
# 背景：桌面壳的载荷基于 pin 死的 npm 发布版，而个别性能/体验修复以上游源码
# 补丁的形式维护在本仓库 patches/ 下。每次升级 deepseek-harness 后重跑本脚本，
# 即可把补丁自动合入新版本——补丁插入点极小，跨版本大概率直接合上；真冲突时
# 按输出提示手贴对应几行，或等上游 PR 合并后删掉对应补丁文件。
#
# 用法：
#   pwsh scripts/apply-patches.ps1                        # 实际应用全部补丁（幂等）
#   pwsh scripts/apply-patches.ps1 -Check                 # 只做 dry-run，不改任何文件
#   pwsh scripts/apply-patches.ps1 -HarnessPath <检出路径>
#
# harness 检出解析顺序：-HarnessPath 参数 > 环境变量 DSH_HARNESS_PATH >
# 仓库根目录旁的 ..\deepseek-harness。
#
# 说明：补丁由工作区两棵目录树 git diff --no-index 生成，index 行为零哈希，
# 因此本脚本先走普通 git apply；失败时才用 --3way 兜底（缺 blob 时 git 会自动
# 退回直连应用），再失败则要求人工处理。

param(
    [string]$HarnessPath,
    [switch]$Check
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$patchDir = Join-Path $repoRoot 'patches'

# --- 定位 harness 检出 -----------------------------------------------------------

if (-not $HarnessPath) { $HarnessPath = $env:DSH_HARNESS_PATH }
if (-not $HarnessPath) {
    $guess = Join-Path (Split-Path -Parent $repoRoot) 'deepseek-harness'
    if (Test-Path $guess) { $HarnessPath = $guess }
}
if (-not $HarnessPath -or -not (Test-Path (Join-Path $HarnessPath '.git'))) {
    Write-Host "[error] 未找到 deepseek-harness git 检出。" -ForegroundColor Red
    Write-Host "        用 -HarnessPath 指定，或设置环境变量 DSH_HARNESS_PATH，"
    Write-Host "        或把检出到本仓库的同级目录 ..\deepseek-harness。"
    exit 2
}
$HarnessPath = (Resolve-Path $HarnessPath).Path
Write-Host "harness 检出：$HarnessPath"

# --- 收集补丁 -------------------------------------------------------------------

$patches = @(Get-ChildItem -Path $patchDir -Filter '*.patch' -File | Sort-Object Name)
if ($patches.Count -eq 0) {
    Write-Host '[ok] patches/ 下没有补丁，无事可做。'
    exit 0
}

# 从补丁文本提取目标文件与新增标识符，用于「已应用过」的幂等判定。
function Get-PatchInfo([string]$PatchFile) {
    $text = Get-Content -Raw $PatchFile
    $targets = @()
    $added = @()
    foreach ($line in ($text -split "`n")) {
        if ($line -match '^diff --git a/(\S+) b/') { $targets += $Matches[1] }
        elseif ($line -match '^\+(?!\+\+)\s*(?:export\s+)?(?:function|const|class)\s+([A-Za-z_$][\w$]*)') {
            $added += $Matches[1]
        }
    }
    @{ Targets = $targets | Select-Object -Unique; Markers = $added | Select-Object -Unique }
}

$mode = if ($Check) { '[dry-run] ' } else { '' }
$failed = 0

# git 输出不能吞掉：沙箱拦截、EOL 冲突、上下文漂移都靠这几行定位。
function Write-GitNotice([string]$Stage, $Output) {
    $lines = @(@($Output) | ForEach-Object { "$_" } | Where-Object { $_ -match '\S' })
    if ($lines.Count -gt 0) {
        Write-Host "         [$Stage] git 输出（前 4 行）："
        foreach ($line in ($lines | Select-Object -First 4)) { Write-Host "           $line" }
    }
}

foreach ($patch in $patches) {
    $name = $patch.Name
    $info = Get-PatchInfo $patch.FullName

    # 幂等：所有标记符号都已出现在目标文件里 → 视为已应用，跳过。
    $allMarked = $true
    foreach ($m in $info.Markers) {
        $found = $false
        foreach ($rel in $info.Targets) {
            $t = Join-Path $HarnessPath ($rel -replace '/', '\')
            if ((Test-Path $t) -and ((Get-Content -Raw $t) -match [regex]::Escape($m))) { $found = $true; break }
        }
        if (-not $found) { $allMarked = $false; break }
    }
    if ($info.Markers.Count -gt 0 -and $allMarked) {
        Write-Host "${mode}[skip] $name —— 已应用（检测到 $($info.Markers -join ', ')）"
        continue
    }

    if ($Check) {
        $checkOut = & git -C $HarnessPath apply --check "$($patch.FullName)" 2>&1
        if ($LASTEXITCODE -eq 0) { Write-Host "${mode}[apply] $name —— 可干净合入" }
        else {
            Write-GitNotice '--check' $checkOut
            Write-Host "${mode}[conflict] $name —— 直接合不上下列文件，升级改动了插入点，需人工处理：" -ForegroundColor Yellow
            Write-Host ($info.Targets | ForEach-Object { "           $_" })
            $failed++
        }
        continue
    }

    $plainOut = & git -C $HarnessPath apply "$($patch.FullName)" 2>&1
    if ($LASTEXITCODE -eq 0) { Write-Host "[ok] $name 已应用"; continue }
    Write-GitNotice '直接应用' $plainOut

    # 兜底一：三方合并（缺 blob 信息时 git 自动退回普通应用，仍能吃 fuzz 上下文）。
    $way3Out = & git -C $HarnessPath apply --3way "$($patch.FullName)" 2>&1
    if ($LASTEXITCODE -eq 0) { Write-Host "[ok] $name 以 --3way 合入"; continue }
    Write-GitNotice '--3way' $way3Out

    # 兜底二：真冲突 —— 留下 reject 文件让人工收尾。
    & git -C $HarnessPath apply --reject "$($patch.FullName)" 2>&1 | Out-Null
    Write-Host "[manual] $name 自动合并失败。已按 --reject 写出 *.reject：" -ForegroundColor Red
    Write-Host ($info.Targets | ForEach-Object { "         $(Join-Path $HarnessPath ($_ -replace '/','\')).reject" })
    Write-Host '         对照 .reject 与新版本手贴修改，然后删除 .reject 并提交。'
    $failed++
}

if ($failed -gt 0) { exit 1 } else { exit 0 }
