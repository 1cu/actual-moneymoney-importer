#!/usr/bin/env python3
"""
Enhanced GitHub PR Comments Fetcher with AI Resolution Support
Supports distinguishing between "resolved" (fixed) and "skipped" (intentionally ignored) comments

Usage:
    python3 get-coderabbit-comments.py <PR_NUMBER> [OPTIONS]
    python3 get-coderabbit-comments.py --help

Examples:
    python3 get-coderabbit-comments.py 123 --status
    python3 get-coderabbit-comments.py 123 --status-unresolved
    python3 get-coderabbit-comments.py 123 --show COMMENT_ID
    python3 get-coderabbit-comments.py 123 --resolve COMMENT_ID1,COMMENT_ID2
    python3 get-coderabbit-comments.py 123 --skip COMMENT_ID1,COMMENT_ID2
"""

import argparse
import json
import os
import re
import sys
import subprocess
import logging
from pathlib import Path
from typing import List, Dict, Any, Optional, Tuple
from dataclasses import dataclass
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor

try:
    from rich.console import Console
    from rich.table import Table
    from rich.panel import Panel
    # Rich imports for enhanced formatting

    RICH_AVAILABLE = True
except ImportError:
    RICH_AVAILABLE = False

# Configure logging
logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)


# Constants for magic numbers
class Constants:
    """Constants to unify magic numbers throughout the script"""

    # Unified values
    TIMEOUT = 30  # Single timeout for all operations
    BATCH_SIZE = 100  # Single batch size for all operations
    MAX_WORKERS = 3  # Single thread pool size
    GRAPHQL_LIMIT = 100  # Single GraphQL limit for all queries

    # Thresholds
    LARGE_PR_THRESHOLD = 100
    PARALLEL_PROCESSING_THRESHOLD = 10

    # Display settings
    TABLE_COLUMN_WIDTHS = {
        "status": 12,
        "priority": 8,
        "category": 10,
        "author": 12,
        "date": 10,
    }

    # Progress calculation
    PROGRESS_PERCENTAGE_BASE = 100


@dataclass
class Comment:
    """Represents a GitHub PR comment"""

    comment_id: str  # GraphQL node ID (e.g., PRRC_kwDOOQ6Yxs6Ooaqh)
    body: str
    author: str
    created_at: str
    updated_at: str
    database_id: Optional[int] = None  # Integer database ID (e.g., 2392959649)
    file_path: Optional[str] = None  # Primary field for file path
    position: Optional[int] = None
    url: str = ""
    is_resolved: bool = False
    resolution_type: Optional[str] = None
    priority: str = "unknown"
    category: str = "other"
    type: Optional[str] = None  # For compatibility with existing data
    line_range: Optional[str] = None  # For compatibility with existing data
    has_code_changes: bool = False  # For compatibility with existing data
    auto_skip_reason: Optional[str] = None  # Auto-skip detection reason
    thread_id: Optional[str] = None  # Thread ID for review comments


@dataclass
class ResolutionState:
    """Represents the resolution state of comments"""

    resolved_comments: List[str]
    skipped_comments: List[str]
    resolution_history: List[Dict[str, Any]]


class GitHubAPI:
    """Handles GitHub API interactions"""

    def __init__(self, pr_number: Optional[str] = None):
        self.owner = ""
        self.repo = ""
        self.pr_number = pr_number
        self._thread_mapping = None  # Cache for comment_id -> thread_id mapping
        self._detect_repository()

    def _detect_repository(self):
        """Detect repository from git remote with CI fallbacks"""
        try:
            result = subprocess.run(
                ["git", "remote", "get-url", "origin"],
                capture_output=True,
                text=True,
                check=True,
                timeout=Constants.TIMEOUT,
            )
            url = result.stdout.strip()
            if "github.com" in url:
                # Extract owner/repo from URL
                if url.startswith("git@"):
                    # SSH format: git@github.com:owner/repo.git
                    parts = url.replace(".git", "").split(":")
                    if len(parts) >= 2:
                        repo_part = parts[1]
                        owner_repo = repo_part.split("/")
                        if len(owner_repo) >= 2:
                            self.owner = owner_repo[0]
                            self.repo = owner_repo[1]
                        else:
                            raise ValueError("Invalid SSH URL format")
                    else:
                        raise ValueError("Invalid SSH URL format")
                else:
                    # HTTPS format: https://github.com/owner/repo.git
                    parts = url.replace(".git", "").split("/")
                    self.owner = parts[-2]
                    self.repo = parts[-1]
                logger.info(f"🔍 Detected repository: {self.owner}/{self.repo}")
            else:
                raise ValueError("Not a GitHub repository")
        except (
            subprocess.CalledProcessError,
            ValueError,
            FileNotFoundError,
            subprocess.TimeoutExpired,
            OSError,
        ) as e:
            logger.error(f"❌ Error detecting repository: {e}")
            # Fallback for CI: GITHUB_REPOSITORY="owner/repo"
            repo_env = os.getenv("GITHUB_REPOSITORY")
            if repo_env and "/" in repo_env:
                self.owner, self.repo = repo_env.split("/", 1)
                logger.info(
                    f"🔍 Detected repository from GITHUB_REPOSITORY: {self.owner}/{self.repo}"
                )
                return
            # Try gh CLI as fallback
            try:
                result = subprocess.run(
                    ["gh", "repo", "view", "--json", "owner,name"],
                    capture_output=True,
                    text=True,
                    check=True,
                    timeout=Constants.TIMEOUT,
                )
                repo_data = json.loads(result.stdout)
                self.owner = repo_data["owner"]["login"]
                self.repo = repo_data["name"]
                logger.info(
                    f"🔍 Detected repository from gh CLI: {self.owner}/{self.repo}"
                )
                return
            except (
                subprocess.CalledProcessError,
                ValueError,
                FileNotFoundError,
                subprocess.TimeoutExpired,
                OSError,
                json.JSONDecodeError,
            ) as gh_error:
                logger.error(f"❌ gh CLI fallback also failed: {gh_error}")
            sys.exit(1)

    def fetch_comments(
        self, pr_number: int
    ) -> Tuple[List[Comment], List[Comment], List[Comment]]:
        """Fetch comments from GitHub API"""
        import concurrent.futures

        if RICH_AVAILABLE:
            console = Console()
            console.print("[bold blue]Fetching comments...[/bold blue]")
        else:
            logger.info(f"Fetching comments for PR #{pr_number}...")

        # Fetch all three types in parallel for better performance
        with concurrent.futures.ThreadPoolExecutor(
            max_workers=Constants.MAX_WORKERS
        ) as executor:
            review_future = executor.submit(self._fetch_review_threads, pr_number)
            pr_future = executor.submit(self._fetch_pr_comments, pr_number)
            review_comments_future = executor.submit(
                self._fetch_review_comments, pr_number
            )

            # Wait for all to complete
            review_threads = review_future.result()
            pr_comments = pr_future.result()
            review_comments = review_comments_future.result()

        if RICH_AVAILABLE:
            console.print("[green]✅ Comments fetched[/green]")
        else:
            logger.info("✅ Comments fetched")

        return review_threads, pr_comments, review_comments

    def _fetch_review_threads(self, pr_number: int) -> List[Comment]:
        """Fetch review threads using GitHub CLI with batch processing for large PRs"""
        # First, check if this is a large PR
        count_query = """
        query($owner:String!, $name:String!, $number:Int!) {
          repository(owner:$owner, name:$name) {
            pullRequest(number:$number) {
              reviewThreads(first:1) { totalCount }
            }
          }
        }
        """

        try:
            result = subprocess.run(
                [
                    "gh",
                    "api",
                    "graphql",
                    "-F",
                    f"query={count_query}",
                    "-F",
                    f"owner={self.owner}",
                    "-F",
                    f"name={self.repo}",
                    "-F",
                    f"number={int(pr_number)}",
                ],
                capture_output=True,
                text=True,
                check=True,
                timeout=Constants.TIMEOUT,
            )

            data = json.loads(result.stdout)
            total_count = data["data"]["repository"]["pullRequest"]["reviewThreads"][
                "totalCount"
            ]

            if total_count > Constants.LARGE_PR_THRESHOLD:
                logger.warning(
                    f"⚠️ Large PR detected: {total_count} review threads. Using batch processing..."
                )
                return self._fetch_review_threads_batched(pr_number, total_count)
            else:
                return self._fetch_review_threads_single(pr_number)

        except Exception as e:
            logger.warning(f"⚠️ Could not check PR size, using single fetch: {e}")
            return self._fetch_review_threads_single(pr_number)

    def _fetch_review_threads_single(self, pr_number: int) -> List[Comment]:
        """Fetch review threads in a single query (for smaller PRs)"""
        query = """
        query($owner:String!, $name:String!, $number:Int!, $cursor:String) {
          repository(owner:$owner, name:$name) {
            pullRequest(number:$number) {
              reviewThreads(first:%d, after:$cursor) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  id
                  isResolved
                  comments(first:%d) {
                    nodes {
                      id
                      databaseId
                      body path position url createdAt updatedAt
                      author { login }
                    }
                  }
                }
              }
            }
          }
        }
        """ % (Constants.GRAPHQL_LIMIT, Constants.GRAPHQL_LIMIT)

        try:
            result = subprocess.run(
                [
                    "gh",
                    "api",
                    "graphql",
                    "--paginate",
                    "-F",
                    f"query={query}",
                    "-F",
                    f"owner={self.owner}",
                    "-F",
                    f"name={self.repo}",
                    "-F",
                    f"number={int(pr_number)}",
                ],
                capture_output=True,
                text=True,
                check=True,
                timeout=Constants.TIMEOUT,
            )

            data = json.loads(result.stdout)
            return self._parse_review_threads(data)
        except (
            subprocess.CalledProcessError,
            json.JSONDecodeError,
            subprocess.TimeoutExpired,
        ) as e:
            logger.error(f"❌ Error fetching review threads: {e}")
            return []

    def _fetch_review_threads_batched(
        self, pr_number: int, total_count: int
    ) -> List[Comment]:
        """Fetch review threads in batches for large PRs"""
        all_comments: List[Comment] = []
        fetched_threads = 0
        batch_size = Constants.BATCH_SIZE
        cursor = None

        logger.info(
            f"📦 Fetching {total_count} review threads in batches of {batch_size}..."
        )

        while fetched_threads < total_count:
            query = """
            query($owner:String!, $name:String!, $number:Int!, $cursor:String) {
              repository(owner:$owner, name:$name) {
                pullRequest(number:$number) {
                  reviewThreads(first:%d, after:$cursor) {
                    pageInfo { hasNextPage endCursor }
                    nodes {
                      id
                      isResolved
                      comments(first:%d) {
                        nodes {
                          id
                          databaseId
                          body path position url createdAt updatedAt
                          author { login }
                        }
                      }
                    }
                  }
                }
              }
            }
            """ % (batch_size, Constants.GRAPHQL_LIMIT)

            try:
                cmd = [
                    "gh",
                    "api",
                    "graphql",
                    "-F",
                    f"query={query}",
                    "-F",
                    f"owner={self.owner}",
                    "-F",
                    f"name={self.repo}",
                    "-F",
                    f"number={int(pr_number)}",
                ]
                if cursor:
                    cmd.extend(["-F", f"cursor={cursor}"])

                result = subprocess.run(
                    cmd,
                    capture_output=True,
                    text=True,
                    check=True,
                    timeout=Constants.TIMEOUT,
                )

                data = json.loads(result.stdout)
                threads = data["data"]["repository"]["pullRequest"]["reviewThreads"][
                    "nodes"
                ]
                fetched_threads += len(threads)
                page_info = data["data"]["repository"]["pullRequest"]["reviewThreads"][
                    "pageInfo"
                ]

                # Parse this batch
                batch_comments = self._parse_review_threads(
                    {
                        "data": {
                            "repository": {
                                "pullRequest": {"reviewThreads": {"nodes": threads}}
                            }
                        }
                    }
                )
                all_comments.extend(batch_comments)

                logger.info(
                    f"📦 Fetched {len(batch_comments)} comments from batch ({len(all_comments)}/{total_count} total)"
                )

                if not page_info["hasNextPage"]:
                    break

                cursor = page_info["endCursor"]

            except Exception as e:
                logger.error(f"❌ Error in batch processing: {e}")
                break

        logger.info(
            f"✅ Batch processing complete: {len(all_comments)} comments fetched"
        )
        return all_comments

    def _fetch_pr_comments(self, pr_number: int) -> List[Comment]:
        """Fetch PR comments using GitHub CLI"""
        query = (
            """
        query($owner:String!, $name:String!, $number:Int!, $cursor:String) {
          repository(owner:$owner, name:$name) {
            pullRequest(number:$number) {
              comments(first:%d, after:$cursor) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  id
                  databaseId
                  body url createdAt updatedAt
                  author { login }
                }
              }
            }
          }
        }
        """
            % Constants.GRAPHQL_LIMIT
        )

        try:
            result = subprocess.run(
                [
                    "gh",
                    "api",
                    "graphql",
                    "--paginate",
                    "-F",
                    f"query={query}",
                    "-F",
                    f"owner={self.owner}",
                    "-F",
                    f"name={self.repo}",
                    "-F",
                    f"number={int(pr_number)}",
                ],
                capture_output=True,
                text=True,
                check=True,
                timeout=Constants.TIMEOUT,
            )

            data = json.loads(result.stdout)
            return self._parse_pr_comments(data)
        except (
            subprocess.CalledProcessError,
            json.JSONDecodeError,
            subprocess.TimeoutExpired,
        ) as e:
            logger.error(f"❌ Error fetching PR comments: {e}")
            return []

    def _fetch_review_comments(self, pr_number: int) -> List[Comment]:
        """Fetch review comments (outside diff range) using GitHub CLI"""
        query = """
        query($owner:String!, $name:String!, $number:Int!, $cursor:String) {
          repository(owner:$owner, name:$name) {
            pullRequest(number:$number) {
              reviews(first:%d, after:$cursor) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  id
                  body
                  url
                  createdAt
                  updatedAt
                  author { login }
                  comments(first:%d) {
                    nodes {
                      id
                      databaseId
                      body
                      url
                      createdAt
                      updatedAt
                      author { login }
                    }
                  }
                }
              }
            }
          }
        }
        """ % (Constants.GRAPHQL_LIMIT, Constants.GRAPHQL_LIMIT)

        try:
            result = subprocess.run(
                [
                    "gh",
                    "api",
                    "graphql",
                    "--paginate",
                    "-F",
                    f"query={query}",
                    "-F",
                    f"owner={self.owner}",
                    "-F",
                    f"name={self.repo}",
                    "-F",
                    f"number={int(pr_number)}",
                ],
                capture_output=True,
                text=True,
                check=True,
                timeout=Constants.TIMEOUT,
            )

            data = json.loads(result.stdout)
            return self._parse_review_comments(data)
        except (
            subprocess.CalledProcessError,
            json.JSONDecodeError,
            subprocess.TimeoutExpired,
        ) as e:
            logger.error(f"❌ Error fetching review comments: {e}")
            return []

    def _parse_review_threads(self, data: Dict[str, Any]) -> List[Comment]:
        """Parse review threads data"""
        comments = []
        try:
            threads = data["data"]["repository"]["pullRequest"]["reviewThreads"][
                "nodes"
            ]
            for thread in threads:
                thread_id = thread["id"]  # Store the actual thread ID
                thread_resolved = bool(thread.get("isResolved", False))
                for comment_data in thread["comments"]["nodes"]:
                    comment = Comment(
                        comment_id=comment_data["id"],
                        database_id=comment_data.get("databaseId"),
                        body=comment_data["body"],
                        author=comment_data["author"]["login"],
                        created_at=comment_data["createdAt"],
                        updated_at=comment_data["updatedAt"],
                        file_path=comment_data.get("path"),
                        position=comment_data.get("position"),
                        url=comment_data["url"],
                        is_resolved=thread_resolved,
                        resolution_type=("resolved" if thread_resolved else None),
                        thread_id=thread_id,  # Store the thread ID for resolution
                    )
                    comments.append(comment)
        except (KeyError, TypeError) as e:
            logger.error(f"❌ Error parsing review threads: {e}")
        return comments

    def _parse_pr_comments(self, data: Dict[str, Any]) -> List[Comment]:
        """Parse PR comments data"""
        comments = []
        try:
            comments_data = data["data"]["repository"]["pullRequest"]["comments"][
                "nodes"
            ]
            for comment_data in comments_data:
                comment = Comment(
                    comment_id=comment_data["id"],
                    database_id=comment_data.get("databaseId"),
                    body=comment_data["body"],
                    author=comment_data["author"]["login"],
                    created_at=comment_data["createdAt"],
                    updated_at=comment_data["updatedAt"],
                    url=comment_data["url"],
                )
                comments.append(comment)
        except (KeyError, TypeError) as e:
            logger.error(f"❌ Error parsing PR comments: {e}")
        return comments

    def _parse_review_comments(self, data: Dict[str, Any]) -> List[Comment]:
        """Parse review comments data (outside diff range)"""
        comments = []
        try:
            reviews_data = data["data"]["repository"]["pullRequest"]["reviews"]["nodes"]
            for review in reviews_data:
                # Add the review body as a comment if it exists
                if review.get("body") and review["body"].strip():
                    comment = Comment(
                        comment_id=review["id"],
                        database_id=review.get("databaseId"),
                        body=review["body"],
                        author=review["author"]["login"],
                        created_at=review["createdAt"],
                        updated_at=review["updatedAt"],
                        url=review["url"],
                    )
                    comments.append(comment)

                # Add individual review comments
                for comment_data in review["comments"]["nodes"]:
                    comment = Comment(
                        comment_id=comment_data["id"],
                        database_id=comment_data.get("databaseId"),
                        body=comment_data["body"],
                        author=comment_data["author"]["login"],
                        created_at=comment_data["createdAt"],
                        updated_at=comment_data["updatedAt"],
                        url=comment_data["url"],
                    )
                    comments.append(comment)
        except (KeyError, TypeError) as e:
            logger.error(f"❌ Error parsing review comments: {e}")
        return comments

    def _comment_id_to_thread_id(self, comment_id: str) -> Optional[str]:
        """Get thread ID for a comment by looking it up in stored comment data"""
        try:
            # Load the cached comments to get the thread ID
            comments_file = Path(f".local/pr-{self.pr_number}-comments.json")
            if comments_file.exists():
                with open(comments_file, "r", encoding="utf-8") as f:
                    data = json.load(f)

                for comment in data.get("comments", []):
                    if comment.get("comment_id") == comment_id:
                        return comment.get("thread_id")
        except Exception as e:
            logger.warning(f"⚠️ Could not get thread ID for comment {comment_id}: {e}")
        return None

    def _get_review_thread_node_id(self, comment_id: str) -> Optional[str]:
        """Get the GraphQL node ID for a review thread from a comment ID"""
        return self._comment_id_to_thread_id(comment_id)

    def resolve_review_threads_batch(self, comment_ids: List[str]) -> List[str]:
        """Resolve multiple review threads in a single batch operation"""
        try:
            # Get unique thread IDs for all comments using simple conversion
            thread_ids = set()
            resolved_comments = []

            for comment_id in comment_ids:
                thread_id = self._comment_id_to_thread_id(comment_id)
                if thread_id:
                    thread_ids.add(thread_id)
                    resolved_comments.append(comment_id)
                else:
                    logger.warning(
                        f"⚠️ Could not convert comment ID to thread ID: {comment_id}"
                    )

            if not thread_ids:
                return []

            # Create mapping from comment_id to thread_id for efficient lookup
            comment_to_thread_mapping = {}
            for comment_id in resolved_comments:
                thread_id = self._comment_id_to_thread_id(comment_id)
                if thread_id:
                    comment_to_thread_mapping[comment_id] = thread_id

            # Resolve all threads in a single GraphQL mutation
            # Note: GraphQL doesn't support batch mutations, so we'll do them sequentially
            # but we've already optimized the thread lookup
            successful_resolutions = []

            for thread_id in thread_ids:
                query = f"""
                mutation {{
                    resolveReviewThread(input: {{threadId: "{thread_id}"}}) {{
                        thread {{
                            id
                            isResolved
                        }}
                    }}
                }}
                """

                result = subprocess.run(
                    ["gh", "api", "graphql", "-f", f"query={query}"],
                    capture_output=True,
                    text=True,
                    check=True,
                )

                if result.returncode == 0:
                    response = json.loads(result.stdout)
                    if (
                        response.get("data", {})
                        .get("resolveReviewThread", {})
                        .get("thread", {})
                        .get("isResolved")
                    ):
                        # Find which comments belong to this thread
                        for comment_id in resolved_comments:
                            if (
                                comment_to_thread_mapping.get(str(comment_id))
                                == thread_id
                            ):
                                successful_resolutions.append(comment_id)

            return successful_resolutions

        except (subprocess.CalledProcessError, json.JSONDecodeError, Exception) as e:
            logger.error(f"❌ Error resolving review threads batch: {e}")
            return []

    def resolve_review_thread(self, comment_id: str) -> bool:
        """Resolve a single review thread (for backward compatibility)"""
        resolved = self.resolve_review_threads_batch([comment_id])
        return len(resolved) > 0


class CommentProcessor:
    """Processes and analyzes comments"""

    def __init__(self):
        # Pre-compile regex patterns for better performance
        self._file_patterns = [
            re.compile(r"In ([^\s]+) around lines?"),
            re.compile(r"In ([^\s]+) at lines?"),
            re.compile(r"([^\s]+\.(ts|js|json|md|txt|yml|yaml)) around lines?"),
            # Pattern for review comments: <summary>filename.ext (count)</summary>
            re.compile(
                r"<summary>([^\s<>()]+\.(ts|js|json|md|txt|yml|yaml|py|sh)) \(\d+\)</summary>"
            ),
            # Pattern for review comments: <summary>filename.ext</summary>
            re.compile(
                r"<summary>([^\s<>()]+\.(ts|js|json|md|txt|yml|yaml|py|sh))</summary>"
            ),
            # Pattern for review comments: <summary>filename (count)</summary> - for files without extensions
            re.compile(r"<summary>([^\s<>()]+) \(\d+\)</summary>"),
            # Pattern for review comments: <summary>filename</summary> - for files without extensions
            re.compile(r"<summary>([^\s<>()]+)</summary>"),
        ]

        # Pre-compile priority and category patterns
        self._priority_patterns = {
            "major": re.compile(r"(Major|P1|⚠️|CAUTION)", re.IGNORECASE),
            "minor": re.compile(r"Minor", re.IGNORECASE),
            "trivial": re.compile(r"Trivial", re.IGNORECASE),
        }

        self._category_patterns = {
            "summary": re.compile(r"## Walkthrough"),
            "command": re.compile(
                r"^@(coderabbit|CodeRabbit|codex)", re.IGNORECASE | re.MULTILINE
            ),
            "nitpick": re.compile(r"Nitpick"),
            "issue": re.compile(r"Potential issue|⚠️|CAUTION"),
            "refactor": re.compile(r"Refactor|♻️|Duplicate comments"),
            "outside_diff": re.compile(r"Outside diff range|outside the diff"),
        }

    def process_comments(self, comments: List[Comment]) -> List[Comment]:
        """Process comments and extract metadata with parallel processing"""
        if not comments:
            return comments

        # Use parallel processing for large comment sets
        if len(comments) > Constants.PARALLEL_PROCESSING_THRESHOLD:
            with ThreadPoolExecutor(max_workers=Constants.MAX_WORKERS) as executor:
                # Submit all comment processing tasks
                futures = []
                for comment in comments:
                    future = executor.submit(self._process_single_comment, comment)
                    futures.append(future)

                # Wait for all to complete
                processed_comments = [future.result() for future in futures]
        else:
            # For small comment sets, process sequentially
            processed_comments = [
                self._process_single_comment(comment) for comment in comments
            ]

        return processed_comments

    def _process_single_comment(self, comment: Comment) -> Comment:
        """Process a single comment and extract metadata"""
        comment.priority = self._extract_priority(comment.body)
        comment.category = self._extract_category(comment.body)
        if not comment.file_path:
            comment.file_path = self._extract_file_path(comment.body)

        # Simple auto-skip detection
        comment.auto_skip_reason = self._should_auto_skip(comment.body)

        return comment

    def _extract_priority(self, body: str) -> str:
        """Extract priority from comment body using pre-compiled patterns"""
        for priority, pattern in self._priority_patterns.items():
            if pattern.search(body):
                return priority
        return "unknown"

    def _extract_category(self, body: str) -> str:
        """Extract category from comment body using pre-compiled patterns"""
        # Check patterns in order of specificity
        for category, pattern in self._category_patterns.items():
            if pattern.search(body):
                return category
        return "other"

    def _extract_file_path(self, body: str) -> Optional[str]:
        """Extract file path from comment body"""
        for pattern in self._file_patterns:
            match = pattern.search(body)
            if match:
                return match.group(1)
        return None

    def _should_auto_skip(self, body: str) -> Optional[str]:
        """Simple auto-skip detection - returns reason if should skip, None otherwise"""
        body_lower = body.lower()

        # Skip informational content
        if "codex" in body_lower and "automated review" in body_lower:
            return "informational_codex"

        # Skip review summaries with no actionable content
        if (
            "learnings" in body_lower
            and "configuration" in body_lower
            and not any(
                word in body_lower
                for word in [
                    "should",
                    "must",
                    "fix",
                    "update",
                    "change",
                    "add",
                    "remove",
                ]
            )
        ):
            return "review_summary"

        # Skip pure metadata
        if (
            "review details" in body_lower
            and "files selected" in body_lower
            and "```" not in body
        ):
            return "metadata_only"

        return None

    def assess_comment_for_action(self, comment: Comment) -> str:
        """Provide guidance on whether a comment should be addressed"""
        # High priority issues should always be addressed
        if comment.priority == "major" and comment.category in ["issue", "refactor"]:
            return "🔴 Should address: High priority issue"

        # Minor issues are usually worth addressing
        if comment.priority == "minor" and comment.category == "issue":
            return "🟡 Should address: Minor issue"

        # Trivial nitpicks on configuration files are often simple fixes
        if (
            comment.priority == "trivial"
            and comment.category == "nitpick"
            and comment.file_path
            and any(
                ext in comment.file_path
                for ext in [".yaml", ".yml", ".json", ".gitignore", ".prettierignore"]
            )
        ):
            return "🟢 Review: Simple config file fix - likely worth addressing"

        # Trivial nitpicks on code files need evaluation
        if comment.priority == "trivial" and comment.category == "nitpick":
            return "🔵 Review: Trivial nitpick - evaluate based on content"

        # Other categories need manual review
        return "⚪ Review: Evaluate based on content and context"


class ResolutionManager:
    """Manages comment resolution state"""

    def __init__(self, pr_number: int):
        self.pr_number = pr_number
        self.resolution_file = Path(f".local/pr-{pr_number}-resolutions.json")
        self.comments_file = Path(f".local/pr-{pr_number}-comments.json")
        self._ensure_local_dir()

    def _ensure_local_dir(self):
        """Ensure .local directory exists"""
        Path(".local").mkdir(exist_ok=True)

    def load_resolution_state(self) -> ResolutionState:
        """Load resolution state from file"""
        if not self.resolution_file.exists():
            return ResolutionState([], [], [])

        try:
            with open(self.resolution_file, "r", encoding="utf-8") as f:
                data = json.load(f)
            return ResolutionState(
                resolved_comments=data.get("resolved_comments", []),
                skipped_comments=data.get("skipped_comments", []),
                resolution_history=data.get("resolution_history", []),
            )
        except (json.JSONDecodeError, KeyError) as e:
            logger.error(f"❌ Error loading resolution state: {e}")
            return ResolutionState([], [], [])

    def save_resolution_state(self, state: ResolutionState):
        """Save resolution state to file"""
        data = {
            "resolved_comments": state.resolved_comments,
            "skipped_comments": state.skipped_comments,
            "resolution_history": state.resolution_history,
        }

        with open(self.resolution_file, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)

    def mark_resolved(self, comment_ids: List[str], github_api=None):
        """Mark comments as resolved both locally and on GitHub"""
        state = self.load_resolution_state()

        # Track newly resolved comments
        newly_resolved = []
        github_resolved = []

        for comment_id in comment_ids:
            if comment_id not in state.resolved_comments:
                newly_resolved.append(comment_id)
                state.resolved_comments.append(comment_id)
            if comment_id in state.skipped_comments:
                state.skipped_comments.remove(comment_id)

            # Add to history
            state.resolution_history.append(
                {
                    "comment_id": comment_id,
                    "resolution_type": "resolved",
                    "resolved_at": datetime.now(timezone.utc).isoformat(),
                    "resolved_by": "ai",
                }
            )

        self.save_resolution_state(state)

        # Store change info for status display
        self._session_changes = getattr(self, "_session_changes", {})
        self._session_changes["newly_resolved"] = self._session_changes.get(
            "newly_resolved", 0
        ) + len(newly_resolved)

        # Try to resolve on GitHub if API is available
        if github_api:
            # Separate comments by type for efficient processing
            review_comments = []
            other_comments = []

            for comment_id in comment_ids:
                try:
                    comment_type = self._get_comment_type(comment_id)
                    if comment_type == "review_comment":
                        review_comments.append(comment_id)
                    else:
                        other_comments.append(comment_id)
                        if comment_type == "issue_comment":
                            logger.info(
                                f"📝 Issue comment {comment_id} marked locally (GitHub resolution not applicable)"
                            )
                        elif comment_type == "review_body":
                            logger.info(
                                f"📝 Review body {comment_id} marked locally (GitHub resolution not applicable)"
                            )
                except Exception as e:
                    logger.warning(
                        f"⚠️ Could not determine comment type for {comment_id}: {e}"
                    )
                    other_comments.append(comment_id)

            # Batch resolve all review comments at once
            if review_comments:
                try:
                    resolved_review_comments = github_api.resolve_review_threads_batch(
                        review_comments
                    )
                    github_resolved.extend(resolved_review_comments)

                    for comment_id in resolved_review_comments:
                        comment_url = self._get_comment_url(comment_id)
                        if comment_url:
                            logger.info(
                                f"🌐 Review comment {comment_id} resolved on GitHub: {comment_url}"
                            )
                        else:
                            logger.info(
                                f"🌐 Review comment {comment_id} resolved on GitHub"
                            )

                    # Log any that failed
                    failed_comments = set(review_comments) - set(
                        resolved_review_comments
                    )
                    for comment_id in failed_comments:
                        logger.info(
                            f"📝 Review comment {comment_id} marked locally (GitHub resolution failed)"
                        )

                except Exception as e:
                    logger.warning(
                        f"⚠️ Could not resolve review comments on GitHub: {e}"
                    )
                    for comment_id in review_comments:
                        logger.info(
                            f"📝 Review comment {comment_id} marked locally (GitHub resolution failed)"
                        )

        if RICH_AVAILABLE:
            console = Console()
            console.print(
                f"[green]✅ {len(comment_ids)} comments marked as resolved (fixed)[/green]"
            )
            if github_resolved:
                console.print(
                    f"[green]🌐 {len(github_resolved)} also resolved on GitHub[/green]"
                )
        else:
            logger.info(f"✅ {len(comment_ids)} comments marked as resolved (fixed)")
            if github_resolved:
                logger.info(f"🌐 {len(github_resolved)} also resolved on GitHub")

    def _get_comment_type(self, comment_id: str) -> str:
        """Determine the type of comment based on its ID and stored data"""
        try:
            # Load the cached comments to check the comment type
            comments_file = Path(f".local/pr-{self.pr_number}-comments.json")
            if comments_file.exists():
                with open(comments_file, "r", encoding="utf-8") as f:
                    data = json.load(f)

                for comment in data.get("comments", []):
                    if comment.get("comment_id") == comment_id:
                        url = comment.get("url", "")
                        position = comment.get("position")

                        # Determine type based on URL and attributes
                        if "discussion_r" in url:
                            if position is not None:
                                return "review_comment"  # Line-specific comment
                            else:
                                return "review_body"  # Review body comment
                        else:
                            return "issue_comment"  # Top-level PR comment
        except Exception as e:
            logger.warning(f"⚠️ Could not determine comment type for {comment_id}: {e}")

        # Default fallback - assume it's a review comment if we can't determine
        return "review_comment"

    def _get_comment_url(self, comment_id: str) -> str:
        """Get the URL for a comment from cached data"""
        try:
            # Load the cached comments to get the URL
            comments_file = Path(f".local/pr-{self.pr_number}-comments.json")
            if comments_file.exists():
                with open(comments_file, "r", encoding="utf-8") as f:
                    data = json.load(f)

                for comment in data.get("comments", []):
                    if comment.get("comment_id") == comment_id:
                        return comment.get("url", "")
        except Exception as e:
            logger.warning(f"⚠️ Could not get URL for comment {comment_id}: {e}")
        return ""

    def mark_skipped(self, comment_ids: List[str]):
        """Mark comments as skipped"""
        state = self.load_resolution_state()

        # Add to skipped, remove from resolved
        for comment_id in comment_ids:
            if comment_id not in state.skipped_comments:
                state.skipped_comments.append(comment_id)
            if comment_id in state.resolved_comments:
                state.resolved_comments.remove(comment_id)

            # Add to history
            state.resolution_history.append(
                {
                    "comment_id": comment_id,
                    "resolution_type": "skipped",
                    "resolved_at": datetime.now(timezone.utc).isoformat(),
                    "resolved_by": "ai",
                }
            )

        self.save_resolution_state(state)
        if RICH_AVAILABLE:
            console = Console()
            console.print(
                f"[yellow]⏭️ {len(comment_ids)} comments marked as skipped (ignored)[/yellow]"
            )
        else:
            logger.info(f"⏭️ {len(comment_ids)} comments marked as skipped (ignored)")

    def load_comments(self) -> List[Comment]:
        """Load comments from file with optimized field mapping"""
        if not self.comments_file.exists():
            return []

        try:
            with open(self.comments_file, "r", encoding="utf-8") as f:
                data = json.load(f)

            comments = []
            comments_data = data.get("comments", [])

            # Pre-define field mapping for better performance
            field_mapping = {
                "comment_id": "comment_id",
                "body": "body",
                "author": "author",
                "created_at": "createdAt",
                "updated_at": "updatedAt",
                "file_path": "file_path",
                "position": "position",
                "url": "url",
                "is_resolved": "is_resolved",
                "resolution_type": "resolution_type",
                "priority": "priority",
                "category": "category",
                "type": "type",
                "line_range": "line_range",
                "has_code_changes": "has_code_changes",
                "auto_skip_reason": "auto_skip_reason",
                "thread_id": "thread_id",
            }

            # Default values to avoid repeated dict lookups
            defaults = {
                "url": "",
                "is_resolved": False,
                "priority": "unknown",
                "category": "other",
                "has_code_changes": False,
            }

            for comment_data in comments_data:
                # Build mapped comment with defaults
                mapped_comment = {}
                for field, key in field_mapping.items():
                    mapped_comment[field] = comment_data.get(key, defaults.get(field))

                # Handle legacy 'path' field by mapping it to 'file_path' if file_path is not set
                # This ensures backward compatibility with existing data files
                if not mapped_comment.get("file_path") and comment_data.get("path"):
                    mapped_comment["file_path"] = comment_data["path"]

                comments.append(Comment(**mapped_comment))
            return comments
        except (json.JSONDecodeError, KeyError, TypeError, OSError) as e:
            logger.error(f"❌ Error loading comments: {e}")
            return []

    def update_comments_resolution_state(self, comments: List[Comment]):
        """Update comments with resolution state"""
        state = self.load_resolution_state()

        for comment in comments:
            if comment.comment_id in state.resolved_comments:
                comment.is_resolved = True
                comment.resolution_type = "resolved"
            elif comment.comment_id in state.skipped_comments:
                comment.is_resolved = True
                comment.resolution_type = "skipped"
            else:
                comment.is_resolved = False
                comment.resolution_type = None


class StatusDisplay:
    """Handles status display functionality"""

    def __init__(self, resolution_manager: ResolutionManager):
        self.resolution_manager = resolution_manager
        self.console = Console() if RICH_AVAILABLE else None

    def _create_unified_table(
        self, comments, title="📝 Comments", show_summary=True, show_assessment=False
    ):
        """Create a unified table for displaying comments with optional filtering"""
        if not comments:
            if self.console:
                self.console.print("[yellow]⚠️  No comments found[/yellow]")
            else:
                print("⚠️  No comments found")
            return

        # Calculate statistics
        resolved_comments = [
            c for c in comments if c.is_resolved and c.resolution_type == "resolved"
        ]
        skipped_comments = [
            c for c in comments if c.is_resolved and c.resolution_type == "skipped"
        ]
        unresolved_comments = [c for c in comments if not c.is_resolved]

        total_comments = len(comments)
        resolved_count = len(resolved_comments)
        skipped_count = len(skipped_comments)
        unresolved_count = len(unresolved_comments)
        progress = (
            int(
                (resolved_count + skipped_count)
                / total_comments
                * Constants.PROGRESS_PERCENTAGE_BASE
            )
            if total_comments > 0
            else 0
        )

        if self.console and show_summary:
            # Create summary panel
            summary_text = "[bold blue]📊 Comment Status[/bold blue]\n\n"
            summary_text += f"[green]✅ Resolved:[/green] {resolved_count}\n"
            summary_text += f"[yellow]⏭️  Skipped:[/yellow] {skipped_count}\n"
            summary_text += f"[red]❌ Unresolved:[/red] {unresolved_count}\n"
            summary_text += f"[bold]Total:[/bold] {total_comments}\n"
            summary_text += f"[bold]Progress:[/bold] {progress}%"

            # Check for auto-skip suggestions
            auto_skip_comments = [
                c
                for c in comments
                if hasattr(c, "auto_skip_reason")
                and c.auto_skip_reason
                and not c.is_resolved
            ]
            if auto_skip_comments:
                auto_skip_text = (
                    "[bold yellow]🤖 Auto-skip suggestions:[/bold yellow]\n\n"
                )
                for comment in auto_skip_comments:
                    auto_skip_text += (
                        f"• {comment.comment_id}: {comment.auto_skip_reason}\n"
                    )
                auto_skip_panel = Panel(
                    auto_skip_text.strip(),
                    title="Auto-skip Suggestions",
                    border_style="yellow",
                )
                self.console.print(auto_skip_panel)
                self.console.print()

            summary_panel = Panel(
                summary_text, title="Comment Status", border_style="blue"
            )
            self.console.print(summary_panel)
            self.console.print()
        elif show_summary:
            # Plain text summary
            print("📊 Comment Status")
            print(f"✅ Resolved: {resolved_count}")
            print(f"⏭️  Skipped: {skipped_count}")
            print(f"❌ Unresolved: {unresolved_count}")
            print(f"Total: {total_comments}")
            print(f"Progress: {progress}%")
            print()

            # Check for auto-skip suggestions (plain text)
            auto_skip_comments = [
                c
                for c in comments
                if hasattr(c, "auto_skip_reason")
                and c.auto_skip_reason
                and not c.is_resolved
            ]
            if auto_skip_comments:
                print("🤖 Auto-skip suggestions:")
                for comment in auto_skip_comments:
                    print(f"• {comment.comment_id}: {comment.auto_skip_reason}")
                print()

        # Combine all comments with status
        all_comments = []

        # Add resolved comments
        for comment in resolved_comments:
            all_comments.append((comment, "✅ Resolved"))

        # Add skipped comments
        for comment in skipped_comments:
            all_comments.append((comment, "⏭️ Skipped"))

        # Add unresolved comments
        for comment in unresolved_comments:
            all_comments.append((comment, "❌ Unresolved"))

        # Sort by status (resolved, skipped, unresolved) then by date
        def sort_key(item):
            comment, status = item
            status_order = {"✅ Resolved": 0, "⏭️ Skipped": 1, "❌ Unresolved": 2}
            return (status_order.get(status, 3), comment.created_at)

        all_comments.sort(key=sort_key)

        # Show all comments in a single table
        if all_comments:
            if self.console:
                table = Table(title=title, show_header=True, header_style="blue")
                table.add_column("ID", style="dim")
                table.add_column(
                    "Status",
                    style="bold",
                    width=Constants.TABLE_COLUMN_WIDTHS["status"],
                )
                table.add_column(
                    "Priority",
                    style="bold",
                    width=Constants.TABLE_COLUMN_WIDTHS["priority"],
                )
                table.add_column(
                    "Category",
                    style="cyan",
                    width=Constants.TABLE_COLUMN_WIDTHS["category"],
                )
                table.add_column("File", style="green")
                table.add_column(
                    "Author",
                    style="blue",
                    width=Constants.TABLE_COLUMN_WIDTHS["author"],
                )
                table.add_column(
                    "Date", style="dim", width=Constants.TABLE_COLUMN_WIDTHS["date"]
                )

                for comment, status in all_comments:
                    priority_color = {
                        "major": "red",
                        "minor": "yellow",
                        "trivial": "blue",
                        "unknown": "dim",
                    }.get(comment.priority, "dim")

                    # Color the status column
                    status_color = {
                        "✅ Resolved": "green",
                        "⏭️ Skipped": "yellow",
                        "❌ Unresolved": "red",
                    }.get(status, "dim")

                    file_path = comment.file_path or "General"
                    date_str = comment.created_at.split("T")[0]  # Just the date part

                    # Add assessment guidance for unresolved comments
                    if status == "❌ Unresolved" and show_assessment:
                        processor = CommentProcessor()
                        assessment = processor.assess_comment_for_action(comment)
                        file_path = f"{file_path}\n[dim]{assessment}[/dim]"

                    table.add_row(
                        comment.comment_id,
                        f"[{status_color}]{status}[/{status_color}]",
                        f"[{priority_color}]{comment.priority.upper()}[/{priority_color}]",
                        comment.category,
                        file_path,
                        comment.author,
                        date_str,
                    )
                self.console.print(table)
                self.console.print()
                self.console.print(
                    "[dim]💡 Use --show <COMMENT_ID> to view full comment content[/dim]"
                )
            else:
                # Plain text fallback
                print(f"\n{title}:")
                for comment, status in all_comments:
                    file_path = comment.file_path or "General"
                    date_str = comment.created_at.split("T")[0]
                    print(
                        f"  {status} {comment.comment_id} - {file_path} - {comment.author} - {date_str}"
                    )
                print()
                print("💡 Use --show <COMMENT_ID> to view full comment content")

    def show_status(self, unresolved_only: bool = False, show_assessment: bool = False):
        """Show resolution status"""
        comments = self.resolution_manager.load_comments()
        if not comments:
            if self.console:
                self.console.print(
                    "[red]❌ Error: No comments found. Run without --status first to fetch comments.[/red]"
                )
            else:
                logger.error(
                    "❌ Error: No comments found. Run without --status first to fetch comments."
                )
            return

        # Update resolution state
        self.resolution_manager.update_comments_resolution_state(comments)

        if unresolved_only:
            # Filter to show only unresolved comments
            unresolved_comments = [c for c in comments if not c.is_resolved]
            if unresolved_comments:
                self._create_unified_table(
                    unresolved_comments,
                    "❌ Unresolved Comments",
                    show_summary=False,
                    show_assessment=show_assessment,
                )
            else:
                if self.console:
                    self.console.print("[green]✅ No unresolved comments![/green]")
                else:
                    print("✅ No unresolved comments!")
        else:
            # Show all comments with summary
            self._create_unified_table(comments, "📝 All Comments", show_summary=True)


def main():
    """Main entry point"""
    parser = argparse.ArgumentParser(
        description="Enhanced GitHub PR Comments Fetcher with AI Resolution Support",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s 123                          # Fetch all comments for PR 123
  %(prog)s 123 --show 2386777571       # Show full content of specific comment
  %(prog)s 123 --resolve 2386777571    # Mark single comment as resolved (fixed)
  %(prog)s 123 --skip 2386777572        # Mark single comment as skipped (ignored)
  %(prog)s 123 --resolve 2386777571,2386777573  # Mark multiple comments as resolved
  %(prog)s 123 --skip 2386777572,2386777574      # Mark multiple comments as skipped
  %(prog)s 123 --status                 # Show resolution status
  %(prog)s 123 --status-unresolved      # Show only unresolved comments
  %(prog)s --cleanup                    # Archive all PR data files to .local/archive/
        """,
    )

    parser.add_argument("pr_number", nargs="?", type=int, help="PR number")
    parser.add_argument(
        "--resolve", help="Mark one or more comments as resolved (fixed)"
    )
    parser.add_argument("--skip", help="Mark one or more comments as skipped (ignored)")
    parser.add_argument("--status", action="store_true", help="Show resolution status")
    parser.add_argument(
        "--status-unresolved", action="store_true", help="Show only unresolved comments"
    )
    parser.add_argument(
        "--assess",
        action="store_true",
        help="Show assessment guidance for unresolved comments",
    )
    parser.add_argument(
        "--show",
        help="Show full content of a specific comment by ID",
    )
    parser.add_argument(
        "--cleanup",
        action="store_true",
        help="Archive all PR data files to .local/archive/",
    )

    args = parser.parse_args()

    # Handle cleanup command
    if args.cleanup:
        logger.info("🧹 Archiving all PR data files...")

        # Find all resolution files
        local_dir = Path(".local")
        if not local_dir.exists():
            if RICH_AVAILABLE:
                console = Console()
                console.print(
                    "[yellow]⚠️  No .local directory found - nothing to clean up[/yellow]"
                )
            else:
                logger.warning("⚠️  No .local directory found - nothing to clean up")
            return

        resolution_files = list(local_dir.glob("pr-*-resolutions.json"))
        comments_files = list(local_dir.glob("pr-*-comments.json"))

        if not resolution_files and not comments_files:
            if RICH_AVAILABLE:
                console = Console()
                console.print("[yellow]⚠️  No PR data files found to clean up[/yellow]")
            else:
                logger.warning("⚠️  No PR data files found to clean up")
            return

        # Create archive directory
        archive_dir = local_dir / "archive"
        archive_dir.mkdir(exist_ok=True)

        # Move files to archive
        archived_count = 0
        for file_path in resolution_files + comments_files:
            archive_path = archive_dir / file_path.name
            if archive_path.exists():
                # Handle collision by adding timestamp
                timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
                archive_path = (
                    archive_dir / f"{file_path.stem}-{timestamp}{file_path.suffix}"
                )
            file_path.rename(archive_path)
            archived_count += 1

        if RICH_AVAILABLE:
            console = Console()
            console.print(
                f"[green]✅ Archived {archived_count} files to .local/archive/[/green]"
            )
        else:
            logger.info(f"✅ Archived {archived_count} files to .local/archive/")
        return

    # Handle show command
    if args.show:
        if not args.pr_number:
            parser.error("PR number is required for --show command")

        resolution_manager = ResolutionManager(args.pr_number)
        comments = resolution_manager.load_comments()

        if not comments:
            if RICH_AVAILABLE:
                console = Console()
                console.print(
                    "[red]❌ Error: No comments found. Run without --show first to fetch comments.[/red]"
                )
            else:
                logger.error(
                    "❌ Error: No comments found. Run without --show first to fetch comments."
                )
            return

        # Find the specific comment
        target_comment = None
        for comment in comments:
            if comment.comment_id == args.show:
                target_comment = comment
                break

        if not target_comment:
            if RICH_AVAILABLE:
                console = Console()
                console.print(
                    f"[red]❌ Error: Comment with ID '{args.show}' not found.[/red]"
                )
            else:
                logger.error(f"❌ Error: Comment with ID '{args.show}' not found.")
            return

        # Display the comment
        if RICH_AVAILABLE:
            console = Console()

            # Create a detailed panel for the comment
            comment_info = (
                f"[bold blue]Comment ID:[/bold blue] {target_comment.comment_id}\n"
            )
            comment_info += f"[bold blue]Author:[/bold blue] {target_comment.author}\n"
            comment_info += (
                f"[bold blue]Created:[/bold blue] {target_comment.created_at}\n"
            )
            comment_info += (
                f"[bold blue]Updated:[/bold blue] {target_comment.updated_at}\n"
            )
            comment_info += f"[bold blue]File:[/bold blue] {target_comment.file_path or 'General'}\n"
            comment_info += (
                f"[bold blue]Priority:[/bold blue] {target_comment.priority}\n"
            )
            comment_info += (
                f"[bold blue]Category:[/bold blue] {target_comment.category}\n"
            )
            comment_info += f"[bold blue]Status:[/bold blue] {'Resolved' if target_comment.is_resolved else 'Unresolved'}\n"
            if target_comment.resolution_type:
                comment_info += f"[bold blue]Resolution:[/bold blue] {target_comment.resolution_type}\n"
            if target_comment.auto_skip_reason:
                comment_info += f"[bold blue]Auto-skip reason:[/bold blue] {target_comment.auto_skip_reason}\n"
            if target_comment.url:
                comment_info += f"[bold blue]URL:[/bold blue] {target_comment.url}\n"

            info_panel = Panel(
                comment_info.strip(), title="Comment Information", border_style="blue"
            )
            console.print(info_panel)
            console.print()

            # Display the comment body
            body_panel = Panel(
                target_comment.body, title="Comment Content", border_style="green"
            )
            console.print(body_panel)
        else:
            # Plain text fallback
            print(f"Comment ID: {target_comment.comment_id}")
            print(f"Author: {target_comment.author}")
            print(f"Created: {target_comment.created_at}")
            print(f"Updated: {target_comment.updated_at}")
            print(f"File: {target_comment.file_path or 'General'}")
            print(f"Priority: {target_comment.priority}")
            print(f"Category: {target_comment.category}")
            print(
                f"Status: {'Resolved' if target_comment.is_resolved else 'Unresolved'}"
            )
            if target_comment.resolution_type:
                print(f"Resolution: {target_comment.resolution_type}")
            if target_comment.auto_skip_reason:
                print(f"Auto-skip reason: {target_comment.auto_skip_reason}")
            if target_comment.url:
                print(f"URL: {target_comment.url}")
            print("\n" + "=" * 80)
            print("COMMENT CONTENT:")
            print("=" * 80)
            print(target_comment.body)
            print("=" * 80)
        return

    # Validate PR number
    if not args.pr_number:
        parser.error("PR number is required")

    # Initialize components
    resolution_manager = ResolutionManager(args.pr_number)

    # Handle resolution commands
    if args.resolve:
        comment_ids = [cid.strip() for cid in args.resolve.split(",")]
        # Initialize GitHub API for remote resolution
        github_api = GitHubAPI(args.pr_number)
        resolution_manager.mark_resolved(comment_ids, github_api)
        return

    if args.skip:
        comment_ids = [cid.strip() for cid in args.skip.split(",")]
        resolution_manager.mark_skipped(comment_ids)
        return

    # Handle status commands
    if args.status or args.status_unresolved or args.assess:
        status_display = StatusDisplay(resolution_manager)
        if args.assess:
            # Show assessment guidance for unresolved comments
            status_display.show_status(unresolved_only=True, show_assessment=True)
        else:
            status_display.show_status(unresolved_only=args.status_unresolved)
        return

    # Default: fetch and display comments
    logger.info(f"📝 Fetching comments for PR #{args.pr_number}...")

    # Initialize GitHub API and comment processor
    github_api = GitHubAPI()
    comment_processor = CommentProcessor()

    # Fetch comments from GitHub
    review_threads, pr_comments, review_comments = github_api.fetch_comments(
        args.pr_number
    )

    # Combine all comments
    all_comments = review_threads + pr_comments + review_comments

    if not all_comments:
        if RICH_AVAILABLE:
            console = Console()
            console.print("[yellow]⚠️  No comments found for this PR[/yellow]")
        else:
            logger.warning("⚠️  No comments found for this PR")
        return

    # Process comments to extract metadata
    if RICH_AVAILABLE:
        console = Console()
        console.print("[bold green]Processing comments...[/bold green]")
        processed_comments = comment_processor.process_comments(all_comments)
        console.print("[green]✅ Comments processed[/green]")
    else:
        processed_comments = comment_processor.process_comments(all_comments)

    # Automatically skip command and summary comments (they're not actionable review feedback)
    command_comment_ids = [
        comment.comment_id
        for comment in processed_comments
        if comment.category == "command"
    ]

    summary_comment_ids = [
        comment.comment_id
        for comment in processed_comments
        if comment.category == "summary"
    ]

    # Skip both command and summary comments
    auto_skip_ids = command_comment_ids + summary_comment_ids

    if auto_skip_ids:
        resolution_manager.mark_skipped(auto_skip_ids)

    # Automatically resolve comments that have been addressed (contain "✅ Addressed")
    addressed_comment_ids = [
        comment.comment_id
        for comment in processed_comments
        if "✅ Addressed" in comment.body
    ]

    if addressed_comment_ids:
        resolution_manager.mark_resolved(addressed_comment_ids)

    # Save comments to file - optimized serialization
    comments_data = {
        "comments": [
            {
                "comment_id": comment.comment_id,
                "body": comment.body,
                "author": comment.author,
                "createdAt": comment.created_at,
                "updatedAt": comment.updated_at,
                "file_path": comment.file_path,
                "position": comment.position,
                "url": comment.url,
                "is_resolved": comment.is_resolved,
                "resolution_type": comment.resolution_type,
                "priority": comment.priority,
                "category": comment.category,
                "type": comment.type,
                "line_range": comment.line_range,
                "has_code_changes": comment.has_code_changes,
                "auto_skip_reason": getattr(comment, "auto_skip_reason", None),
                "thread_id": getattr(comment, "thread_id", None),
            }
            for comment in processed_comments
        ],
        "total_comments": len(processed_comments),
    }

    # Save to file
    resolution_manager.comments_file.parent.mkdir(exist_ok=True)
    with open(resolution_manager.comments_file, "w", encoding="utf-8") as f:
        json.dump(comments_data, f, indent=2)

    # Complete processing
    if RICH_AVAILABLE:
        console.print("[green]✅ Comments saved[/green]")

    # Display comments using unified display
    if RICH_AVAILABLE:
        console = Console()
        console.print(
            f"[green]✅ Fetched {len(processed_comments)} comments for PR #{args.pr_number}[/green]"
        )
        console.print()

        # Load existing resolution state and update comments
        status_display = StatusDisplay(resolution_manager)
        status_display.resolution_manager.update_comments_resolution_state(
            processed_comments
        )

        # Use unified display for fetch summary with actual resolution status
        status_display._create_unified_table(
            processed_comments, "📝 All Comments", show_summary=True
        )
        console.print()
        console.print(
            "[dim]💡 Use --status to see resolution status, --assess for guidance, --resolve/--skip to manage comments[/dim]"
        )

    else:
        # Plain text fallback
        logger.info(
            f"✅ Fetched {len(processed_comments)} comments for PR #{args.pr_number}"
        )
        print("\n📊 Comment Summary:")
        print(f"  Total: {len(processed_comments)}")
        print(
            f"  Major: {len([c for c in processed_comments if c.priority == 'major'])}"
        )
        print(
            f"  Minor: {len([c for c in processed_comments if c.priority == 'minor'])}"
        )
        print(
            f"  Trivial: {len([c for c in processed_comments if c.priority == 'trivial'])}"
        )
        print(
            "\n💡 Use --status to see resolution status, --assess for guidance, --resolve/--skip to manage comments"
        )


if __name__ == "__main__":
    main()
