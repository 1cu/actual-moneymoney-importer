#!/usr/bin/env python3
"""
Script to identify and re-process comments with malformed file paths
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

class CommentReprocessor:
    """Re-process comments with fixed regex patterns"""

    def __init__(self):
        # Fixed regex patterns (same as in main script)
        self._file_patterns = [
            re.compile(r"In ([^\s]+) around lines?"),
            re.compile(r"In ([^\s]+) at lines?"),
            re.compile(r"([^\s]+\.(ts|js|json|md|txt|yml|yaml)) around lines?"),
            # Pattern for review comments: <summary>filename.ext (count)</summary>
            re.compile(r"<summary>([^\s<>()]+\.(ts|js|json|md|txt|yml|yaml|py|sh)) \(\d+\)</summary>"),
            # Pattern for review comments: <summary>filename.ext</summary>
            re.compile(r"<summary>([^\s<>()]+\.(ts|js|json|md|txt|yml|yaml|py|sh))</summary>"),
            # Pattern for review comments: <summary>filename (count)</summary> - for files without extensions
            re.compile(r"<summary>([^\s<>()]+) \(\d+\)</summary>"),
            # Pattern for review comments: <summary>filename</summary> - for files without extensions
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

def identify_malformed_comments():
    """Identify comments with malformed file paths"""
    with open('.local/pr-137-change-comments.json', 'r', encoding='utf-8') as f:
        data = json.load(f)

    malformed = []
    for comment_data in data['comments']:
        file_path = comment_data.get('file_path')
        if file_path and ('(' in file_path or ')' in file_path or file_path == '([^\\s]+)'):
            malformed.append(comment_data['comment_id'])

    return malformed, data

def fix_malformed_comments():
    """Fix malformed comments by re-processing them"""
    print("🔍 Identifying malformed comments...")

    malformed_ids, data = identify_malformed_comments()
    print(f"Found {len(malformed_ids)} comments with malformed file paths")

    if not malformed_ids:
        print("✅ No malformed comments found!")
        return

    # Create reprocessor
    reprocessor = CommentReprocessor()

    # Track changes
    changes = []
    processed_ids = set()  # Track processed comments to avoid duplicates

    print("🔄 Re-processing malformed comments...")
    for comment_data in data['comments']:
        if comment_data['comment_id'] in malformed_ids and comment_data['comment_id'] not in processed_ids:
            # Convert to Comment object
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

            # Store original values
            original_file_path = comment.file_path
            original_priority = comment.priority
            original_category = comment.category

            # Re-process
            reprocessed = reprocessor.reprocess_comment(comment)

            # Update the data
            comment_data['file_path'] = reprocessed.file_path
            comment_data['priority'] = reprocessed.priority
            comment_data['category'] = reprocessed.category

            # Track changes
            changes.append({
                'id': comment.comment_id,
                'original_file_path': original_file_path,
                'new_file_path': reprocessed.file_path,
                'original_priority': original_priority,
                'new_priority': reprocessed.priority,
                'original_category': original_category,
                'new_category': reprocessed.category,
            })

            # Mark as processed
            processed_ids.add(comment.comment_id)

    # Save the updated data
    print("💾 Saving updated comments...")
    with open('.local/pr-137-change-comments.json', 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

    # Report changes
    print(f"\n✅ Fixed {len(changes)} comments:")
    for change in changes:
        print(f"  {change['id']}:")
        print(f"    File: {change['original_file_path']} → {change['new_file_path']}")
        print(f"    Priority: {change['original_priority']} → {change['new_priority']}")
        print(f"    Category: {change['original_category']} → {change['new_category']}")
        print()

if __name__ == "__main__":
    fix_malformed_comments()
