# Storage inventory (experimental)

The new `storage` command ranks local repositories by estimated logical size.
It uses the **existing safe repository discovery and diagnosis pipeline**, so Git
safety classifications are not reimplemented.

```sh
# Inspect all repositories known to ghq, sorted largest first
gh-local-repo-cleaner storage

# Scan the direct child repositories of a directory
gh-local-repo-cleaner storage /path/to/repos

# Machine-readable output
gh-local-repo-cleaner storage --json | jq '.repositories[:10]'
```

JSON returns `schema_version`, `repositories`, `summary` and `errors`.
Each repository has `path`, `name`, `size_bytes` (nullable),
`last_commit_at`, `last_commit_status`, `status`, and `reason_codes`.
Unknown sizes sort last and are counted separately, not treated as zero.

**Safety:** This command never moves or deletes files. A repository's size and
age are not enough to establish whether it can safely be removed. Review
`inspect` and the existing safety checks before using `clean`. The sum is an
estimate of logical sizes, not guaranteed free disk space recoverable by moving
repositories to trash on the same volume.

## Next steps

- Optional `gdu` adapter for more detailed directory breakdown.
- Cache-category inventory for `node_modules/`, `target/` and build outputs.
- Size sorting and cache details within the existing TUI.
- Explicit, separately reviewed cache-clean operation with dry-run and race protection.
