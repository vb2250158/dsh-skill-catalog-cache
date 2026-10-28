# Changelog

## 0.1.1

- Preserve readable skill roots when another root fails, and retry failed roots without caching incomplete results.

## 0.1.0

- Cache complete watched skill catalogs across sessions in the same working directory.
- Coalesce concurrent discovery without coupling caller cancellation.
- Bound file-read concurrency and exclude bundle resources from watcher traversal.
