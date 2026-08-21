# Repository Guidelines

## Project Structure & Module Organization

Paper Piano is a single-page browser application. `index.html` loads the app and CDN dependencies. Keep presentation in `css/style.css` and application code in `js/`:

- `main.js` owns DOM wiring, camera lifecycle, and the render loop.
- `hand-tracker.js`, `shape-detector.js`, `note-recognizer.js`, and `audio-engine.js` are focused browser-global classes for their respective subsystems.
- `README.md` documents setup, controls, and the vision/audio architecture.

There is no bundler, `src/` directory, or generated asset directory. Load any new browser scripts from `index.html` in dependency order.

## Build, Test, and Development Commands

Install dependencies once:

```bash
npm install
```

Run the local development server (with live reload) at `http://localhost:8000`:

```bash
npm start
# npm run dev is equivalent
```

Run unit tests with Node's built-in test runner:

```bash
npm test
```

Camera access requires localhost or HTTPS; do not test by opening `index.html` directly. There is currently no build command.

## Coding Style & Naming Conventions

Use vanilla JavaScript with `'use strict';`, ES6 classes, and `camelCase` for variables and methods. Class names use `PascalCase` (for example, `ShapeDetector`). Preserve the existing JavaScript format: four-space indentation, spaces before method parentheses (`init ()`), aligned assignments where already used, and concise subsystem comments. Use `const` by default and `let` only for reassignment.

CSS uses two-space indentation, kebab-case custom properties such as `--text-dim`, and component-oriented section comments. Keep DOM IDs and selectors consistent with `index.html`.

## Testing Guidelines

Add focused `node:test` cases in `test/` for deterministic JavaScript behavior, then run `npm test`. Also validate changes manually in Chrome or Edge with a webcam. Exercise camera startup, shape scanning, fingertip interaction, audio playback, control toggles, and the Debug panel. For vision changes, check rectangles, circles, adjacent keys, varied lighting, and mirrored video. Record the browser and scenario used in the pull request when behavior is hardware-dependent.

## Commit & Pull Request Guidelines

Recent history is brief and informal, with occasional conventional prefixes such as `feat:`. Prefer short, imperative subjects; use `feat:`, `fix:`, or `docs:` when the change type is clear (for example, `fix: reject small contour noise`). Keep commits focused.

Pull requests should summarize the user-visible change, mention affected modules, link any relevant issue, and include screenshots or a short recording for UI, overlay, or detection changes. State the manual checks performed and call out camera/browser limitations.
