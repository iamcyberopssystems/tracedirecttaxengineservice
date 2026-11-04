# Notices

## This service
Copyright (C) 2026 CyberOps Systems.

This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, version 3. It is distributed WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See [LICENSE](LICENSE) for the full text.

Source: https://github.com/AleemHaider/trace-direct-tax-engine-service. A running instance also returns its source location, the engine commit and the engine build fingerprint at `GET /source`.

## Third-party component: dTax tax engine
- Package: `@dtax/tax-engine` (with `@dtax/shared-types`)
- Copyright (C) 2026 DTax Contributors
- Licence: GNU Affero General Public License v3.0
- Source: https://github.com/dTaxLab/dtax, commit `e2f58ad393ba4fd732ef08d1774575ef3284cbf9`
- **Used unmodified.** The build fetches that exact commit and checks every file against `engine/engine.lock.json` (167 files, SHA-256 manifest `a33424a41a753dde9a1c1ec05b673b3f7c47a0fc792a75c5c36066fe93969a3a`). The engine's own licence files are kept with it, unchanged.

The engine's name appears here only to attribute it, as its licence requires. This service is not affiliated with, endorsed by, or a product of dTax. The AGPL grants no trademark rights.

The engine's runtime dependencies (`decimal.js`, `pdfkit` and the packages they use) keep their own licences, which are shipped in the image under `build/engine/packages/tax-engine/node_modules/`.
