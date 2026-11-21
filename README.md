# Cutawan with Filmcraft

A customized build of [Cutawan](https://github.com/JeremySNR/cutawan), the open-source desktop editor for turning long recordings into captioned clips.

## What this version adds

- **Filmcraft handoff.** Send a selected clip from Cutawan to a local Filmcraft installation for further editing. The [handoff code](src/renderer/src/filmcraftHandoff.ts) and [project plan](src/shared/filmcraftPlan.ts) cover the transfer.
- **Style presets.** Start from reusable styling settings when editing a clip. The preset definitions and editing behavior live in [stylePreset.ts](src/shared/stylePreset.ts).

## Run from source

```bash
npm ci
npm run dev
```

The desktop app uses Electron, React, and TypeScript. Use Node.js 20+ for development. The Filmcraft handoff requires a local Filmcraft installation. Run `npm test` for the test suite or `npm run typecheck` to check the TypeScript projects.

## Credits

Based on [JeremySNR/cutawan](https://github.com/JeremySNR/cutawan), with the original [MIT license](LICENSE) retained. The upstream repository maintains the standard Cutawan installers and documentation.
