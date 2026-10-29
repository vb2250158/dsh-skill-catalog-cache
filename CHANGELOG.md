# Changelog

## 0.1.2

- Replace scoped skill providers in standard, ptc and cordis Web presets, and defer the optional filesystem dependency.
- Preserve readable roots when another root fails; retry incomplete catalogs.
- Verify preset composition and late filesystem startup.

## 0.1.0

- Cache complete watched skill catalogs across sessions.
- Coalesce concurrent discovery and bound file-read concurrency.