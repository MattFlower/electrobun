# Releasing a Tempest fork build

This fork is consumed by the Tempest app via a GitHub release tarball
URL rather than npm. The tarball is self-contained: it includes the
TypeScript API source (with our preload-only patches), the prebuilt
CLI binary, and all `dist-macos-arm64/` runtime binaries. Consumers
point `package.json` at the release asset URL and `bun install` does
the rest.

## Branch model

- `main` mirrors upstream `blackboardsh/electrobun:main` exactly. Don't
  commit anything to fork-specific files on `main`. We force-push when
  we sync with upstream.
- `auto-mask-overlays` is the working branch. It rebases onto fresh
  `main` whenever we pull in upstream changes. Customizations live
  here only.

## When to cut a new release

- You've added or changed a preload file (`package/src/bun/preload/**`).
- You've changed anything under `package/src/bun/core/**` or
  `package/src/bun/proc/**` that Tempest imports at runtime.
- You've rebased `auto-mask-overlays` onto a newer upstream main and
  want Tempest to consume that upstream version.
- You've modified `package/src/native/macos/nativeWrapper.mm` (note:
  no current fork patches touch native code; this is hypothetical).

You do **not** need a new release for changes that only affect the CLI
source, the Zig launcher, or fork-internal tooling — Tempest doesn't
exercise those.

## Cutting a release (preload-only patches, the common case)

These steps assume the fork's only patches are preload-side and the
native dylib does not need to be rebuilt. If a future patch touches
`nativeWrapper.mm`, see the "With native changes" section at the end.

1. **Pick a version.** Use `<upstream-version>-tempest.<N>`, e.g. if
   the branch sits on upstream `v1.18.1`, the next release is
   `1.18.1-tempest.2`.

2. **Update `package/package.json` version field** to match.

3. **Refresh `dist-macos-arm64/` and `bin/electrobun` with the matching
   upstream binaries.** These come from blackboardsh's release for the
   corresponding upstream version:

   ```
   cd package
   rm -rf dist-macos-arm64 && mkdir dist-macos-arm64
   curl -sL https://github.com/blackboardsh/electrobun/releases/download/v<UPSTREAM>/electrobun-core-darwin-arm64.tar.gz \
     | tar -xz -C dist-macos-arm64
   # The core tarball ships duplicate api/ + main.js + npmbin.js inside
   # dist-macos-arm64/; trim them so the bundled TS isn't ambiguous.
   rm -rf dist-macos-arm64/api dist-macos-arm64/main.js dist-macos-arm64/npmbin.js

   cd /tmp && curl -sL https://github.com/blackboardsh/electrobun/releases/download/v<UPSTREAM>/electrobun-cli-darwin-arm64.tar.gz \
     -o cli.tgz && tar -xzf cli.tgz
   cp electrobun /Users/<you>/code/electrobun/package/bin/electrobun
   chmod 755 /Users/<you>/code/electrobun/package/bin/electrobun
   rm cli.tgz electrobun
   ```

4. **Rebuild `dist/`** with the fork's patched preload and updated API
   files:
   ```
   cd package
   bun scripts/prepare-dist.ts
   ```

5. **Pack the tarball:**
   ```
   bun pm pack
   # produces electrobun-<UPSTREAM>-tempest.N.tgz
   ```

6. **Commit the version bump** (no other files — `dist/`,
   `dist-macos-arm64/`, `bin/electrobun`, and the `.tgz` are all
   gitignored):
   ```
   git add package.json
   git commit -m "chore: bump fork to <UPSTREAM>-tempest.N"
   ```

7. **Tag and push:**
   ```
   git tag v<UPSTREAM>-tempest.N
   git push origin auto-mask-overlays
   git push origin v<UPSTREAM>-tempest.N
   ```

8. **Create a GitHub release** on `MattFlower/electrobun`:
   ```
   gh release create v<UPSTREAM>-tempest.N \
     --repo MattFlower/electrobun \
     --title "v<UPSTREAM>-tempest.N" \
     --notes "Tempest fork build, rebased on upstream v<UPSTREAM>." \
     package/electrobun-<UPSTREAM>-tempest.N.tgz
   ```

9. **Update Tempest's `package.json`**:
   ```json
   "electrobun": "https://github.com/MattFlower/electrobun/releases/download/v<UPSTREAM>-tempest.N/electrobun-<UPSTREAM>-tempest.N.tgz"
   ```

10. **Run `bun install`** in Tempest, smoke-test, then commit the
    updated `package.json` and `bun.lock`. CI picks up the fork on
    the next build.

## Pulling in upstream changes (rebase workflow)

When you want to bring in new upstream Electrobun changes:

1. Fetch upstream and reset fork main to match:
   ```
   cd ~/code/electrobun
   git fetch upstream
   git checkout main
   git reset --hard upstream/main
   git push origin main --force-with-lease
   ```
2. Rebase the working branch onto fresh main. Use `--onto` to skip
   any old chrisdadev13/PR commits if they're still in the chain
   (they're now redundant since `setWindowButtonPosition` is
   upstream-native):
   ```
   git checkout auto-mask-overlays
   git rebase --onto main 7234dbc7 auto-mask-overlays
   # Or, if no PR-#294 detritus remains in the chain, plain rebase works:
   # git rebase main
   ```
3. Resolve any conflicts (the `version` field in `package.json` will
   always conflict — set it to `<UPSTREAM>-tempest.1` for a fresh
   release series).
4. Force-push the branch: `git push origin auto-mask-overlays --force-with-lease`.
5. Then proceed through "Cutting a release" above.

## With native changes (hypothetical, currently unused)

If a future fork patch ever needs to modify
`package/src/native/macos/nativeWrapper.mm`:

1. After step 3 above (refreshing binaries from upstream), rebuild
   the dylib from your patched source. The minimum slice of `build.ts`
   you need is the clang++ step that compiles `nativeWrapper.mm`. The
   simplest way is to run the full build and let it fail after the
   dylib step:
   ```
   cd package
   bun build.ts   # may error on later steps; ignore if dylib already produced
   ls src/native/build/libNativeWrapper.dylib
   ```
2. Replace the upstream dylib with your patched build and re-ad-hoc-sign:
   ```
   cp src/native/build/libNativeWrapper.dylib dist-macos-arm64/libNativeWrapper.dylib
   codesign --remove-signature dist-macos-arm64/libNativeWrapper.dylib 2>/dev/null || true
   codesign -s - dist-macos-arm64/libNativeWrapper.dylib
   ```
3. Continue from step 4 of "Cutting a release".

## Why this shape

Electrobun's normal distribution downloads the CLI and platform
binaries from `github.com/blackboardsh/electrobun/releases` at runtime
via the wrapper in `bin/electrobun.cjs`. Rather than patch those URLs,
fix the fork's broken CLI/launcher builds, or become a full
distributor, this approach just ships one large self-contained tarball
per release:

- `bin/electrobun` — a prebuilt CLI binary copied from blackboardsh's
  release. Because it's already present, `bin/electrobun.cjs` skips
  the runtime download entirely.
- `dist-macos-arm64/` — all the binaries the CLI would normally fetch
  from `electrobun-core-darwin-arm64.tar.gz`, pre-placed so
  `ensureCoreDependencies()` sees they exist and skips the download.
- `dist/api/**` — the TypeScript source files Tempest imports via
  `electrobun/bun`, `electrobun/view`, etc., **with our preload
  patches baked in** via `prepare-dist.ts`.

The tradeoff is a ~50 MB tarball per release (vs. ~tens of KB for a
normal npm package) and the fact that we currently only ship
`darwin-arm64`. Adding `darwin-x64` / `win-x64` / `linux-x64` would
mean populating more `dist-$os-$arch/` directories before packing.
