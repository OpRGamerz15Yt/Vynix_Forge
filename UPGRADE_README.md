# VynixForge — Upgraded Minecraft Launcher Builder

**VynixForge v1.1** by Vynix Studio (NovaGamer15)

This is an upgraded version of the existing VynixForge web-based Minecraft launcher builder.

## What was upgraded

- Modernized UI with smoother transitions, better focus states, improved responsive sidebar, refined cards and buttons.
- Added **Quilt** as a supported mod loader alongside Fabric, Forge, and NeoForge.
- Version bumped to v1.1 with clearer local-build messaging.
- Preserved all existing working features: project management (create/edit/duplicate/delete/import/export), multi-step configurator (Overview → Minecraft → Server → Mods → Packs → Shaders → Branding → Preview → Validate → Build → Export), live preview, localStorage persistence, and full Electron scaffold generation.

## Real functionality

- Generates a **complete, buildable Electron project** containing:
  - `src/config.js` — your exact launcher configuration
  - `src/minecraft.js` — launch logic using `minecraft-launcher-core`
  - `src/main.js`, UI files, `package.json` with electron-builder config
  - README with build instructions
- Export produces a downloadable ZIP of the full launcher source.
- All configuration is validated client-side.
- Clearly documents that the browser cannot launch Minecraft or install Java — the generated project must be built locally with Node.js (`npm install && npm run build`).

## Browser limitations (important)

This is a pure frontend application. It cannot:
- Install or launch Java / Minecraft directly
- Access the user's local filesystem beyond downloads
- Run a real build server

The generated Electron project is the integration layer. Users (or a future backend) must run the build step on a machine with Node.js.

## How to deploy

1. Upload `index.html` and `style.css` (and any assets) to your static host (e.g. the existing indevs.in subdomain).
2. Ensure JSZip CDN is reachable (already included).
3. Test by creating a project, configuring Vanilla and Modded modes, using the branding editor + live preview, validating, and downloading the export ZIP.
4. Open the ZIP, run `npm install && npm run build` to produce a Windows `.exe`.

## Files changed

- `style.css` — full modernization
- `index.html` — minor JS patches (Quilt loader, version) + reassembled
- Original structure and branding fully preserved

## Testing checklist

- [ ] Dashboard loads, empty state shows correctly
- [ ] Create Vanilla project → configure version, memory, resolution → preview updates
- [ ] Create Modded project → select Fabric/Forge/NeoForge/Quilt → add mods
- [ ] Branding editor changes colors/logo → live preview reflects them
- [ ] Export downloads valid ZIP with launcher source
- [ ] Import JSON restores project
- [ ] Responsive on mobile (sidebar collapses)
- [ ] No console errors on normal use

Built with care for Vynix Studio. No fake buttons or non-functional controls were introduced.
