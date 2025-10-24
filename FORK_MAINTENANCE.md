# Fork Maintenance Strategy

## Overview

Simple two-branch model: `main` tracks upstream, `develop` is your working branch with all features.

## Branching Strategy

### Two-Branch Model

- **main**: Tracks upstream/main (never commit directly, only sync)
- **develop**: Your working branch with all features (default branch for daily work)

### Daily Development Workflow

```bash
# Work directly on develop
git checkout develop
# ... make changes, commit ...
git push origin develop

# OR use feature branches from develop
git checkout develop
git checkout -b feat/my-feature
# ... develop ...
git push origin feat/my-feature
git checkout develop
git merge feat/my-feature
```

### Upstream Sync Workflow

```bash
# 1. Sync main with upstream
git checkout main
git fetch upstream
git merge upstream/main --ff-only
git push origin main

# 2. Merge upstream changes into develop
git checkout develop
git merge main
# Resolve any conflicts
git push origin develop
```

That's it! Simple and straightforward.

### Occasional Upstream PR (Exception Case)

When you want to contribute something upstream:

```bash
# Option A: Cherry-pick specific commits
git checkout main
git checkout -b upstream-pr/my-feature
git cherry-pick <commit-hash>  # Pick clean commits
git push origin upstream-pr/my-feature
# Create PR to upstream from this branch

# Option B: Create clean branch and reimplement
git checkout main
git checkout -b upstream-pr/my-feature
# Re-implement feature cleanly
git push origin upstream-pr/my-feature
# Create PR to upstream
```

## Version Management

- Use semantic versioning with fork suffix: `2.11.0-fork.1`
- Tag stable points: `git tag v2.11.0-fork.1`
- Increment fork version when adding features

## Benefits

- Simple: Only two permanent branches
- Natural: Develop features where you use them (develop)
- Flexible: Features can build on each other
- Clean upstream sync: main → develop merge
- PR-ready when needed: Create clean branch on demand
- No constant rebasing or branch management overhead

## Recommended Setup

Set `develop` as default branch on GitHub so it's what people see and what you check out by default.

## Quick Reference

### Check for upstream updates
```bash
git fetch upstream
git log main..upstream/main --oneline
```

### Sync with upstream (when updates available)
```bash
git checkout main
git merge upstream/main --ff-only
git push origin main
git checkout develop
git merge main
git push origin develop
```

### Create a new feature
```bash
git checkout develop
git checkout -b feat/feature-name
# ... develop and commit ...
git push origin feat/feature-name
git checkout develop
git merge feat/feature-name
git push origin develop
```

### Tag a release
```bash
git checkout develop
git tag v2.11.0-fork.1
git push origin v2.11.0-fork.1
```