#!/usr/bin/env python3
"""
Test script to re-process stored comments with fixed regex patterns
"""

import json
import re
from pathlib import Path
from dataclasses import dataclass
from typing import List, Optional

@dataclass
class Comment:
    comment_id: str
    body: str
    author: str
    created_at: str
    updated_at: str
    file_path: Optional[str] = None
    priority: str = "unknown"
    category: str = "other"

class TestCommentProcessor:
    """Test processor with fixed regex patterns"""

    def __init__(self):
        # Fixed regex patterns
        self._file_patterns = [
            re.compile(r"In ([^\s]+) around lines?"),
            re.compile(r"In ([^\s]+) at lines?"),
            re.compile(r"([^\s]+\.(ts|js|json|md|txt|yml|yaml)) around lines?"),
            # FIXED: Pattern for review comments: <summary>filename.ext (count)</summary>
            re.compile(r"<summary>([^\s<>()]+\.(ts|js|json|md|txt|yml|yaml|py|sh)) \(\d+\)</summary>"),
            # FIXED: Pattern for review comments: <summary>filename.ext</summary>
            re.compile(r"<summary>([^\s<>()]+\.(ts|js|json|md|txt|yml|yaml|py|sh))</summary>"),
            # FIXED: Pattern for review comments: <summary>filename (count)</summary> - for files without extensions
            re.compile(r"<summary>([^\s<>()]+) \(\d+\)</summary>"),
            # FIXED: Pattern for review comments: <summary>filename</summary> - for files without extensions
            re.compile(r"<summary>([^\s<>()]+)</summary>"),
        ]

        self._priority_patterns = {
            "major": re.compile(r"(Major|P1|⚠️|CAUTION)", re.IGNORECASE),
            "minor": re.compile(r"Minor", re.IGNORECASE),
            "trivial": re.compile(r"Trivial", re.IGNORECASE),
        }

        self._category_patterns = {
            "summary": re.compile(r"## Walkthrough"),
            "command": re.compile(r"^@(coderabbit|CodeRabbit|codex)", re.IGNORECASE | re.MULTILINE),
            "nitpick": re.compile(r"Nitpick"),
            "issue": re.compile(r"Potential issue|⚠️|CAUTION"),
            "refactor": re.compile(r"Refactor|♻️|Duplicate comments"),
            "outside_diff": re.compile(r"Outside diff range|outside the diff"),
        }

    def _extract_file_path(self, body: str) -> Optional[str]:
        """Extract file path from comment body"""
        for pattern in self._file_patterns:
            match = pattern.search(body)
            if match:
                return match.group(1)
        return None

    def _extract_priority(self, body: str) -> str:
        """Extract priority from comment body"""
        for priority, pattern in self._priority_patterns.items():
            if pattern.search(body):
                return priority
        return "unknown"

    def _extract_category(self, body: str) -> str:
        """Extract category from comment body"""
        for category, pattern in self._category_patterns.items():
            if pattern.search(body):
                return category
        return "other"

    def reprocess_comment(self, comment: Comment) -> Comment:
        """Re-process a single comment with fixed patterns"""
        # Force re-extraction by resetting the fields
        comment.file_path = None
        comment.priority = "unknown"
        comment.category = "other"

        # Now extract with fixed patterns
        comment.file_path = self._extract_file_path(comment.body)
        comment.priority = self._extract_priority(comment.body)
        comment.category = self._extract_category(comment.body)
        return comment

def test_reprocess():
    """Test re-processing stored comments with fixed regex"""

    # Load the stored comments
    comments_file = Path('.local.test/pr-137-change-comments.json')
    if not comments_file.exists():
        print("❌ Test data not found")
        return

    with open(comments_file, 'r', encoding='utf-8') as f:
        data = json.load(f)

    # Convert to Comment objects
    comments = []
    for comment_data in data['comments']:
        comment = Comment(
            comment_id=comment_data['comment_id'],
            body=comment_data['body'],
            author=comment_data['author'],
            created_at=comment_data['createdAt'],
            updated_at=comment_data['updatedAt'],
            file_path=comment_data.get('file_path'),
            priority=comment_data.get('priority', 'unknown'),
            category=comment_data.get('category', 'other'),
        )
        comments.append(comment)

    print(f"📝 Loaded {len(comments)} comments for re-processing")

    # Re-process with fixed regex
    processor = TestCommentProcessor()
    reprocessed = []
    for comment in comments:
        reprocessed.append(processor.reprocess_comment(comment))

    # Check the Node.js version comment specifically
    target_id = 'PRR_kwDOOQ6Yxs7EKSAE'
    for comment in reprocessed:
        if comment.comment_id == target_id:
            print(f"\n🎯 FOUND TARGET COMMENT:")
            print(f"  ID: {comment.comment_id}")
            print(f"  File Path: {comment.file_path}")
            print(f"  Priority: {comment.priority}")
            print(f"  Category: {comment.category}")
            print(f"  Body preview: {comment.body[:200]}...")
            break
    else:
        print(f"\n❌ Target comment {target_id} not found")

    # Count malformed file paths
    malformed = [c for c in reprocessed if c.file_path and ('(' in c.file_path or ')' in c.file_path)]
    print(f"\n📊 Results:")
    print(f"  Total comments: {len(reprocessed)}")
    print(f"  Malformed file paths: {len(malformed)}")

    # Show some examples of fixed file paths
    fixed_examples = [c for c in reprocessed if c.file_path and c.file_path not in ['([^\\s]+)', 'General'] and c.comment_id.startswith('PRR_')]
    print(f"  Fixed file paths: {len(fixed_examples)}")
    if fixed_examples:
        print("  Examples:")
        for comment in fixed_examples[:3]:
            print(f"    {comment.comment_id}: {comment.file_path}")

if __name__ == "__main__":
    test_reprocess()
