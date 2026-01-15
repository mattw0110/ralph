#!/bin/bash
# Ralph Wiggum - Long-running AI agent loop
# Usage: ./ralph.sh [--worker amp|cursor] [max_iterations]
#
# Workers:
#   cursor (default) - Uses Cursor CLI 'agent' command
#   amp              - Uses Amp CLI 'amp' command

set -e

# ═══════════════════════════════════════════════════════
# Parse Arguments
# ═══════════════════════════════════════════════════════

WORKER="cursor"  # Default worker
MAX_ITERATIONS=10

while [[ $# -gt 0 ]]; do
  case $1 in
    --worker|-w)
      WORKER="$2"
      shift 2
      ;;
    --help|-h)
      echo "Usage: ./ralph.sh [--worker amp|cursor] [max_iterations]"
      echo ""
      echo "Workers:"
      echo "  cursor (default) - Uses Cursor CLI 'agent' command"
      echo "  amp              - Uses Amp CLI 'amp' command"
      echo ""
      echo "Examples:"
      echo "  ./ralph.sh                    # Run with cursor, 10 iterations"
      echo "  ./ralph.sh 20                 # Run with cursor, 20 iterations"
      echo "  ./ralph.sh --worker amp 15    # Run with amp, 15 iterations"
      echo "  ./ralph.sh -w cursor 10       # Run with cursor, 10 iterations"
      exit 0
      ;;
    *)
      # Assume it's max_iterations if it's a number
      if [[ "$1" =~ ^[0-9]+$ ]]; then
        MAX_ITERATIONS="$1"
      else
        echo "Unknown option: $1"
        echo "Use --help for usage"
        exit 1
      fi
      shift
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ═══════════════════════════════════════════════════════
# Worker Configuration
# ═══════════════════════════════════════════════════════

# Validate worker and check for required commands
case $WORKER in
  cursor)
    if ! command -v agent &> /dev/null; then
      echo "Error: 'agent' command not found. Please install Cursor CLI: https://cursor.com/docs/cli"
      exit 1
    fi
    WORKER_NAME="Cursor CLI"
    ;;
  amp)
    if ! command -v amp &> /dev/null; then
      echo "Error: 'amp' command not found. Please install Amp: https://ampcode.com"
      exit 1
    fi
    WORKER_NAME="Amp"
    ;;
  # Add new workers here:
  # newworker)
  #   if ! command -v newworker &> /dev/null; then
  #     echo "Error: 'newworker' command not found."
  #     exit 1
  #   fi
  #   WORKER_NAME="New Worker"
  #   ;;
  *)
    echo "Error: Unknown worker '$WORKER'"
    echo "Available workers: cursor, amp"
    exit 1
    ;;
esac

if ! command -v jq &> /dev/null; then
  echo "Error: 'jq' command not found. Please install jq: brew install jq"
  exit 1
fi

# ═══════════════════════════════════════════════════════
# Worker Functions
# ═══════════════════════════════════════════════════════

run_cursor_agent() {
  local project_root="$1"
  local prompt_file="$2"
  
  # --print flag is required for non-interactive mode and enables shell execution
  # --force flag forces allow commands unless explicitly denied
  # --workspace sets the working directory
  agent --print --force --workspace "$project_root" --output-format text "$(cat "$prompt_file")" 2>&1 | tee /dev/stderr
}

run_amp_agent() {
  local project_root="$1"
  local prompt_file="$2"
  
  # Change to project directory for amp
  cd "$project_root"
  
  # amp uses different flags:
  # --yes to auto-approve commands
  # --print for output
  amp --yes --print "$(cat "$prompt_file")" 2>&1 | tee /dev/stderr
}

# Add new worker functions here:
# run_newworker_agent() {
#   local project_root="$1"
#   local prompt_file="$2"
#   newworker --some-flag "$project_root" "$(cat "$prompt_file")" 2>&1 | tee /dev/stderr
# }

run_agent() {
  local project_root="$1"
  local prompt_file="$2"
  
  case $WORKER in
    cursor)
      run_cursor_agent "$project_root" "$prompt_file"
      ;;
    amp)
      run_amp_agent "$project_root" "$prompt_file"
      ;;
    # Add new workers here:
    # newworker)
    #   run_newworker_agent "$project_root" "$prompt_file"
    #   ;;
  esac
}

# ═══════════════════════════════════════════════════════
# Project Setup
# ═══════════════════════════════════════════════════════

# Find project root (where prd.json should be located)
# Check script directory first, then parent directories up to 3 levels
PROJECT_ROOT="$SCRIPT_DIR"
for i in {0..3}; do
  if [ -f "$PROJECT_ROOT/prd.json" ]; then
    break
  fi
  if [ "$PROJECT_ROOT" = "/" ]; then
    # Fallback to script directory if not found
    PROJECT_ROOT="$SCRIPT_DIR"
    break
  fi
  PROJECT_ROOT="$(dirname "$PROJECT_ROOT")"
done

PRD_FILE="$PROJECT_ROOT/prd.json"
PROGRESS_FILE="$PROJECT_ROOT/progress.txt"
ARCHIVE_DIR="$PROJECT_ROOT/archive"
LAST_BRANCH_FILE="$PROJECT_ROOT/.last-branch"
PROMPT_FILE="$SCRIPT_DIR/prompt.md"

# ═══════════════════════════════════════════════════════
# Git Branch Setup (runs once at start)
# ═══════════════════════════════════════════════════════

setup_git_branch() {
  if [ ! -f "$PRD_FILE" ]; then
    echo "Warning: No prd.json found. Skipping git branch setup."
    return 0
  fi
  
  local target_branch
  target_branch=$(jq -r '.branchName // empty' "$PRD_FILE" 2>/dev/null || echo "")
  
  if [ -z "$target_branch" ]; then
    echo "Warning: No branchName in prd.json. Skipping git branch setup."
    return 0
  fi
  
  local current_branch
  current_branch=$(git branch --show-current 2>/dev/null || echo "")
  
  if [ "$current_branch" = "$target_branch" ]; then
    echo "✓ Already on branch: $target_branch"
    return 0
  fi
  
  echo "Setting up git branch: $target_branch"
  
  # Stash any uncommitted changes first
  if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
    echo "   Stashing uncommitted changes..."
    git stash --include-untracked
    STASHED=1
  else
    STASHED=0
  fi
  
  # Check if branch exists locally
  if git show-ref --verify --quiet "refs/heads/$target_branch" 2>/dev/null; then
    echo "   Switching to existing branch..."
    git checkout "$target_branch"
  else
    # Create branch from main (or master, or current)
    local base_branch="main"
    if ! git show-ref --verify --quiet "refs/heads/main" 2>/dev/null; then
      if git show-ref --verify --quiet "refs/heads/master" 2>/dev/null; then
        base_branch="master"
      else
        base_branch="$current_branch"
      fi
    fi
    echo "   Creating new branch from $base_branch..."
    git checkout -b "$target_branch" "$base_branch"
  fi
  
  # Restore stashed changes
  if [ "$STASHED" = "1" ]; then
    echo "   Restoring stashed changes..."
    git stash pop || echo "   Warning: Could not restore stash (may be empty or conflicts)"
  fi
  
  echo "✓ Now on branch: $target_branch"
}

# ═══════════════════════════════════════════════════════
# Archive Management
# ═══════════════════════════════════════════════════════

# Archive previous run if branch changed
if [ -f "$PRD_FILE" ] && [ -f "$LAST_BRANCH_FILE" ]; then
  CURRENT_BRANCH=$(jq -r '.branchName // empty' "$PRD_FILE" 2>/dev/null || echo "")
  LAST_BRANCH=$(cat "$LAST_BRANCH_FILE" 2>/dev/null || echo "")
  
  if [ -n "$CURRENT_BRANCH" ] && [ -n "$LAST_BRANCH" ] && [ "$CURRENT_BRANCH" != "$LAST_BRANCH" ]; then
    # Archive the previous run
    DATE=$(date +%Y-%m-%d)
    # Strip "ralph/" prefix from branch name for folder
    FOLDER_NAME=$(echo "$LAST_BRANCH" | sed 's|^ralph/||')
    ARCHIVE_FOLDER="$ARCHIVE_DIR/$DATE-$FOLDER_NAME"
    
    echo "Archiving previous run: $LAST_BRANCH"
    mkdir -p "$ARCHIVE_FOLDER"
    [ -f "$PRD_FILE" ] && cp "$PRD_FILE" "$ARCHIVE_FOLDER/"
    [ -f "$PROGRESS_FILE" ] && cp "$PROGRESS_FILE" "$ARCHIVE_FOLDER/"
    echo "   Archived to: $ARCHIVE_FOLDER"
    
    # Reset progress file for new run
    echo "# Ralph Progress Log" > "$PROGRESS_FILE"
    echo "Started: $(date)" >> "$PROGRESS_FILE"
    echo "Worker: $WORKER_NAME" >> "$PROGRESS_FILE"
    echo "---" >> "$PROGRESS_FILE"
  fi
fi

# Track current branch
if [ -f "$PRD_FILE" ]; then
  CURRENT_BRANCH=$(jq -r '.branchName // empty' "$PRD_FILE" 2>/dev/null || echo "")
  if [ -n "$CURRENT_BRANCH" ]; then
    echo "$CURRENT_BRANCH" > "$LAST_BRANCH_FILE"
  fi
fi

# Initialize progress file if it doesn't exist
if [ ! -f "$PROGRESS_FILE" ]; then
  echo "# Ralph Progress Log" > "$PROGRESS_FILE"
  echo "Started: $(date)" >> "$PROGRESS_FILE"
  echo "Worker: $WORKER_NAME" >> "$PROGRESS_FILE"
  echo "---" >> "$PROGRESS_FILE"
fi

# ═══════════════════════════════════════════════════════
# Main Loop
# ═══════════════════════════════════════════════════════

echo ""
echo "╔═══════════════════════════════════════════════════════╗"
echo "║  Ralph - Autonomous AI Agent Loop                     ║"
echo "╠═══════════════════════════════════════════════════════╣"
echo "║  Worker: $WORKER_NAME"
printf "║  Max iterations: %-36s║\n" "$MAX_ITERATIONS"
echo "╚═══════════════════════════════════════════════════════╝"

# Setup git branch before starting iterations
setup_git_branch

CONSECUTIVE_ERRORS=0
MAX_RETRIES=3
RETRY_DELAY=10
ITERATION=1

while [ $ITERATION -le $MAX_ITERATIONS ]; do
  echo ""
  echo "═══════════════════════════════════════════════════════"
  echo "  Ralph Iteration $ITERATION of $MAX_ITERATIONS ($WORKER_NAME)"
  echo "═══════════════════════════════════════════════════════"
  
  # Run the agent using the configured worker
  OUTPUT=$(run_agent "$PROJECT_ROOT" "$PROMPT_FILE") || true
  
  # Check for connection errors - these mean the iteration didn't actually run
  if echo "$OUTPUT" | grep -qE "ConnectError|ETIMEDOUT|ECONNRESET|ENOTFOUND|connection refused|Connection refused"; then
    CONSECUTIVE_ERRORS=$((CONSECUTIVE_ERRORS + 1))
    echo ""
    echo "⚠️  Connection error detected ($CONSECUTIVE_ERRORS consecutive)"
    
    if [ $CONSECUTIVE_ERRORS -ge $MAX_RETRIES ]; then
      echo "❌ Too many consecutive connection errors. Stopping."
      echo "   Check your network connection and $WORKER_NAME status."
      exit 1
    fi
    
    # Exponential backoff: 10s, 20s, 40s...
    WAIT_TIME=$((RETRY_DELAY * CONSECUTIVE_ERRORS))
    echo "   Waiting ${WAIT_TIME}s before retry..."
    sleep $WAIT_TIME
    
    # Don't increment iteration - retry this one
    continue
  fi
  
  # Reset error counter on successful connection
  CONSECUTIVE_ERRORS=0
  
  # Check for completion signal
  if echo "$OUTPUT" | grep -q "<promise>COMPLETE</promise>"; then
    echo ""
    echo "✅ Ralph completed all tasks!"
    echo "Completed at iteration $ITERATION of $MAX_ITERATIONS"
    exit 0
  fi
  
  echo "Iteration $ITERATION complete. Continuing..."
  ITERATION=$((ITERATION + 1))
  sleep 2
done

echo ""
echo "Ralph reached max iterations ($MAX_ITERATIONS) without completing all tasks."
echo "Check $PROGRESS_FILE for status."
exit 1
