# Changelog

## 0.1.1

- Replace the filesystem skill provider inside the standard, ptc and cordis Web presets; remove the redundant global provider.
- Add a regression comparing every other preset field with the shipped configuration.

## 0.1.0

- Cache complete watched skill catalogs across sessions in the same working directory.
- Coalesce concurrent discovery without coupling caller cancellation.
- Bound file-read concurrency and exclude bundle resources from watcher traversal.
