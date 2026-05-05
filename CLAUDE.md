# Claude Development Guidelines for Electrobun

## This is a fork — read this first

This repo is `MattFlower/electrobun`, a fork of `blackboardsh/electrobun`
maintained for the **Tempest** macOS app (`~/tempest/workspaces/...`).
The fork's `main` branch mirrors upstream `main` exactly — all
customizations live on `auto-mask-overlays`, which currently sits on
top of upstream `v1.18.1` and carries two preload-only changes:

1. `auto-mask` attribute on `<electrobun-webview>` for automatic
   masking of host overlays over native browser panes.
2. A re-sync bugfix in `OverlaySyncController` (preload).

(Earlier versions of this fork also carried chrisdadev13's
`setWindowButtonPosition` PR #294 patch, but that has since landed
upstream and is no longer maintained as a fork patch.)

Tempest doesn't consume this repo via npm. It pulls a self-contained
tarball directly from a GitHub release on this fork. The release flow
and what goes in the tarball is documented in
`RELEASING-TEMPEST-FORK.md` at the root of this repo. **Read that file
before publishing or modifying release artifacts.**

When in doubt about why a particular file is shaped the way it is,
or how Tempest depends on us, also see
`<tempest-checkout>/AI_DOCS/electrobun-fork.md`.

## Building and Running Electrobun

### IMPORTANT: Build Commands

**NEVER** run electrobun directly from the bin folder or node_modules. The correct way to build and run Electrobun is:

1. **From the package folder** (`/home/yoav/code/electrobun/package/`):
   - `bun dev` - Builds and runs the kitchen app in dev mode
   - `bun dev:canary` - Builds the kitchen app in canary mode

2. **Build Process Flow**:
   - Always run build commands from the `package` folder
   - The build process will automatically:
     - Build the native wrappers
     - Compile the TypeScript code
     - Build the CLI
     - Switch to the kitchen folder and build/run the app

## Project Structure

- `/package` - Main Electrobun package source
- `/kitchen` - Test application (Kitchen Sink)
- `/package/src/cli` - CLI implementation
- `/package/src/extractor` - Self-extractor implementation (Zig)
- `/package/src/native` - Native wrappers for each platform
