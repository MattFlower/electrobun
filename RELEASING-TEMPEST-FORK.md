# Releasing a Tempest fork build

This fork is consumed by the Tempest app via GitHub release tarball
URLs rather than npm. Each release ships **one tarball per supported
platform** (currently `darwin-arm64` and `linux-x64`) as separate
assets on the same release tag. Each tarball is self-contained: it
includes the TypeScript API source (with our preload-only patches),
the prebuilt CLI binary for that platform, and the matching
`dist-<os>-<arch>/` runtime binaries. Consumers point `package.json`
at the per-platform release asset URL and `bun install` does the
rest.

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
native dylib/so does not need to be rebuilt. If a future patch touches
`nativeWrapper.mm`, see the "With native changes" section at the end.

The flow has two halves: shared steps (run once per release) and a
per-platform pack block (run once for `darwin-arm64`, once for
`linux-x64`). The two `bun pm pack` invocations both produce a file
named `electrobun-<VERSION>.tgz`, so each gets renamed with a
platform-arch suffix immediately after pack to avoid clobbering.

You can do all of this on a macOS host — no Linux machine is needed,
since each per-platform block just downloads upstream's prebuilt
binaries for that target and re-packs them.

### Shared steps

1. **Pick a version.** Use `<upstream-version>-tempest.<N>`, e.g. if
   the branch sits on upstream `v1.18.1`, the next release is
   `1.18.1-tempest.2`.

2. **Update `package/package.json` version field** to match.

3. **Rebuild `dist/`** with the fork's patched preload and updated API
   files. `dist/` is platform-neutral, so this runs once and serves
   both per-platform tarballs:
   ```
   cd package
   bun scripts/prepare-dist.ts
   ```

### Per-platform pack — macOS arm64

4. **Refresh `dist-macos-arm64/` and `bin/electrobun` with the matching
   upstream darwin-arm64 binaries.** Wipe both per-platform dirs first
   so only the macOS one ends up in this pack:

   ```
   cd package
   rm -rf dist-macos-arm64 dist-linux-x64
   mkdir dist-macos-arm64
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

5. **Pack and rename the macOS tarball:**
   ```
   cd package
   bun pm pack
   mv electrobun-<UPSTREAM>-tempest.N.tgz electrobun-<UPSTREAM>-tempest.N-darwin-arm64.tgz
   ```

### Per-platform pack — linux x64

6. **Refresh `dist-linux-x64/` and `bin/electrobun` with the matching
   upstream linux-x64 binaries.** Same shape as the macOS block, with
   the URLs and per-platform dir swapped:

   ```
   cd package
   rm -rf dist-macos-arm64 dist-linux-x64
   mkdir dist-linux-x64
   curl -sL https://github.com/blackboardsh/electrobun/releases/download/v<UPSTREAM>/electrobun-core-linux-x64.tar.gz \
     | tar -xz -C dist-linux-x64
   # If the linux core tarball ships duplicate api/ + main.js + npmbin.js
   # like the darwin one, trim them too. The `|| true` keeps this
   # non-fatal if upstream changes shape.
   rm -rf dist-linux-x64/api dist-linux-x64/main.js dist-linux-x64/npmbin.js 2>/dev/null || true

   cd /tmp && curl -sL https://github.com/blackboardsh/electrobun/releases/download/v<UPSTREAM>/electrobun-cli-linux-x64.tar.gz \
     -o cli.tgz && tar -xzf cli.tgz
   cp electrobun /Users/<you>/code/electrobun/package/bin/electrobun
   chmod 755 /Users/<you>/code/electrobun/package/bin/electrobun
   rm cli.tgz electrobun
   ```

7. **Pack and rename the linux tarball:**
   ```
   cd package
   bun pm pack
   mv electrobun-<UPSTREAM>-tempest.N.tgz electrobun-<UPSTREAM>-tempest.N-linux-x64.tgz
   ```

### Shared steps (continued)

8. **Commit the version bump** (no other files — `dist/`,
   `dist-macos-arm64/`, `dist-linux-x64/`, `bin/electrobun`, and the
   `.tgz` artifacts are all gitignored):
   ```
   git add package.json
   git commit -m "chore: bump fork to <UPSTREAM>-tempest.N"
   ```

9. **Tag and push:**
   ```
   git tag v<UPSTREAM>-tempest.N
   git push origin auto-mask-overlays
   git push origin v<UPSTREAM>-tempest.N
   ```

10. **Create a GitHub release** on `MattFlower/electrobun` with **both**
    per-platform tarballs as assets:
    ```
    gh release create v<UPSTREAM>-tempest.N \
      --repo MattFlower/electrobun \
      --title "v<UPSTREAM>-tempest.N" \
      --notes "Tempest fork build, rebased on upstream v<UPSTREAM>." \
      package/electrobun-<UPSTREAM>-tempest.N-darwin-arm64.tgz \
      package/electrobun-<UPSTREAM>-tempest.N-linux-x64.tgz
    ```

11. **Update Tempest's `package.json`** to point at the per-platform
    URL for the build host. Tempest selects the right URL per platform;
    the implementation lives in the Tempest repo. URL pattern:

    - macOS arm64 → `https://github.com/MattFlower/electrobun/releases/download/v<UPSTREAM>-tempest.N/electrobun-<UPSTREAM>-tempest.N-darwin-arm64.tgz`
    - Linux x64   → `https://github.com/MattFlower/electrobun/releases/download/v<UPSTREAM>-tempest.N/electrobun-<UPSTREAM>-tempest.N-linux-x64.tgz`

12. **Run `bun install`** in Tempest on each target host, smoke-test,
    then commit the updated `package.json` and `bun.lock`. CI picks
    up the fork on the next build.

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

1. Inside the macOS per-platform block (after step 4, where you've
   just refreshed `dist-macos-arm64/` from upstream), rebuild the
   dylib from your patched source. The minimum slice of `build.ts`
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
3. Continue from step 5 ("Pack and rename the macOS tarball") of
   "Cutting a release". The linux per-platform block is unaffected.

## Why this shape

Electrobun's normal distribution downloads the CLI and platform
binaries from `github.com/blackboardsh/electrobun/releases` at runtime
via the wrapper in `bin/electrobun.cjs`. Rather than patch those URLs,
fix the fork's broken CLI/launcher builds, or become a full
distributor, this approach just ships one large self-contained tarball
per release:

- `bin/electrobun` — a prebuilt CLI binary copied from blackboardsh's
  release for the target platform. Because it's already present,
  `bin/electrobun.cjs` skips the runtime download entirely.
- `dist-<os>-<arch>/` — all the binaries the CLI would normally fetch
  from `electrobun-core-<os>-<arch>.tar.gz`, pre-placed so
  `ensureCoreDependencies()` sees they exist and skips the download.
  Each per-platform tarball ships exactly one of these dirs.
- `dist/api/**` — the TypeScript source files Tempest imports via
  `electrobun/bun`, `electrobun/view`, etc., **with our preload
  patches baked in** via `prepare-dist.ts`. Identical across platforms.

The tradeoff is a ~50 MB tarball per platform per release (vs. ~tens
of KB for a normal npm package). We currently ship `darwin-arm64` and
`linux-x64`. Adding more targets (`darwin-x64`, `win-x64`,
`linux-arm64`) means another per-platform pack block in the release
flow above and another asset on the `gh release create` line.
