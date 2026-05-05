# Claude Development Guidelines for Electrobun

## This is a fork — read this first

This repo is `MattFlower/electrobun`, a fork of `blackboardsh/electrobun`
maintained for the **Tempest** macOS app (`~/tempest/workspaces/...`).
The active branch is `auto-mask-overlays`. It carries three changes on
top of upstream's `1.17.3-beta.11`:

1. `setWindowButtonPosition` API for macOS traffic lights (upstream
   PR #294 by chrisdadev13, not yet merged).
2. `auto-mask` attribute on `<electrobun-webview>` for automatic
   masking of host overlays.
3. A re-sync bugfix in `OverlaySyncController` (preload).

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
