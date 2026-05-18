<#
.SYNOPSIS
  Sync fork (Benb251/flowboard) with upstream (crisng95/flowboard).

.DESCRIPTION
  Workflow:
    1. Fetch upstream (`origin`) and fork (`fork`).
    2. Fast-forward local `main` to `origin/main`.
    3. Push updated `main` to `fork`.
    4. Optionally rebase a feature branch onto the new `main`.

  Remotes expected:
    origin -> https://github.com/crisng95/flowboard.git   (upstream, read source)
    fork   -> https://github.com/Benb251/flowboard.git    (your fork, push target)

.PARAMETER Branch
  Feature branch to rebase onto the synced main.
  Default: the branch you are currently on (skipped if it is `main`).
  Pass `-Branch none` to skip rebase entirely.

.PARAMETER Push
  Push the rebased feature branch to `fork` with --force-with-lease.

.PARAMETER NoFetch
  Skip the initial `git fetch` (use cached refs).

.EXAMPLE
  .\scripts\sync-upstream.ps1
  # Sync main, then rebase current branch onto main.

.EXAMPLE
  .\scripts\sync-upstream.ps1 -Push
  # Same as above, plus push the rebased branch to fork.

.EXAMPLE
  .\scripts\sync-upstream.ps1 -Branch none
  # Only sync main, do not touch any feature branch.
#>

[CmdletBinding()]
param(
    [string]$Branch = "",
    [switch]$Push,
    [switch]$NoFetch
)

$ErrorActionPreference = "Stop"

function Write-Step {
    param([string]$Message)
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Invoke-Git {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$GitArgs)
    Write-Host "  git $($GitArgs -join ' ')" -ForegroundColor DarkGray
    & git @GitArgs
    if ($LASTEXITCODE -ne 0) {
        throw "git $($GitArgs -join ' ') failed (exit $LASTEXITCODE)"
    }
}

# --- Sanity checks --------------------------------------------------------

$repoRoot = (& git rev-parse --show-toplevel 2>$null)
if ($LASTEXITCODE -ne 0) {
    throw "Not inside a git repository. cd into the flowboard repo first."
}
Set-Location $repoRoot

$remotes = (& git remote) -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ }
foreach ($r in @("origin", "fork")) {
    if ($remotes -notcontains $r) {
        throw "Missing remote '$r'. Configure: origin=upstream, fork=your fork."
    }
}

$status = & git status --porcelain --untracked-files=no
if ($status) {
    Write-Warning "Working tree is dirty. Commit or stash before syncing:"
    Write-Host $status
    throw "Aborting: dirty working tree."
}

$currentBranch = (& git rev-parse --abbrev-ref HEAD).Trim()
if (-not $Branch) {
    $Branch = if ($currentBranch -eq "main") { "none" } else { $currentBranch }
}

Write-Host "Repo:    $repoRoot"
Write-Host "Current: $currentBranch"
Write-Host "Rebase:  $Branch"

# --- 1. Fetch -------------------------------------------------------------

if (-not $NoFetch) {
    Write-Step "Fetching origin (upstream) and fork"
    Invoke-Git fetch origin --prune
    Invoke-Git fetch fork   --prune
} else {
    Write-Step "Skipping fetch (--NoFetch)"
}

# --- 2. Update local main -------------------------------------------------

Write-Step "Updating local main from origin/main"
Invoke-Git checkout main

$ahead = (& git rev-list --count origin/main..main).Trim()
if ([int]$ahead -gt 0) {
    throw "Local main is $ahead commit(s) ahead of origin/main. Refusing fast-forward (you have unpushed work on main)."
}

Invoke-Git merge --ff-only origin/main

# --- 3. Push main to fork -------------------------------------------------

Write-Step "Pushing main to fork"
Invoke-Git push fork main

# --- 4. Rebase feature branch (optional) ----------------------------------

if ($Branch -and $Branch -ne "none" -and $Branch -ne "main") {
    Write-Step "Rebasing $Branch onto main"
    Invoke-Git checkout $Branch

    & git rebase main
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "Rebase has conflicts. Resolve them, then run:"
        Write-Host "    git rebase --continue" -ForegroundColor Yellow
        if ($Push) {
            Write-Host "    git push fork $Branch --force-with-lease" -ForegroundColor Yellow
        }
        Write-Host "Or abort with: git rebase --abort" -ForegroundColor Yellow
        exit 1
    }

    if ($Push) {
        Write-Step "Pushing $Branch to fork (force-with-lease)"
        Invoke-Git push fork $Branch --force-with-lease
    } else {
        Write-Host ""
        Write-Host "Branch $Branch rebased locally. To publish:" -ForegroundColor Yellow
        Write-Host "    git push fork $Branch --force-with-lease" -ForegroundColor Yellow
    }
} else {
    if ($currentBranch -ne "main") {
        Invoke-Git checkout $currentBranch
    }
}

Write-Step "Done"
Write-Host "main is in sync with origin/main and pushed to fork." -ForegroundColor Green

