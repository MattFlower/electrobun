# Releasing a Tempest fork build

This fork is consumed by the Tempest app via a GitHub release tarball URL
rather than npm. The tarball is self-contained: it includes the TypeScript
API source, the prebuilt `libNativeWrapper.dylib` (with our patches), the
prebuilt CLI binary, and all other `dist-macos-arm64/` runtime binaries
that the CLI needs to assemble a `.app` bundle. Consumers point
`package.json` at the release asset URL and `bun install` does the rest.

## When to cut a new release

- You've added or changed a preload file (`package/src/bun/preload/**`)
- You've changed anything under `package/src/bun/core/**` or
  `package/src/bun/proc/**` that Tempest imports at runtime
- You've modified `package/src/native/macos/nativeWrapper.mm` and need
  Tempest to pick up the rebuilt `libNativeWrapper.dylib`

You do **not** need to cut a new release for changes that only affect
the CLI (`src/cli/**`), the Zig launcher, or the fork's internal
developer tooling — Tempest doesn't exercise those.

## Prerequisites (one-time)

- You've already run a successful `bun build.ts` at least once so
  `package/src/native/build/libNativeWrapper.dylib` exists. If the full
  build is broken, it's fine as long as the `.mm` → `.dylib` step
  succeeds (the rest of the pipeline isn't required for the tarball
  distribution path). Confirm with:
  `ls package/src/native/build/libNativeWrapper.dylib`

## Cutting a release

1. Make sure your changes are committed on a branch. Pick a new version
   suffix, e.g. `1.17.3-beta.11-tempest.2`.

2. Update `package/package.json` version field.

3. Rebuild the patched dylib if needed:
   ```
   cd package
   # The minimum slice of build.ts you need is the clang++ step that
   # compiles src/native/macos/nativeWrapper.mm into libNativeWrapper.dylib.
   # The simplest way is to run the full build and let it fail after the
   # dylib step — the dylib is produced before the Zig launcher / CLI
   # compile steps that currently error out.
   bun build.ts
   ```

4. Rebuild `dist/` with the patched preload and API files:
   ```
   cd package
   bun scripts/prepare-dist.ts
   ```

5. Refresh the patched dylib in `dist-macos-arm64/` and re-ad-hoc-sign it:
   ```
   cp src/native/build/libNativeWrapper.dylib dist-macos-arm64/libNativeWrapper.dylib
   codesign --remove-signature dist-macos-arm64/libNativeWrapper.dylib 2>/dev/null || true
   codesign -s - dist-macos-arm64/libNativeWrapper.dylib
   ```

6. Pack the tarball:
   ```
   cd package
   bun pm pack
   # produces electrobun-1.17.3-beta.11-tempest.N.tgz in the package folder
   ```

7. Commit the version bump (no other files — `dist/`, `dist-macos-arm64/`,
   and the `.tgz` are all gitignored):
   ```
   git add package.json
   git commit -m "chore: bump fork to 1.17.3-beta.11-tempest.N"
   ```

8. Tag and push:
   ```
   git tag v1.17.3-beta.11-tempest.N
   git push origin auto-mask-overlays
   git push origin v1.17.3-beta.11-tempest.N
   ```

9. Create a GitHub release on `MattFlower/electrobun`:
   ```
   gh release create v1.17.3-beta.11-tempest.N \
     --repo MattFlower/electrobun \
     --title "v1.17.3-beta.11-tempest.N" \
     --notes "Tempest fork build. See the auto-mask-overlays branch for diffs from upstream." \
     package/electrobun-1.17.3-beta.11-tempest.N.tgz
   ```

10. Update Tempest's `package.json`:
    ```json
    "electrobun": "https://github.com/MattFlower/electrobun/releases/download/v1.17.3-beta.11-tempest.N/electrobun-1.17.3-beta.11-tempest.N.tgz"
    ```

11. Run `bun install` in Tempest, commit the updated `package.json` and
    `bun.lock`, and push. CI will pick up the fork on the next build.

## Why this shape

Electrobun's normal distribution downloads the CLI and platform binaries
from `github.com/blackboardsh/electrobun/releases` at runtime via the
wrapper in `bin/electrobun.cjs`. Rather than patch those URLs, fix the
fork's broken CLI/launcher builds, and become a full distributor, this
approach just ships one large self-contained tarball per release:

- `bin/electrobun` — a prebuilt CLI binary. Because it's already present,
  `bin/electrobun.cjs` skips the runtime download entirely.
- `dist-macos-arm64/` — all the binaries the CLI would normally fetch
  from `electrobun-core-darwin-arm64.tar.gz`, pre-placed so
  `ensureCoreDependencies()` sees they exist and skips the download.
- `dist/api/**` — the TypeScript source files Tempest imports via
  `electrobun/bun`, `electrobun/view`, etc.
- `libNativeWrapper.dylib` is replaced with our patched build so both
  `setWindowButtonPosition` and the additional FFI surface needed by
  other fork patches are available at runtime.

The tradeoff is a ~50 MB tarball per release (vs. ~tens of KB for a
normal npm package) and the fact that we're currently only shipping
`darwin-arm64`. Adding `darwin-x64` / `win-x64` / `linux-x64` would mean
populating more `dist-$os-$arch/` directories before packing.
