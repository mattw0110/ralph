# Ralph Wiggum - Long-running AI agent loop (PowerShell)
# Usage: .\ralph.ps1 [-Worker amp|cursor] [MaxIterations]
#
# Workers:
#   cursor (default) - Uses Cursor CLI 'agent' command
#   amp              - Uses Amp CLI 'amp' command

param(
    [Parameter()]
    [ValidateSet("cursor", "amp")]
    [string]$Worker = "cursor",
    
    [Parameter(Position = 0)]
    [int]$MaxIterations = 10
)

# ═══════════════════════════════════════════════════════
# Worker Configuration
# ═══════════════════════════════════════════════════════

switch ($Worker) {
    "cursor" {
        if (-not (Get-Command agent -ErrorAction SilentlyContinue)) {
            Write-Host "Error: 'agent' command not found. Please install Cursor CLI: https://cursor.com/docs/cli" -ForegroundColor Red
            exit 1
        }
        $WorkerName = "Cursor CLI"
    }
    "amp" {
        if (-not (Get-Command amp -ErrorAction SilentlyContinue)) {
            Write-Host "Error: 'amp' command not found. Please install Amp: https://ampcode.com" -ForegroundColor Red
            exit 1
        }
        $WorkerName = "Amp"
    }
    # Add new workers here:
    # "newworker" {
    #     if (-not (Get-Command newworker -ErrorAction SilentlyContinue)) {
    #         Write-Host "Error: 'newworker' command not found." -ForegroundColor Red
    #         exit 1
    #     }
    #     $WorkerName = "New Worker"
    # }
}

if (-not (Get-Command jq -ErrorAction SilentlyContinue)) {
    Write-Host "Error: 'jq' command not found. Please install jq: choco install jq" -ForegroundColor Red
    exit 1
}

# ═══════════════════════════════════════════════════════
# Worker Functions
# ═══════════════════════════════════════════════════════

function Invoke-CursorAgent {
    param($ProjectRoot, $PromptFile)
    
    $PromptContent = Get-Content $PromptFile -Raw
    & agent --print --force --workspace $ProjectRoot --output-format text $PromptContent 2>&1 | Tee-Object -Variable Output
    return $Output
}

function Invoke-AmpAgent {
    param($ProjectRoot, $PromptFile)
    
    Push-Location $ProjectRoot
    try {
        $PromptContent = Get-Content $PromptFile -Raw
        & amp --yes --print $PromptContent 2>&1 | Tee-Object -Variable Output
        return $Output
    }
    finally {
        Pop-Location
    }
}

# Add new worker functions here:
# function Invoke-NewWorkerAgent {
#     param($ProjectRoot, $PromptFile)
#     $PromptContent = Get-Content $PromptFile -Raw
#     & newworker --some-flag $ProjectRoot $PromptContent 2>&1 | Tee-Object -Variable Output
#     return $Output
# }

function Invoke-Agent {
    param($ProjectRoot, $PromptFile)
    
    switch ($Worker) {
        "cursor" { return Invoke-CursorAgent -ProjectRoot $ProjectRoot -PromptFile $PromptFile }
        "amp" { return Invoke-AmpAgent -ProjectRoot $ProjectRoot -PromptFile $PromptFile }
        # Add new workers here:
        # "newworker" { return Invoke-NewWorkerAgent -ProjectRoot $ProjectRoot -PromptFile $PromptFile }
    }
}

# ═══════════════════════════════════════════════════════
# Project Setup
# ═══════════════════════════════════════════════════════

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = $ScriptDir

# Find project root (where prd.json should be located)
for ($i = 0; $i -le 3; $i++) {
    if (Test-Path "$ProjectRoot\prd.json") {
        break
    }
    if ($ProjectRoot -eq (Split-Path -Qualifier $ProjectRoot)) {
        $ProjectRoot = $ScriptDir
        break
    }
    $ProjectRoot = Split-Path -Parent $ProjectRoot
}

$PrdFile = Join-Path $ProjectRoot "prd.json"
$ProgressFile = Join-Path $ProjectRoot "progress.txt"
$ArchiveDir = Join-Path $ProjectRoot "archive"
$LastBranchFile = Join-Path $ProjectRoot ".last-branch"
$PromptFile = Join-Path $ScriptDir "prompt.md"

# ═══════════════════════════════════════════════════════
# Git Branch Setup (runs once at start)
# ═══════════════════════════════════════════════════════

function Setup-GitBranch {
    if (-not (Test-Path $PrdFile)) {
        Write-Host "Warning: No prd.json found. Skipping git branch setup."
        return
    }
    
    $TargetBranch = (jq -r '.branchName // empty' $PrdFile 2>$null) -replace "`n", ""
    
    if (-not $TargetBranch) {
        Write-Host "Warning: No branchName in prd.json. Skipping git branch setup."
        return
    }
    
    $CurrentBranch = (git branch --show-current 2>$null) -replace "`n", ""
    
    if ($CurrentBranch -eq $TargetBranch) {
        Write-Host "✓ Already on branch: $TargetBranch" -ForegroundColor Green
        return
    }
    
    Write-Host "Setting up git branch: $TargetBranch"
    
    # Stash any uncommitted changes first
    $HasChanges = $false
    $DiffResult = git diff --quiet 2>$null
    $DiffCachedResult = git diff --cached --quiet 2>$null
    if ($LASTEXITCODE -ne 0) {
        $HasChanges = $true
    }
    
    if ($HasChanges) {
        Write-Host "   Stashing uncommitted changes..."
        git stash --include-untracked
        $script:Stashed = $true
    }
    else {
        $script:Stashed = $false
    }
    
    # Check if branch exists locally
    $BranchExists = git show-ref --verify --quiet "refs/heads/$TargetBranch" 2>$null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "   Switching to existing branch..."
        git checkout $TargetBranch
    }
    else {
        # Create branch from main (or master, or current)
        $BaseBranch = "main"
        $MainExists = git show-ref --verify --quiet "refs/heads/main" 2>$null
        if ($LASTEXITCODE -ne 0) {
            $MasterExists = git show-ref --verify --quiet "refs/heads/master" 2>$null
            if ($LASTEXITCODE -eq 0) {
                $BaseBranch = "master"
            }
            else {
                $BaseBranch = $CurrentBranch
            }
        }
        Write-Host "   Creating new branch from $BaseBranch..."
        git checkout -b $TargetBranch $BaseBranch
    }
    
    # Restore stashed changes
    if ($script:Stashed) {
        Write-Host "   Restoring stashed changes..."
        git stash pop 2>$null
        if ($LASTEXITCODE -ne 0) {
            Write-Host "   Warning: Could not restore stash (may be empty or conflicts)" -ForegroundColor Yellow
        }
    }
    
    Write-Host "✓ Now on branch: $TargetBranch" -ForegroundColor Green
}

# ═══════════════════════════════════════════════════════
# Archive Management
# ═══════════════════════════════════════════════════════

if ((Test-Path $PrdFile) -and (Test-Path $LastBranchFile)) {
    $CurrentBranch = (jq -r '.branchName // empty' $PrdFile 2>$null) -replace "`n", ""
    $LastBranch = (Get-Content $LastBranchFile -Raw) -replace "`n", ""
    
    if ($CurrentBranch -and $LastBranch -and $CurrentBranch -ne $LastBranch) {
        $Date = Get-Date -Format "yyyy-MM-dd"
        $FolderName = $LastBranch -replace "^ralph/", ""
        $ArchiveFolder = Join-Path $ArchiveDir "$Date-$FolderName"
        
        Write-Host "Archiving previous run: $LastBranch"
        New-Item -ItemType Directory -Force -Path $ArchiveFolder | Out-Null
        if (Test-Path $PrdFile) { Copy-Item $PrdFile $ArchiveFolder\ }
        if (Test-Path $ProgressFile) { Copy-Item $ProgressFile $ArchiveFolder\ }
        Write-Host "   Archived to: $ArchiveFolder"
        
        # Reset progress file for new run
        @"
# Ralph Progress Log
Started: $(Get-Date)
Worker: $WorkerName
---
"@ | Set-Content $ProgressFile
    }
}

# Track current branch
if (Test-Path $PrdFile) {
    $CurrentBranch = (jq -r '.branchName // empty' $PrdFile 2>$null) -replace "`n", ""
    if ($CurrentBranch) {
        $CurrentBranch | Set-Content $LastBranchFile
    }
}

# Initialize progress file if it doesn't exist
if (-not (Test-Path $ProgressFile)) {
    @"
# Ralph Progress Log
Started: $(Get-Date)
Worker: $WorkerName
---
"@ | Set-Content $ProgressFile
}

# ═══════════════════════════════════════════════════════
# Main Loop
# ═══════════════════════════════════════════════════════

Write-Host ""
Write-Host "╔═══════════════════════════════════════════════════════╗"
Write-Host "║  Ralph - Autonomous AI Agent Loop                     ║"
Write-Host "╠═══════════════════════════════════════════════════════╣"
Write-Host "║  Worker: $WorkerName"
Write-Host ("║  Max iterations: {0,-36}║" -f $MaxIterations)
Write-Host "╚═══════════════════════════════════════════════════════╝"

# Setup git branch before starting iterations
Setup-GitBranch

$ConsecutiveErrors = 0
$MaxRetries = 3
$RetryDelay = 10
$Iteration = 1

while ($Iteration -le $MaxIterations) {
    Write-Host ""
    Write-Host "═══════════════════════════════════════════════════════"
    Write-Host "  Ralph Iteration $Iteration of $MaxIterations ($WorkerName)"
    Write-Host "═══════════════════════════════════════════════════════"
    
    # Run the agent using the configured worker
    $Output = Invoke-Agent -ProjectRoot $ProjectRoot -PromptFile $PromptFile
    
    # Check for connection errors
    if ($Output -match "ConnectError|ETIMEDOUT|ECONNRESET|ENOTFOUND|connection refused|Connection refused") {
        $ConsecutiveErrors++
        Write-Host ""
        Write-Host "⚠️  Connection error detected ($ConsecutiveErrors consecutive)" -ForegroundColor Yellow
        
        if ($ConsecutiveErrors -ge $MaxRetries) {
            Write-Host "❌ Too many consecutive connection errors. Stopping." -ForegroundColor Red
            Write-Host "   Check your network connection and $WorkerName status."
            exit 1
        }
        
        $WaitTime = $RetryDelay * $ConsecutiveErrors
        Write-Host "   Waiting ${WaitTime}s before retry..."
        Start-Sleep -Seconds $WaitTime
        
        continue
    }
    
    $ConsecutiveErrors = 0
    
    # Check for completion signal
    if ($Output -match "<promise>COMPLETE</promise>") {
        Write-Host ""
        Write-Host "✅ Ralph completed all tasks!" -ForegroundColor Green
        Write-Host "Completed at iteration $Iteration of $MaxIterations"
        exit 0
    }
    
    Write-Host "Iteration $Iteration complete. Continuing..."
    $Iteration++
    Start-Sleep -Seconds 2
}

Write-Host ""
Write-Host "Ralph reached max iterations ($MaxIterations) without completing all tasks."
Write-Host "Check $ProgressFile for status."
exit 1
