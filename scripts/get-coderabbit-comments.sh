#!/usr/bin/env bash
set -euo pipefail

# Enhanced GitHub PR Comments Fetcher with AI Resolution Support
# Fetches all review comments from a GitHub PR and formats them for AI processing
# Supports tracking comment resolution state and AI-driven fixes

# Global variables for command-line options
PR=""
COMMAND=""
COMMENT_ID=""
OWNER=""
REPO=""

# Function to show usage information
show_usage() {
    echo "Enhanced GitHub PR Comments Fetcher with AI Resolution Support"
    echo ""
    echo "This script automatically detects the GitHub repository from the current git context."
    echo "Make sure you're in a GitHub repository with an 'origin' remote."
    echo ""
    echo "Usage: $0 <PR_NUMBER> [OPTIONS]"
    echo "       $0 --cleanup [OPTIONS]"
    echo "       $0 --help"
    echo ""
    echo "Commands:"
    echo "  (no command)                    Fetch and display all comments"
    echo "  --resolve <COMMENT_IDS>        Mark one or more comments as resolved by AI (comma-separated)"
    echo "  --status                        Show resolution status"
    echo "  --cleanup                       Clean up closed PRs and archive resolutions"
    echo "  --help                         Show this help"
    echo ""
    echo "Examples:"
    echo "  $0 123                          # Fetch all comments for PR 123"
    echo "  $0 123 --resolve 2386777571    # Mark single comment as resolved"
    echo "  $0 123 --resolve 2386777571,2386777572,2386777573  # Mark multiple comments as resolved"
    echo "  $0 123 --status                 # Show resolution status"
    echo "  $0 --cleanup                    # Clean up closed PRs and archive resolutions"
}

# Function to show error and usage
show_error() {
    local message="$1"
    echo "❌ Error: $message" >&2
    echo "" >&2
    show_usage >&2
    exit 1
}

# Function to parse command-line arguments
parse_arguments() {
    # Handle special cases first
    if [ $# -eq 0 ]; then
        show_error "Missing PR number argument"
    fi

    # Check for help first
    if [ "$1" = "--help" ] || [ "$1" = "-h" ]; then
        show_usage
        exit 0
    fi

    # Check for cleanup command
    if [ "$1" = "--cleanup" ]; then
        COMMAND="cleanup"
        return 0
    fi

    # First argument should be PR number
    if ! [[ "$1" =~ ^[0-9]+$ ]]; then
        show_error "First argument must be a PR number (got: $1)"
    fi
    PR="$1"
    shift

    # Parse remaining arguments
    while [ $# -gt 0 ]; do
        case "$1" in
            --resolve)
                if [ $# -lt 2 ]; then
                    show_error "--resolve requires one or more comment IDs (comma-separated)"
                fi
                COMMAND="resolve"
                COMMENT_ID="$2"
                shift 2
                ;;
            --status)
                COMMAND="status"
                shift
                ;;
            --help|-h)
                show_usage
                exit 0
                ;;
            *)
                show_error "Unknown option: $1"
                ;;
        esac
    done
}

# Check dependencies
if ! command -v gh &> /dev/null; then
    echo "❌ Error: GitHub CLI (gh) is not installed or not in PATH"
    exit 1
fi

if ! command -v jq &> /dev/null; then
    echo "❌ Error: jq is not installed or not in PATH"
    exit 1
fi

# Check if user is authenticated with GitHub CLI
if ! gh auth status &> /dev/null; then
    echo "❌ Error: Not authenticated with GitHub CLI"
    echo "Please run: gh auth login"
    exit 1
fi

# Auto-detect repository information from current git context
get_repo_info() {
    local remote_url
    remote_url=$(git remote get-url origin 2>/dev/null || echo "")

    if [ -z "$remote_url" ]; then
        echo "❌ Error: Not in a git repository or no 'origin' remote found"
        echo "Please run this script from within a git repository with a GitHub remote"
        exit 1
    fi

    # Extract owner and repo from various URL formats
    # GitHub HTTPS: https://github.com/owner/repo.git
    # GitHub SSH: git@github.com:owner/repo.git
    # GitHub HTTPS (no .git): https://github.com/owner/repo
    local owner_repo

    # Handle SSH format: git@github.com:owner/repo.git
    if [[ "$remote_url" =~ git@github\.com:([^/]+)/([^/]+) ]]; then
        local repo_name="${BASH_REMATCH[2]}"
        # Remove .git suffix if present
        repo_name="${repo_name%.git}"
        owner_repo="${BASH_REMATCH[1]}/${repo_name}"
    # Handle HTTPS format: https://github.com/owner/repo.git
    elif [[ "$remote_url" =~ https://github\.com/([^/]+)/([^/]+) ]]; then
        local repo_name="${BASH_REMATCH[2]}"
        # Remove .git suffix if present
        repo_name="${repo_name%.git}"
        owner_repo="${BASH_REMATCH[1]}/${repo_name}"
    else
        echo "❌ Error: Not a GitHub repository"
        echo "Remote URL: $remote_url"
        echo "Please ensure you're in a GitHub repository"
        exit 1
    fi

    echo "$owner_repo"
}

# Parse command-line arguments
parse_arguments "$@"

# Get repository information (skip for cleanup commands)
if [ "$COMMAND" != "cleanup" ]; then
    REPO_INFO=$(get_repo_info)
    OWNER=$(echo "$REPO_INFO" | cut -d'/' -f1)
    REPO=$(echo "$REPO_INFO" | cut -d'/' -f2)

    # Show detected repository information (only for non-status commands to avoid clutter)
    if [ "$COMMAND" != "status" ]; then
        echo "🔍 Detected repository: $OWNER/$REPO" >&2
    fi
fi

# Create output directory if it doesn't exist
mkdir -p .local

# Resolution tracking functions
get_resolution_file() {
    echo ".local/pr-$PR-resolutions.json"
}

load_resolutions() {
    local resolution_file
    resolution_file=$(get_resolution_file)
    if [ -f "$resolution_file" ]; then
        cat "$resolution_file"
    else
        echo '{"resolved_comments": [], "resolution_history": []}'
    fi
}

save_resolution() {
    local comment_id="$1"
    local resolution_file
    local current_resolutions
    local updated_resolutions

    resolution_file=$(get_resolution_file)
    current_resolutions=$(load_resolutions)

    # Add to resolved comments and history
    updated_resolutions=$(echo "$current_resolutions" | jq --arg comment_id "$comment_id" --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '
        .resolved_comments += [$comment_id] |
        .resolution_history += [{
            comment_id: $comment_id,
            resolved_at: $timestamp,
            resolved_by: "ai"
        }]
    ')

    echo "$updated_resolutions" > "$resolution_file"
}

save_multiple_resolutions() {
    local comment_ids="$1"
    local resolution_file
    local current_resolutions
    local updated_resolutions
    local timestamp

    resolution_file=$(get_resolution_file)
    current_resolutions=$(load_resolutions)
    timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)

    # Split comma-separated comment IDs and create resolution entries
    local IFS=','
    read -ra comment_id_array <<< "$comment_ids"
    local resolution_entries="[]"

    for comment_id in "${comment_id_array[@]}"; do
        # Trim whitespace
        comment_id=$(echo "$comment_id" | xargs)
        if [ -n "$comment_id" ]; then
            resolution_entries=$(echo "$resolution_entries" | jq --arg id "$comment_id" --arg ts "$timestamp" '
                . += [{
                    comment_id: $id,
                    resolved_at: $ts,
                    resolved_by: "ai"
                }]
            ')
        fi
    done

    # Add all resolved comments and history entries
    updated_resolutions=$(echo "$current_resolutions" | jq --argjson new_resolutions "$resolution_entries" '
        .resolved_comments = (.resolved_comments + ($new_resolutions | map(.comment_id))) |
        .resolution_history = (.resolution_history + $new_resolutions)
    ')

    echo "$updated_resolutions" > "$resolution_file"
}

show_resolution_status() {
    local resolution_file
    local resolutions
    local resolved_count
    local total_comments
    local comments_file

    resolution_file=$(get_resolution_file)
    comments_file=".local/pr-$PR-change-comments.json"

    if [ ! -f "$resolution_file" ]; then
        echo "📊 Resolution Status: No resolutions tracked yet"
        echo ""
        echo "❌ UNRESOLVED COMMENTS:"
        if [ -f "$comments_file" ]; then
            local unresolved_count
            unresolved_count=$(jq '.comments | map(select(.is_resolved == false)) | length' "$comments_file")
            if [ "$unresolved_count" -gt 0 ]; then
                jq -r '
                .comments | map(select(.is_resolved == false)) | .[] |
                "  ❌ \(.comment_id) - \(.file_path // "General") - \(.author) - \(.createdAt)"
                ' "$comments_file"
            else
                echo "  None"
            fi
        else
            echo "  ❌ Error: Comments file not found. Run without --status first to fetch comments."
        fi
        return
    fi

    if [ ! -f "$comments_file" ]; then
        echo "❌ Error: Comments file not found. Run without --status first to fetch comments."
        return 1
    fi

    # Local state is already up to date when called from --status

    resolutions=$(cat "$resolution_file")
    resolved_count=$(jq '.metadata.resolved_comments // 0' "$comments_file" 2>/dev/null || echo "0")
    total_comments=$(jq '.metadata.total_comments // 0' "$comments_file" 2>/dev/null || echo "0")

    echo "📊 Resolution Status:"
    echo "  Resolved: $resolved_count"
    echo "  Total: $total_comments"
    if [ "${total_comments:-0}" -gt 0 ]; then
        progress=$(( resolved_count * 100 / total_comments ))
    else
        progress=0
    fi
    echo "  Progress: ${progress}%"
    echo ""

    # Show resolved comments
    echo "✅ RESOLVED COMMENTS:"
    if [ "$resolved_count" -gt 0 ]; then
        jq -r '
        .comments | map(select(.is_resolved == true)) | .[] |
        "  ✅ \(.comment_id) - \(.file_path // "General") - \(.author) - \(.createdAt)"
        ' "$comments_file"
    else
        echo "  None"
    fi
    echo ""

    # Show unresolved comments
    echo "❌ UNRESOLVED COMMENTS:"
    local unresolved_count
    unresolved_count=$(jq '.comments | map(select(.is_resolved == false)) | length' "$comments_file")

    if [ "$unresolved_count" -gt 0 ]; then
        jq -r '
        .comments | map(select(.is_resolved == false)) | .[] |
        "  ❌ \(.comment_id) - \(.file_path // "General") - \(.author) - \(.createdAt)"
        ' "$comments_file"
    else
        echo "  None"
    fi
    echo ""

    # Show recent resolution history
    echo "📝 Recent Resolutions:"
    echo "$resolutions" | jq -r '.resolution_history[-5:] | .[] | "  ✅ \(.comment_id) - \(.resolved_at) (\(.resolved_by))"'
}

# Cleanup function to archive closed PRs
cleanup_closed_prs() {
    echo "🧹 Starting cleanup of closed PRs..." >&2

    # Create archive directory if it doesn't exist
    mkdir -p .local/_Archive

    # Find all PR files
    local pr_files
    pr_files=$(find .local -name "pr-*-change-comments.json" -o -name "pr-*-summary.txt" -o -name "pr-*-resolutions.json" | sort -u)

    if [ -z "$pr_files" ]; then
        echo "ℹ️  No PR files found to clean up" >&2
        return 0
    fi

    # Extract unique PR numbers
    local pr_numbers
    pr_numbers=$(echo "$pr_files" | grep -o 'pr-[0-9]\+' | sed 's/pr-//' | sort -u)

    local cleaned_count=0
    local archived_count=0

    for pr_num in $pr_numbers; do
        echo "🔍 Checking PR #$pr_num..." >&2

        # Check if PR is closed using GitHub CLI
        pr_state=$(gh pr view "$pr_num" --json state --jq '.state' 2>/dev/null || echo "unknown")

        if [ "$pr_state" = "CLOSED" ] || [ "$pr_state" = "MERGED" ]; then
            echo "  📦 PR #$pr_num is $pr_state - archiving..." >&2

            # Archive resolution file if it exists
            resolution_file=".local/pr-$pr_num-resolutions.json"
            if [ -f "$resolution_file" ]; then
                mv "$resolution_file" ".local/_Archive/pr-$pr_num-resolutions.json"
                echo "    ✅ Archived resolutions" >&2
                archived_count=$((archived_count + 1))
            fi

            # Remove JSON and summary files
            rm -f ".local/pr-$pr_num-change-comments.json"
            rm -f ".local/pr-$pr_num-summary.txt"
            echo "    🗑️  Removed JSON and summary files" >&2
            cleaned_count=$((cleaned_count + 1))
        elif [ "$pr_state" = "unknown" ]; then
            echo "  ⚠️  Could not determine state of PR #$pr_num (may not exist or no access)" >&2
        else
            echo "  ✅ PR #$pr_num is $pr_state - keeping files" >&2
        fi
    done

    echo "" >&2
    echo "🧹 Cleanup completed:" >&2
    echo "  📦 Archived: $archived_count PRs" >&2
    echo "  🗑️  Cleaned: $cleaned_count PRs" >&2

    if [ $archived_count -gt 0 ]; then
        echo "  📁 Archive location: .local/_Archive/" >&2
    fi
}

# Update local comments file with current resolution state
update_local_comments_state() {
    local comments_file=".local/pr-$PR-change-comments.json"
    local resolution_file
    resolution_file=$(get_resolution_file)

    if [ ! -f "$comments_file" ] || [ ! -f "$resolution_file" ]; then
        return 0
    fi

    local resolutions
    resolutions=$(cat "$resolution_file")
    local resolved_comments
    resolved_comments=$(echo "$resolutions" | jq -r '.resolved_comments[]')

    # Update the comments file with current resolution state
    jq --argjson resolved_list "$(echo "$resolved_comments" | jq -R -s 'if length > 0 then split("\n")[:-1] else [] end')" '
        def is_resolved($comment_id):
            $resolved_list | contains([$comment_id]);

        .comments = (.comments | map(.is_resolved = is_resolved(.comment_id))) |
        .metadata.resolved_comments = ($resolved_list | length) |
        .metadata.unresolved_comments = ((.comments | length) - ($resolved_list | length)) |
        .metadata.resolution_rate = (if (.comments | length) > 0 then (($resolved_list | length) * 100 / (.comments | length)) | floor else 0 end)
    ' "$comments_file" > "$comments_file.tmp" && mv "$comments_file.tmp" "$comments_file"
}

# Handle resolution commands
if [ "$COMMAND" = "resolve" ]; then
    # Check if multiple comment IDs are provided (comma-separated)
    if [[ "$COMMENT_ID" == *","* ]]; then
        save_multiple_resolutions "$COMMENT_ID"
        update_local_comments_state
        # Count the number of resolved comments
        count=$(echo "$COMMENT_ID" | tr ',' '\n' | wc -l | xargs)
        echo "✅ $count comments marked as resolved: $COMMENT_ID"
    else
        save_resolution "$COMMENT_ID"
        update_local_comments_state
        echo "✅ Comment $COMMENT_ID marked as resolved"
    fi
    exit 0
fi

if [ "$COMMAND" = "cleanup" ]; then
    cleanup_closed_prs
    exit 0
fi

if [ "$COMMAND" = "status" ]; then
    # Check if we have a local comments file - if so, use it directly without hitting API
    if [ -f ".local/pr-$PR-change-comments.json" ]; then
        show_resolution_status
        exit 0
    else
        echo "❌ Error: No local comments file found. Run without --status first to fetch comments."
        exit 1
    fi
fi

# Only fetch from API if we're not doing resolve command
if [ "$COMMAND" != "resolve" ]; then
    echo "Fetching review threads for PR #$PR..." >&2
# Fetch review threads with pagination
echo "Fetching review threads..." >&2
gh api graphql --paginate -f query="
query(\$owner:String!, \$name:String!, \$number:Int!, \$cursor:String) {
  repository(owner:\$owner, name:\$name) {
    pullRequest(number:\$number) {
      reviewThreads(first:100, after:\$cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          isResolved
          comments(first:50) {
            nodes {
              id
              body path position url createdAt updatedAt
              author { login }
            }
          }
        }
      }
    }
  }
}
" -F owner="$OWNER" -F name="$REPO" -F number="$PR" > .local/temp-threads.json

# Fetch PR comments with pagination
echo "Fetching PR comments..." >&2
gh api graphql --paginate -f query="
query(\$owner:String!, \$name:String!, \$number:Int!, \$cursor:String) {
  repository(owner:\$owner, name:\$name) {
    pullRequest(number:\$number) {
      comments(first:50, after:\$cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id body url createdAt updatedAt
          author { login }
        }
      }
    }
  }
}
" -F owner="$OWNER" -F name="$REPO" -F number="$PR" > .local/temp-comments.json

# Process the data
echo "Processing comments..." >&2

# Load resolution data
RESOLUTIONS=$(load_resolutions)

jq -n --slurpfile threads .local/temp-threads.json --slurpfile comments .local/temp-comments.json --arg pr_number "$PR" --arg owner "$OWNER" --arg repo "$REPO" --argjson resolutions "$RESOLUTIONS" '
  def has_changes($s):
    ($s|test("```diff")) or ($s|test("```patch")) or ($s|test("```suggestion"));

  def extract_priority($body):
    if ($body|test("Major")) then "major"
    elif ($body|test("Minor")) then "minor"
    elif ($body|test("Trivial")) then "trivial"
    else "unknown"
    end;

  def extract_category($body):
    if ($body|test("Nitpick")) then "nitpick"
    elif ($body|test("Potential issue")) then "issue"
    elif ($body|test("Refactor")) then "refactor"
    else "other"
    end;

  def extract_file_path($body):
    # Look for patterns like "In src/utils/config.ts around lines"
    ($body | match("In ([^\\s]+) around lines") | .captures[0].string) //
    ($body | match("In ([^\\s]+) around line") | .captures[0].string) //
    ($body | match("In ([^\\s]+) at line") | .captures[0].string) //
    ($body | match("In ([^\\s]+) at lines") | .captures[0].string) //
    # Look for patterns in AI agent prompts like "filename around lines"
    ($body | match("([^\\s]+\\.(ts|js|json|md|txt|yml|yaml)) around lines") | .captures[0].string) //
    ($body | match("([^\\s]+\\.(ts|js|json|md|txt|yml|yaml)) around line") | .captures[0].string) //
    null;

  def extract_line_range($body):
    # Look for patterns like "around lines 26 to 56" or "around line 26"
    ($body | match("around lines? ([0-9]+)(?: to ([0-9]+))?") |
     if .captures[1].string then (.captures[0].string + "-" + .captures[1].string)
     else .captures[0].string end) //
    ($body | match("at lines? ([0-9]+)(?: to ([0-9]+))?") |
     if .captures[1].string then (.captures[0].string + "-" + .captures[1].string)
     else .captures[0].string end) //
    null;

  # Check if comment is resolved
  def is_resolved($comment_id):
    $resolutions.resolved_comments | contains([$comment_id]);

  # Process inline comments
  def process_inline_comments:
    $threads[0].data.repository.pullRequest.reviewThreads.nodes
    | map(.comments.nodes[])
    | map({
        type: "inline-comment",
        author: .author.login,
        path, position, url,
        createdAt, updatedAt,
        body,
        priority: extract_priority(.body),
        category: extract_category(.body),
        file_path: (.path // extract_file_path(.body)),
        line_range: extract_line_range(.body),
        has_code_changes: has_changes(.body),
        is_resolved: is_resolved(.id),
        comment_id: .id
      });

  # Process PR comments
  def process_pr_comments:
    $comments[0].data.repository.pullRequest.comments.nodes
    | map({
        type: "pr-comment",
        author: .author.login,
        path: null,
        position: null,
        url,
        createdAt, updatedAt,
        body,
        priority: extract_priority(.body),
        category: extract_category(.body),
        file_path: extract_file_path(.body),
        line_range: extract_line_range(.body),
        has_code_changes: has_changes(.body),
        is_resolved: is_resolved(.id),
        comment_id: .id
      });

  # Combine and sort all comments
  def all_comments:
    (process_inline_comments + process_pr_comments) | sort_by(.createdAt);

  # Generate summary statistics
  def generate_summary($comments):
    {
      total_comments: ($comments | length),
      by_type: ($comments | sort_by(.type) | group_by(.type) | map({type: .[0].type, count: length})),
      by_author: ($comments | sort_by(.author) | group_by(.author) | map({author: .[0].author, count: length})),
      by_priority: ($comments | sort_by(.priority) | group_by(.priority) | map({priority: .[0].priority, count: length})),
      by_category: ($comments | sort_by(.category) | group_by(.category) | map({category: .[0].category, count: length})),
      by_file: ($comments | map(select(.file_path != null)) | sort_by(.file_path) | group_by(.file_path) | map({file: .[0].file_path, count: length})),
      inline_comments: ($comments | map(select(.type == "inline-comment")) | length),
      pr_comments: ($comments | map(select(.type == "pr-comment")) | length),
      with_code_changes: ($comments | map(select(.has_code_changes == true)) | length),
      without_code_changes: ($comments | map(select(.has_code_changes == false)) | length),
      resolved_comments: ($comments | map(select(.is_resolved == true)) | length),
      unresolved_comments: ($comments | map(select(.is_resolved == false)) | length),
      resolution_rate: (if ($comments | length) > 0 then (($comments | map(select(.is_resolved == true)) | length) * 100 / ($comments | length)) | floor else 0 end)
    };

  # Main output structure
  (all_comments) as $comments |
  {
    metadata: {
      pr_number: ($pr_number | tonumber),
      repository: ($owner + "/" + $repo),
      generated_at: now | strftime("%Y-%m-%dT%H:%M:%SZ"),
      total_comments: ($comments | length)
    },
    summary: generate_summary($comments),
    comments: $comments
  }
' > .local/pr-"$PR"-change-comments.json

# Update resolution state after fetching comments
update_local_comments_state

# Generate a human-readable summary
echo "Generating summary..." >&2
jq -r '
  "=== PR #\(.metadata.pr_number) Review Comments Summary ===",
  "Repository: \(.metadata.repository)",
  "Generated: \(.metadata.generated_at)",
  "",
  "📊 STATISTICS:",
  "Total Comments: \(.summary.total_comments)",
  "Resolved: \(.summary.resolved_comments)",
  "Unresolved: \(.summary.unresolved_comments)",
  "Resolution Rate: \(.summary.resolution_rate)%",
  "Inline Comments: \(.summary.inline_comments)",
  "PR Comments: \(.summary.pr_comments)",
  "With Code Changes: \(.summary.with_code_changes)",
  "Without Code Changes: \(.summary.without_code_changes)",
  "",
  "👥 BY AUTHOR:",
  (.summary.by_author[] | "  \(.author): \(.count) comments"),
  "",
  "🎯 BY PRIORITY:",
  (.summary.by_priority[] | "  \(.priority): \(.count) comments"),
  "",
  "📁 BY FILE:",
  (.summary.by_file[] | "  \(.file): \(.count) comments"),
  "",
  "📝 COMMENTS BY FILE:",
  "",
  # Group comments by file
  (.comments | group_by(.file_path) | map({
    file: .[0].file_path,
    comments: .
  }) | sort_by(.file) | .[] |
    "📁 FILE: \(.file // "General PR Comments")",
    "   Comments: \(.comments | length)",
    "",
    (.comments[] |
      "  ┌─ \(.type | ascii_upcase) | \(.priority | ascii_upcase) | \(.category | ascii_upcase)\(if .is_resolved then " | ✅ RESOLVED" else "" end)",
      "  │ File: \(.file_path // "N/A")",
      "  │ Author: \(.author)",
      "  │ Created: \(.createdAt)",
      "  │ Lines: \(.line_range // "N/A")",
      "  │ URL: \(.url)",
      "  │ Comment ID: \(.comment_id)",
      "  │",
      "  │ \(.body | split("\n") | join("\n  │ "))",
      "  └─",
      ""
    )
  )
' .local/pr-"$PR"-change-comments.json > .local/pr-"$PR"-summary.txt

# Clean up temp files
rm -f .local/temp-threads.json .local/temp-comments.json

echo "✅ Successfully generated:" >&2
echo "  📄 JSON: .local/pr-$PR-change-comments.json" >&2
echo "  📋 Summary: .local/pr-$PR-summary.txt" >&2
echo "" >&2
echo "📊 Quick stats:" >&2
jq -r '"Total: \(.summary.total_comments), Resolved: \(.summary.resolved_comments), Unresolved: \(.summary.unresolved_comments), Rate: \(.summary.resolution_rate)%"' .local/pr-"$PR"-change-comments.json >&2
echo "" >&2
echo "❌ UNRESOLVED COMMENTS:" >&2
jq -r '
.comments | map(select(.is_resolved == false)) | .[] |
"  ❌ \(.comment_id) - \(.file_path // "General") - \(.author) - \(.createdAt)"
' .local/pr-"$PR"-change-comments.json >&2
fi
