# Releasing a Tempest fork build

This fork is consumed by the Tempest app via a GitHub release tarball
URL rather than npm. Each release ships **one platform-neutral
tarball** containing the patched TypeScript source and the JS shim
CLI (`bin/electrobun.cjs`). The shim lazy-downloads upstream's
prebuilt CLI and core binaries from
`github.com/blackboardsh/electrobun/releases` on first invocation,
matching how upstream's npm package behaves. Consumers point
`package.json` at the single release asset URL and `bun install` does
the rest.

If a future fork patch ever needs to ship a modified CLI binary or
native dylib/so, fall back to the per-platform bundling flow in the
"With native changes" section at the end. That path was the original
shape of this fork.

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

These steps assume the fork's only patches are preload-side and
neither the CLI binary nor the native dylib/so needs to be rebuilt.
If a future patch touches `nativeWrapper.mm` or the CLI source, see
the "With native changes" section at the end — that path goes back
to bundling per-platform tarballs.

The tarball produced here contains only the patched TypeScript source
and the JS shim CLI. Native binaries are fetched at first run by
`bin/electrobun.cjs`, exactly the way upstream's npm install does.
The pack runs once on a single host (macOS or Linux); the result is
platform-neutral.

1. **Pick a version.** Use `<upstream-version>-tempest.<N>`, e.g. if
   the branch sits on upstream `v1.18.1`, the next release is
   `1.18.1-tempest.3`.

2. **Update `package/package.json` version field** to match.

3. **Rebuild `dist/`** with the fork's patched preload and updated API
   files:
   ```
   cd package
   bun scripts/prepare-dist.ts
   ```

4. **Wipe any platform-specific leftovers** from previous bundled
   builds so they don't sneak into the pack. The `files` field in
   `package.json` lists `dist-macos-arm64/`, `dist-linux-x64/`, and
   `bin/`, but for a lazy-download tarball we only want
   `bin/electrobun.cjs` (the JS shim) — not the prebuilt Zig binary
   `bin/electrobun` and not the per-platform dist dirs:
   ```
   rm -rf dist-macos-arm64 dist-linux-x64 bin/electrobun
   ```

5. **Pack:**
   ```
   bun pm pack
   ls electrobun-<UPSTREAM>-tempest.N.tgz
   ```
   The result should be roughly upstream-sized (~700 KB unpacked).
   If it's tens of MB, a `dist-<os>-<arch>/` or `bin/electrobun`
   leaked in — re-run step 4.

6. **Commit the version bump:**
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

8. **Create a GitHub release** with the single tarball as an asset:
   ```
   gh release create v<UPSTREAM>-tempest.N \
     --repo MattFlower/electrobun \
     --title "v<UPSTREAM>-tempest.N" \
     --notes "Tempest fork build, rebased on upstream v<UPSTREAM>." \
     package/electrobun-<UPSTREAM>-tempest.N.tgz
   ```

9. **Update Tempest's `package.json`** to point at the new URL:
   ```
   https://github.com/MattFlower/electrobun/releases/download/v<UPSTREAM>-tempest.N/electrobun-<UPSTREAM>-tempest.N.tgz
   ```

10. **Run `bun install`** in Tempest on each target host. The first
    `bun x electrobun dev` invocation will lazy-download the matching
    CLI + core binaries from upstream's release; subsequent runs are
    cached. Once you've smoke-tested both platforms, commit the
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

## With native changes (fallback: bundle per-platform tarballs)

The lazy-download flow above only works if the fork ships unmodified
upstream binaries. If a future patch touches the CLI source, the Zig
launcher, or `package/src/native/macos/nativeWrapper.mm` (or any
analogous Linux native code), the lazy-download would pull the
unpatched upstream binary and silently lose the patch. In that case
fall back to the original bundling flow: ship one self-contained
tarball per supported platform with the patched binaries pre-placed,
so `bin/electrobun.cjs` finds them locally and skips the download.

Two halves: shared steps (run once per release) and a per-platform
pack block (run once for `darwin-arm64`, once for `linux-x64`). Both
`bun pm pack` invocations produce a file named
`electrobun-<VERSION>.tgz`, so each gets renamed with a platform-arch
suffix immediately after pack to avoid clobbering. You can do all of
this on a macOS host — each per-platform block just downloads
upstream's prebuilt binaries for that target (or rebuilds the patched
slice) and re-packs them.

### Shared steps

1. **Pick a version**, **update `package/package.json`**, **rebuild
   `dist/`** — same as steps 1–3 of the lazy-download flow.

### Per-platform pack — macOS arm64

2. **Refresh `dist-macos-arm64/` and `bin/electrobun` with the matching
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

   If the patch is to `nativeWrapper.mm`, rebuild the dylib from your
   patched source after this step and replace the upstream copy:
   ```
   bun build.ts   # may error on later steps; ignore if dylib already produced
   cp src/native/build/libNativeWrapper.dylib dist-macos-arm64/libNativeWrapper.dylib
   codesign --remove-signature dist-macos-arm64/libNativeWrapper.dylib 2>/dev/null || true
   codesign -s - dist-macos-arm64/libNativeWrapper.dylib
   ```

3. **Pack and rename the macOS tarball:**
   ```
   cd package
   bun pm pack
   mv electrobun-<UPSTREAM>-tempest.N.tgz electrobun-<UPSTREAM>-tempest.N-darwin-arm64.tgz
   ```

### Per-platform pack — linux x64

4. **Refresh `dist-linux-x64/` and `bin/electrobun` with the matching
   upstream linux-x64 binaries.** Same shape as the macOS block, with
   the URLs and per-platform dir swapped:

   ```
   cd package
   rm -rf dist-macos-arm64 dist-linux-x64
   mkdir dist-linux-x64
   curl -sL https://github.com/blackboardsh/electrobun/releases/download/v<UPSTREAM>/electrobun-core-linux-x64.tar.gz \
     | tar -xz -C dist-linux-x64
   rm -rf dist-linux-x64/api dist-linux-x64/main.js dist-linux-x64/npmbin.js 2>/dev/null || true

   cd /tmp && curl -sL https://github.com/blackboardsh/electrobun/releases/download/v<UPSTREAM>/electrobun-cli-linux-x64.tar.gz \
     -o cli.tgz && tar -xzf cli.tgz
   cp electrobun /Users/<you>/code/electrobun/package/bin/electrobun
   chmod 755 /Users/<you>/code/electrobun/package/bin/electrobun
   rm cli.tgz electrobun
   ```

5. **Pack and rename the linux tarball:**
   ```
   cd package
   bun pm pack
   mv electrobun-<UPSTREAM>-tempest.N.tgz electrobun-<UPSTREAM>-tempest.N-linux-x64.tgz
   ```

### Shared steps (continued)

6. **Commit, tag, push** — same as steps 6–7 of the lazy-download flow.

7. **Create a GitHub release** on `MattFlower/electrobun` with **both**
   per-platform tarballs as assets:
   ```
   gh release create v<UPSTREAM>-tempest.N \
     --repo MattFlower/electrobun \
     --title "v<UPSTREAM>-tempest.N" \
     --notes "Tempest fork build, rebased on upstream v<UPSTREAM>." \
     package/electrobun-<UPSTREAM>-tempest.N-darwin-arm64.tgz \
     package/electrobun-<UPSTREAM>-tempest.N-linux-x64.tgz
   ```

8. **Update Tempest's `package.json`** to point at the per-platform
   URL for each build host. The single-URL pattern from the
   lazy-download flow no longer applies — Tempest needs host-aware
   selection (preinstall script, manual switching, etc.). The
   per-host URL pattern:
   - macOS arm64 → `…/electrobun-<UPSTREAM>-tempest.N-darwin-arm64.tgz`
   - Linux x64   → `…/electrobun-<UPSTREAM>-tempest.N-linux-x64.tgz`

9. **Run `bun install`** in Tempest on each target host, smoke-test,
   then commit. Each host will have its own `package.json` URL on
   disk unless you wire up a preinstall script in Tempest to pick.

## Why this shape

Upstream's `electrobun` npm package is platform-neutral and ~700 KB:
just TypeScript source plus a JS shim CLI (`bin/electrobun.cjs`)
that lazy-downloads the matching CLI + core binaries from
`github.com/blackboardsh/electrobun/releases` on first invocation.

The lazy-download flow above ships the fork the same way. The only
fork-specific content in the tarball is the patched TypeScript in
`dist/api/**` (preload patches baked in by `prepare-dist.ts`); the
binaries it eventually runs come straight from upstream. This works
because all current fork patches are preload-only — they live in TS,
not in the CLI or native code.

The bundling fallback in "With native changes" exists because
lazy-download can't deliver patched binaries: it would always pull
the unpatched upstream copy. When the fork needs to ship a modified
CLI, Zig launcher, or native dylib/so, each platform has to be packed
as a self-contained ~50 MB tarball with `dist-<os>-<arch>/` and
`bin/electrobun` pre-placed so the shim's
`ensureCoreDependencies()` sees them and skips the download. Adding
more targets in that mode (`darwin-x64`, `win-x64`, `linux-arm64`)
means another per-platform pack block and another asset on the
`gh release create` line.
