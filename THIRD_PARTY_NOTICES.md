# Third-party notices

Aurora Electrons is licensed under the MIT License (`LICENSE`, Copyright (c) 2020 rubybrowncoat). That licence covers the project's own code. It is not a grant over anything listed below, over the game Aurora, or over the community material in sections 8 and 9: each of those stays under the terms its authors gave it, and where those terms are not established this file says so and claims none.

## 1. What this file covers and how it was made

This file lists what the Windows portable package of Aurora Electrons contains or credits, and the notices that go with it. It was compiled on 2026-11-11 from `package.json`, `bun.lock` and `builder.config.js` at commit `f7f805dd830d30f97fc5ac44b893df06329eeab4` (package 3.2.2), from `src/renderer/utilities/credits.js`, and from the `app.asar` file list and Electron notice files of a local unsigned 3.2.2 build. Sections 3 and 4 were revised on 2026-11-12 against the Electron version `bun.lock` resolves and the installed electron-builder. The dependency graph is the locked one, so the list can name a package whose code a bundler left out; it is meant not to leave a shipped package out.

The 129 bundled libraries of section 6 and the 76 runtime packages of section 7 are counted from that local build, which predates the release pipeline. They are the starting evidence, not proof about any later package. The package inspection of the release pipeline (`scripts/package-smoke.js`) compares the runtime package names it finds in a built package with section 7 and checks the packaged notice files; a build whose package names are missing from this file fails it, and section 7 is then regenerated from the actual package. Until that check has run on a given build, this file is a best-effort list, not a promise of completeness.

## 2. Where the notices are in the package

| Notice | Location in the extracted package |
| --- | --- |
| This file and the project `LICENSE` | `resources/THIRD_PARTY_NOTICES.md`, `resources/LICENSE` |
| Electron's licence and the Chromium catalogue | `LICENSE.electron.txt` and `LICENSES.chromium.html`, beside `Aurora Electrons.exe` |
| The NSIS toolset licence | `resources/LICENSE.nsis.txt` |
| Every package inside `resources/app.asar` `node_modules` | the package's own `LICENSE`, `COPYING` or `NOTICE` file (section 7); `sqlite3` is unpacked to `resources/app.asar.unpacked/node_modules/sqlite3` |
| Roboto, Material Design Icons and the two MIT theme notices | the app: About, Credits (the texts are imported into the renderer by `src/renderer/utilities/credits.js`) |
| Libraries bundled into the app's scripts | section 6 and appendix A of this file |

## 3. Runtime: Electron and Chromium

Aurora Electrons runs on [Electron](https://www.electronjs.org/) (MIT; Copyright (c) Electron contributors and Copyright (c) 2013-2020 GitHub Inc.). `package.json` allows `^44.7.0`; `bun.lock` pins 44.9.1, which carries Chromium 152.0.7977.167 (Electron's `DEPS` at v44.9.1). Electron brings Chromium, V8, Node.js and other components. The package carries Electron's own notice files unchanged:

- `LICENSE.electron.txt`: Electron's MIT licence.
- `LICENSES.chromium.html`: the generated catalogue of Chromium's third-party components and their licences. In the local 3.2.2 build it names, among many others, FFmpeg (GNU LGPL 2.1), V8, Skia, ICU, SwiftShader, the Vulkan loader, zlib, Crashpad and Chromium's SQLite.

The files Electron ships beside the executable stay as Electron provides them: `ffmpeg.dll` (FFmpeg, a separate library file), `vk_swiftshader.dll`, `vulkan-1.dll`, `icudtl.dat`, the `.pak` files, `snapshot_blob.bin` and `v8_context_snapshot.bin`. `d3dcompiler_47.dll`, `dxcompiler.dll` and `dxil.dll` (Microsoft DirectX components) are also shipped by Electron; the local copy of `LICENSES.chromium.html` does not name them. They are described below, and this project has not established their notice set.

### Microsoft DirectX files

These three DLLs are Microsoft components that Electron's Windows distribution contains; this project does not build them and ships them as Electron provides them. What the sources show, as read on 2026-11-11 and 2026-11-12:

| File | Version resource in the Electron 44.9.1 copy | What the public sources say |
| --- | --- | --- |
| `d3dcompiler_47.dll` | Microsoft Corporation; Microsoft Windows Operating System; "Direct3D HLSL Compiler for Redistribution"; 10.0.26100.7705 | Named in Microsoft's Windows SDK redistributable lists (below). Chromium 152.0.7977.167 pins Windows SDK 10.0.26100.0 in `build/vs_toolchain.py`: a compatible identifier, not proof that this file came from that SDK package. |
| `dxcompiler.dll` | Microsoft Corporation; "DirectX Compiler - Google Dawn Custom Build"; 1.9.2607.0 | Named in the same lists. Chromium 152.0.7977.167 pins Dawn commit `ab8827bc57b176eeaa89f71324130c02d4d41145`, whose `DEPS` pins Microsoft's DirectXShaderCompiler commit `1f8a14aec4d4f2f25991fa9f7aad6c320fea91409`. |
| `dxil.dll` | Microsoft Corporation; "DirectX Compiler - Out Of Band"; 1.8.2502.11 | Named in the same lists. Chromium's packaging change [`ab0deff7f8ad`](https://chromium.googlesource.com/chromium/src/+/ab0deff7f8ad0a776b106baf1a7d2c3b54a9a540) says that, when Dawn builds its own compiler, `dxil.dll` is copied from the platform SDK. That change predates Chromium 152 and is not a byte-level match for this file. |

- **Microsoft's terms.** The [Windows SDK redistributable lists](https://learn.microsoft.com/en-us/legal/windows-sdk/redist) (updated 2024-10-21) name all three files under `Windows Kits\10\Redist\D3D\...` for redistribution with Classic Windows applications only, not Universal Windows apps, subject to the [Windows SDK licence terms](https://learn.microsoft.com/en-us/legal/windows-sdk/license) (section 2.a). As read, those terms require among other things unmodified redistribution, a validly licensed copy of the SDK, significant primary functionality in the application, distribution to the Microsoft OS platform only, the distributor's valid copyright notice, downstream terms that protect the files at least as much as the SDK licence does, and indemnification of Microsoft. This is a conditional permission, not an open-source licence. No licence such as MIT is assigned to these files here.
- **Dawn and DirectXShaderCompiler.** Dawn's `README.chromium` at the pinned commit declares Dawn's own code BSD-3-Clause; that does not make the Microsoft source, or `dxcompiler.dll`, a Dawn BSD file. Microsoft's DirectXShaderCompiler release tag `v1.8.2505` carries NCSA/LLVM and third-party terms that require copyright notices, conditions and disclaimers for binary redistribution, but that tag is comparison evidence, not the source of this DLL. Reading `LICENSE.TXT` and `ThirdPartyNotices.txt` at the pinned commit (`1f8a14ae...`) returned HTTP 404 on 2026-11-12, and no build manifest or hash tying this `dxcompiler.dll` to a particular DirectXShaderCompiler build was found.
- **Not established.** Which SDK redistributable package, and which licence text with it, supplied these exact copies (a hash comparison against an identified SDK package would settle that); the notice files that match the pinned compiler revision; the SDK package and hash behind `dxil.dll`; and whether the SignPath Foundation treats these files as system libraries (its terms point to section 1 of the GPL v3 for the definition), which is a question to the Foundation in `SIGNPATH_APPLICATION.md`.

This file lists the three files and the conditions above and claims no more. It does not promise that the notice set for them is complete, and the project has not removed or replaced them to avoid the question. Before signing is activated, the exact source of each copy and its notice set need to be identified and checked against the Foundation's and the provider's requirements.

## 4. Windows portable launcher

The portable `aurora-electrons-<version>.exe` is generated by [electron-builder](https://www.electron.build/) with the [NSIS](https://nsis.sourceforge.io/) toolset it downloads. NSIS's `COPYING` file ships as `resources/LICENSE.nsis.txt`. It states that NSIS's code, plug-ins and examples are under the zlib/libpng licence, the bzip2 compression module under the bzip2 licence, and the LZMA compression module under the Common Public License 1.0. `builder.config.js` sets the portable target to `useZip`; in the installed electron-builder (26.15.3) that takes the path that does not add electron-builder's separate `elevate.exe` installer helper to the package. The package inspection rejects that file and also starts the final wrapper, but until it has run on a given build its absence is intended, not shown. The origin and licence of `elevate.exe` were not established, and this file makes no claim about it.

## 5. SQLite and the sqlite3 module

Saves are read with the [`sqlite3`](https://github.com/TryGhost/node-sqlite3) Node module 6.0.1 (BSD-3-Clause, Copyright (c) 2013-2026 Mapbox & Ghost Foundation), loaded with its prebuilt native binding from `resources/app.asar.unpacked/node_modules/sqlite3`, next to its `LICENSE`. The module compiles SQLite amalgamation 3520000 (3.52.0) into that binding (`deps/common-sqlite.gypi`). [SQLite](https://www.sqlite.org/copyright.html) is in the public domain. [Sequelize](https://sequelize.org/) 6.37.8 (MIT) sits on top of it; both are in section 7.

## 6. Libraries bundled into the app's scripts

`electron-vite` bundles the packages the code imports into `out/main`, `out/preload` and `out/renderer`, which are packed into `app.asar`. The directly imported ones are marked in the last column; the rest are their locked runtime dependencies. Left out: packages that only carry type definitions (`@types/earcut`, `@types/offscreencanvas`) and the Sentry build-tool dependencies (`@sentry/bundler-plugins` and what only it installs), none of which appears in the local 3.2.2 build's `out/` files. A bundled library's licence file does not travel with the bundled code, so its notice is given here: the copyright line is the one in the package's licence file, and the licence text is in appendix A (MIT unless the Licence column says otherwise).

| Package | Version | Licence | Copyright notice in the package | Direct |
| --- | --- | --- | --- | --- |
| `@kurkle/color` | 0.3.4 | MIT | `Copyright (c) 2018-2024 Jukka Kurkela` |  |
| `@opentelemetry/api` | 1.9.1 | Apache-2.0 | No copyright line in the licence file; the licence text below is the one the package ships |  |
| `@pixi/accessibility` | 6.5.10 | MIT | `Copyright (c) 2013-2018 Mathew Groves, Chad Engler` |  |
| `@pixi/app` | 6.5.10 | MIT | `Copyright (c) 2013-2018 Mathew Groves, Chad Engler` |  |
| `@pixi/compressed-textures` | 6.5.10 | MIT | `Copyright (c) 2013-2017 Mathew Groves, Chad Engler` |  |
| `@pixi/constants` | 6.5.10 | MIT | `Copyright (c) 2013-2018 Mathew Groves, Chad Engler` |  |
| `@pixi/core` | 6.5.10 | MIT | `Copyright (c) 2013-2018 Mathew Groves, Chad Engler` |  |
| `@pixi/display` | 6.5.10 | MIT | `Copyright (c) 2013-2018 Mathew Groves, Chad Engler` |  |
| `@pixi/extensions` | 6.5.10 | MIT | `Copyright (c) 2022 Matt Karl` |  |
| `@pixi/extract` | 6.5.10 | MIT | `Copyright (c) 2013-2018 Mathew Groves, Chad Engler` |  |
| `@pixi/filter-alpha` | 6.5.10 | MIT | `Copyright (c) 2013-2018 Mathew Groves, Chad Engler` |  |
| `@pixi/filter-blur` | 6.5.10 | MIT | `Copyright (c) 2013-2018 Mathew Groves, Chad Engler` |  |
| `@pixi/filter-color-matrix` | 6.5.10 | MIT | `Copyright (c) 2013-2018 Mathew Groves, Chad Engler` |  |
| `@pixi/filter-displacement` | 6.5.10 | MIT | `Copyright (c) 2013-2018 Mathew Groves, Chad Engler` |  |
| `@pixi/filter-fxaa` | 6.5.10 | MIT | `Copyright (c) 2013-2018 Mathew Groves, Chad Engler` |  |
| `@pixi/filter-noise` | 6.5.10 | MIT | `Copyright (c) 2013-2018 Mathew Groves, Chad Engler` |  |
| `@pixi/graphics` | 6.5.10 | MIT | `Copyright (c) 2013-2018 Mathew Groves, Chad Engler` |  |
| `@pixi/interaction` | 6.5.10 | MIT | `Copyright (c) 2013-2018 Mathew Groves, Chad Engler` |  |
| `@pixi/loaders` | 6.5.10 | MIT | `Copyright (c) 2013-2018 Mathew Groves, Chad Engler` |  |
| `@pixi/math` | 6.5.10 | MIT | `Copyright (c) 2013-2018 Mathew Groves, Chad Engler` |  |
| `@pixi/mesh` | 6.5.10 | MIT | `Copyright (c) 2013-2018 Mathew Groves, Chad Engler` |  |
| `@pixi/mesh-extras` | 6.5.10 | MIT | `Copyright (c) 2013-2018 Mathew Groves, Chad Engler` |  |
| `@pixi/mixin-cache-as-bitmap` | 6.5.10 | MIT | `Copyright (c) 2013-2018 Mathew Groves, Chad Engler` |  |
| `@pixi/mixin-get-child-by-name` | 6.5.10 | MIT | `Copyright (c) 2013-2018 Mathew Groves, Chad Engler` |  |
| `@pixi/mixin-get-global-position` | 6.5.10 | MIT | `Copyright (c) 2013-2018 Mathew Groves, Chad Engler` |  |
| `@pixi/particle-container` | 6.5.10 | MIT | `Copyright (c) 2013-2018 Mathew Groves, Chad Engler` |  |
| `@pixi/polyfill` | 6.5.10 | MIT | `Copyright (c) 2013-2018 Mathew Groves, Chad Engler` |  |
| `@pixi/prepare` | 6.5.10 | MIT | `Copyright (c) 2013-2018 Mathew Groves, Chad Engler` |  |
| `@pixi/runner` | 6.5.10 | MIT | `Copyright (c) 2013-2017 Mathew Groves, Chad Engler` |  |
| `@pixi/settings` | 6.5.10 | MIT | `Copyright (c) 2013-2018 Mathew Groves, Chad Engler` |  |
| `@pixi/sprite` | 6.5.10 | MIT | `Copyright (c) 2013-2018 Mathew Groves, Chad Engler` |  |
| `@pixi/sprite-animated` | 6.5.10 | MIT | `Copyright (c) 2013-2018 Mathew Groves, Chad Engler` |  |
| `@pixi/sprite-tiling` | 6.5.10 | MIT | `Copyright (c) 2013-2018 Mathew Groves, Chad Engler` |  |
| `@pixi/spritesheet` | 6.5.10 | MIT | `Copyright (c) 2013-2018 Mathew Groves, Chad Engler` |  |
| `@pixi/text` | 6.5.10 | MIT | `Copyright (c) 2013-2018 Mathew Groves, Chad Engler` |  |
| `@pixi/text-bitmap` | 6.5.10 | MIT | `Copyright (c) 2013-2018 Mathew Groves, Chad Engler` |  |
| `@pixi/ticker` | 6.5.10 | MIT | `Copyright (c) 2013-2018 Mathew Groves, Chad Engler` |  |
| `@pixi/utils` | 6.5.10 | MIT | `Copyright (c) 2013-2018 Mathew Groves, Chad Engler` |  |
| `@sentry/browser` | 11.4.0 | MIT | `Copyright (c) 2019 Functional Software, Inc. dba Sentry` |  |
| `@sentry/browser-utils` | 11.4.0 | MIT | `Copyright (c) 2020 Functional Software, Inc. dba Sentry` |  |
| `@sentry/conventions` | 0.23.0 | MIT | `Copyright (c) 2023-2025 Functional Software, Inc. dba Sentry` |  |
| `@sentry/conventions` | 0.25.0 | MIT | `Copyright (c) 2023-2025 Functional Software, Inc. dba Sentry` |  |
| `@sentry/core` | 11.4.0 | MIT | `Copyright (c) 2019 Functional Software, Inc. dba Sentry` |  |
| `@sentry/electron` | 8.1.0 | MIT | `Copyright (c) 2018 Functional Software, Inc. dba Sentry / Copyright (c) 2017 Tim Fish` | yes |
| `@sentry/feedback` | 11.4.0 | MIT | `Copyright (c) 2023 Functional Software, Inc. dba Sentry` |  |
| `@sentry/node` | 11.4.0 | MIT | `Copyright (c) 2023 Functional Software, Inc. dba Sentry` |  |
| `@sentry/opentelemetry` | 11.4.0 | MIT | `Copyright (c) 2023 Functional Software, Inc. dba Sentry` |  |
| `@sentry/replay` | 11.4.0 | MIT | `Copyright (c) 2022 Functional Software, Inc. dba Sentry` |  |
| `@sentry/replay-canvas` | 11.4.0 | MIT | `Copyright (c) 2024 Functional Software, Inc. dba Sentry` |  |
| `@sentry/server-runtime-injection` | 11.4.0 | MIT | No licence file in the package (package.json declares MIT); part of the getsentry/sentry-javascript repository, whose packages are Copyright (c) Functional Software, Inc. dba Sentry |  |
| `@sentry/server-utils` | 11.4.0 | MIT | No licence file in the package (package.json declares MIT); part of the getsentry/sentry-javascript repository, whose packages are Copyright (c) Functional Software, Inc. dba Sentry |  |
| `@sentry/vue` | 11.4.0 | MIT | `Copyright (c) 2019 Functional Software, Inc. dba Sentry` | yes |
| `@timohausmann/quadtree-js` | 1.2.6 | MIT | `Copyright (c) 2012-2022 Timo Hausmann` | yes |
| `ajv` | 8.18.0 | MIT | `Copyright (c) 2015-2021 Evgeny Poberezkin` |  |
| `ajv` | 8.20.0 | MIT | `Copyright (c) 2015-2021 Evgeny Poberezkin` |  |
| `ajv-formats` | 3.0.1 | MIT | `Copyright (c) 2020 Evgeny Poberezkin` |  |
| `atomically` | 2.1.1 | MIT | `Copyright (c) 2020-present Fabio Spampinato` |  |
| `call-bind-apply-helpers` | 1.0.2 | MIT | `Copyright (c) 2024 Jordan Harband` |  |
| `call-bound` | 1.0.4 | MIT | `Copyright (c) 2024 Jordan Harband` |  |
| `chart.js` | 4.5.1 | MIT | `Copyright (c) 2014-2024 Chart.js Contributors` | yes |
| `chokidar` | 4.0.3 | MIT | `Copyright (c) 2012 Paul Miller (https://paulmillr.com), Elan Shanker` | yes |
| `color-hash` | 2.0.2 | MIT | `Copyright (c) 2015-2021 Zeno Zeng` | yes |
| `conf` | 15.1.0 | MIT | `Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com)` |  |
| `cose-base` | 2.2.0 | MIT | `Copyright (c) 2019 - present, iVis@Bilkent.` |  |
| `cytoscape` | 3.34.3 | MIT | `Copyright (c) 2016-2026, The Cytoscape Consortium.` | yes |
| `cytoscape-cola` | 2.5.1 | MIT | `Copyright (c) 2016-2018, 2020-2021, The Cytoscape Consortium.` | yes |
| `cytoscape-cxtmenu` | 3.5.0 | MIT | `Copyright (c) 2016-2021, 2023, The Cytoscape Consortium.` | yes |
| `cytoscape-fcose` | 2.2.0 | MIT | `Copyright (c) 2018 - present, iVis-at-Bilkent.` | yes |
| `d3-color` | 3.1.0 | ISC | `Copyright 2010-2022 Mike Bostock` | yes |
| `d3-dispatch` | 1.0.6 | BSD-3-Clause | `Copyright 2010-2016 Mike Bostock` |  |
| `d3-drag` | 1.2.5 | BSD-3-Clause | `Copyright 2010-2016 Mike Bostock` |  |
| `d3-path` | 1.0.9 | BSD-3-Clause | `Copyright 2015-2016 Mike Bostock` |  |
| `d3-selection` | 1.4.2 | BSD-3-Clause | `Copyright (c) 2010-2018, Michael Bostock` |  |
| `d3-shape` | 1.3.7 | BSD-3-Clause | `Copyright 2010-2015 Mike Bostock` |  |
| `d3-timer` | 1.0.10 | BSD-3-Clause | `Copyright 2010-2016 Mike Bostock` |  |
| `dayjs` | 1.11.23 | MIT | `Copyright (c) 2018-present, iamkun` | yes |
| `debounce-fn` | 6.0.0 | MIT | `Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com)` |  |
| `dot-prop` | 10.2.0 | MIT | `Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com)` |  |
| `dunder-proto` | 1.0.1 | MIT | `Copyright (c) 2024 ECMAScript Shims` |  |
| `earcut` | 2.2.4 | ISC | `Copyright (c) 2016, Mapbox` |  |
| `electron-store` | 11.0.2 | MIT | `Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com)` | yes |
| `env-paths` | 2.2.1 | MIT | `Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com)` | yes |
| `env-paths` | 3.0.0 | MIT | `Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com)` |  |
| `es-define-property` | 1.0.1 | MIT | `Copyright (c) 2024 Jordan Harband` |  |
| `es-errors` | 1.3.0 | MIT | `Copyright (c) 2024 Jordan Harband` |  |
| `es-object-atoms` | 1.1.1 | MIT | `Copyright (c) 2024 Jordan Harband` |  |
| `eventemitter3` | 3.1.2 | MIT | `Copyright (c) 2014 Arnout Kazemier` |  |
| `fast-deep-equal` | 3.1.3 | MIT | `Copyright (c) 2017 Evgeny Poberezkin` |  |
| `fast-uri` | 3.1.9 | BSD-3-Clause | `Copyright (c) 2011-2021, Gary Court until https://github.com/garycourt/uri-js/commit/a1acf730b4bba3f1097c9f52e7d9d3aba8cdcaae / Copyright (c) 2021-present The Fastify team <https://github.com/fastify/fastify#team>` |  |
| `function-bind` | 1.1.2 | MIT | `Copyright (c) 2013 Raynos.` |  |
| `get-intrinsic` | 1.3.0 | MIT | `Copyright (c) 2020 Jordan Harband` |  |
| `get-proto` | 1.0.1 | MIT | `Copyright (c) 2025 Jordan Harband` |  |
| `gopd` | 1.2.0 | MIT | `Copyright (c) 2022 Jordan Harband` |  |
| `has-symbols` | 1.1.0 | MIT | `Copyright (c) 2016 Jordan Harband` |  |
| `hasown` | 2.0.2 | MIT | `Copyright (c) Jordan Harband and contributors` |  |
| `json-schema-traverse` | 1.0.0 | MIT | `Copyright (c) 2017 Evgeny Poberezkin` |  |
| `json-schema-typed` | 8.0.2 | BSD-2-Clause | Original source code is copyright (c) 2019-2025 Remy Rylan <https://github.com/RemyRylan>; JSON Schema documentation copyright (c) IETF Trust and the other holders named in the licence text below |  |
| `layout-base` | 2.0.1 | MIT | `Copyright (c) 2019 iVis@Bilkent` |  |
| `lodash` | 4.18.1 | MIT | `Copyright OpenJS Foundation and other contributors <https://openjsf.org/> / Based on Underscore.js, copyright Jeremy Ashkenas, DocumentCloud and Investigative Reporters & Editors <http://underscorejs.org/>` | yes |
| `math-intrinsics` | 1.1.0 | MIT | `Copyright (c) 2024 ECMAScript Shims` |  |
| `mimic-function` | 5.0.1 | MIT | `Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com)` |  |
| `object-assign` | 4.1.1 | MIT | `Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com)` |  |
| `object-inspect` | 1.13.4 | MIT | `Copyright (c) 2013 James Halliday` |  |
| `pixi-viewport` | 4.38.0 | MIT | `Copyright (c) 2017 YOPEY YOPEY LLC` | yes |
| `pixi.js` | 6.5.10 | MIT | `Copyright (c) 2013-2017 Mathew Groves, Chad Engler` | yes |
| `promise-polyfill` | 8.3.0 | MIT | `Copyright (c) 2014 Taylor Hakes / Copyright (c) 2014 Forbes Lindesay` |  |
| `punycode` | 1.4.1 | MIT | `Copyright Mathias Bynens <https://mathiasbynens.be/>` |  |
| `qs` | 6.16.1 | BSD-3-Clause | `Copyright (c) 2014, Nathan LaFreniere and other [contributors](https://github.com/ljharb/qs/graphs/contributors)` |  |
| `readdirp` | 4.1.2 | MIT | `Copyright (c) 2012-2019 Thorsten Lorenz, Paul Miller (https://paulmillr.com)` |  |
| `require-from-string` | 2.0.2 | MIT | `Copyright (c) Vsevolod Strukchinsky <floatdrop@gmail.com> (github.com/floatdrop)` |  |
| `romanum` | 1.0.1 | MIT | Copyright (c) 2018 (the licence file names no holder; repository holtalanm/roman-num) | yes |
| `semver` | 7.8.5 | ISC | `Copyright (c) Isaac Z. Schlueter and Contributors` |  |
| `side-channel` | 1.1.1 | MIT | `Copyright (c) 2019 Jordan Harband` |  |
| `side-channel-list` | 1.0.1 | MIT | `Copyright (c) 2024 Jordan Harband` |  |
| `side-channel-map` | 1.0.1 | MIT | `Copyright (c) 2024 Jordan Harband` |  |
| `side-channel-weakmap` | 1.0.2 | MIT | `Copyright (c) 2019 Jordan Harband` |  |
| `stubborn-fs` | 2.0.0 | MIT | `Copyright (c) 2022-present Fabio Spampinato` |  |
| `stubborn-utils` | 1.0.2 | MIT | `Copyright (c) 2025-present Fabio Spampinato` |  |
| `tagged-tag` | 1.0.0 | MIT | `Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com)` |  |
| `type-fest` | 5.10.0 | MIT OR CC0-1.0 (used here under MIT) | `Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com)` |  |
| `uint8array-extras` | 1.6.0 | MIT | `Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com)` |  |
| `url` | 0.11.4 | MIT | `Copyright 2014 Joyent, Inc. and other Node contributors.` |  |
| `vue` | 2.7.16 | MIT | `Copyright (c) 2013-present, Yuxi (Evan) You` | yes |
| `vue-async-computed` | 4.0.1 | MIT | `Copyright (c) 2016-2020 Benjamin Fox <foxbenjaminfox@gmail.com>` | yes |
| `vue-router` | 3.6.5 | MIT | `Copyright (c) 2013-present Evan You` | yes |
| `vuetify` | 2.7.2 | MIT | `Copyright (c) 2016-2022 John Jeremy Leider` | yes |
| `vuex` | 3.6.2 | MIT | `Copyright (c) 2015-present Evan You` | yes |
| `webcola` | 3.4.0 | MIT | `Copyright (c) 2013 Tim Dwyer` |  |
| `when-exit` | 2.1.5 | MIT | `Copyright (c) 2022-present Fabio Spampinato` |  |

Note: `type-fest` is offered under MIT OR CC0-1.0 and used under MIT. The `@sentry/*` packages implement the opt-in error reporting described in `PRIVACY.md`.

## 7. Runtime packages inside `app.asar`

These packages are loaded from `node_modules` inside `resources/app.asar` at run time (`sequelize`, `sqlite3` and what they install, plus tooling packages the builder collected in the local 3.2.2 build). They ship with their own licence files. The list below was taken from that local build's `app.asar` and names its 76 packages with the licence each declares. It is the starting list, not proof about a later package: the package inspection compares the names it finds in the packaged `node_modules` with the entries below, and the section is regenerated if they differ.

- **MIT** (53): `@types/debug` 4.1.12, `@types/ms` 2.1.0, `@types/node` 14.14.9, `@types/validator` 13.15.3, `base64-js` 1.5.1, `bindings` 1.5.0, `bl` 4.1.0, `buffer` 5.7.1, `debug` 4.4.3, `decompress-response` 6.0.0, `deep-extend` 0.6.0, `dottie` 2.0.7, `end-of-stream` 1.4.5, `env-paths` 2.2.1, `fdir` 6.5.0, `file-uri-to-path` 1.0.0, `fs-constants` 1.0.0, `github-from-package` 0.0.0, `inflection` 1.13.4, `lodash` 4.18.1, `mimic-response` 3.1.0, `minimist` 1.2.8, `minizlib` 3.1.0, `mkdirp-classic` 0.5.3, `moment` 2.31.0, `moment-timezone` 0.5.48, `ms` 2.1.3, `napi-build-utils` 2.0.0, `node-abi` 3.98.0, `node-addon-api` 8.9.2, `node-gyp` 12.4.0, `pg-connection-string` 2.9.1, `picomatch` 4.0.7, `prebuild-install` 7.1.3, `pump` 3.0.3, `readable-stream` 3.6.2, `retry-as-promised` 7.1.1, `safe-buffer` 5.2.1, `sequelize` 6.37.8, `sequelize-pool` 7.1.0, `simple-concat` 1.0.1, `simple-get` 4.0.1, `string_decoder` 1.3.0, `strip-json-comments` 2.0.1, `tar-fs` 2.1.5, `tar-stream` 2.2.0, `tinyglobby` 0.2.17, `toposort-class` 1.0.1, `undici` 6.29.1, `util-deprecate` 1.0.2, `uuid` 11.1.1, `validator` 13.15.22, `wkx` 0.5.0
- **ISC** (12): `@isaacs/fs-minipass` 4.0.1, `abbrev` 4.0.0, `chownr` 1.1.4, `graceful-fs` 4.2.11, `inherits` 2.0.4, `ini` 1.3.8, `nopt` 9.0.0, `once` 1.4.0, `proc-log` 6.1.0, `semver` 7.7.2, `which` 6.0.1, `wrappy` 1.0.2
- **BlueOak-1.0.0** (4): `isexe` 4.0.0, `minipass` 7.1.3, `tar` 7.5.22, `yallist` 5.0.0
- **Apache-2.0** (3): `detect-libc` 2.1.1, `exponential-backoff` 3.1.3, `tunnel-agent` 0.6.0
- **BSD-3-Clause** (2): `ieee754` 1.2.1, `sqlite3` 6.0.1
- **(MIT OR WTFPL)** (1): `expand-template` 2.0.3
- **(BSD-2-Clause OR MIT OR Apache-2.0)** (1): `rc` 1.2.8

## 8. Fonts, icons and colour references

| Asset | Used as | Terms |
| --- | --- | --- |
| Roboto and Roboto Condensed, from `roboto-fontface` 0.10.0 (Christian Robertson for Google; packaged by Christian Hoffmeister) | Bundled font files, unmodified (the build only renames them with a content hash) | Apache License 2.0 (appendix A; also shown in About, Credits) |
| Material Design Icons, from `@mdi/font` 7.4.47 (Pictogrammers) | Bundled icon font and stylesheet, unmodified | Pictogrammers Free License: icons and fonts under Apache 2.0, code (the stylesheet) under MIT (appendix A) |
| Solaris theme, Simas Toleikis, <https://github.com/simast/SolarisTheme> (MIT, Copyright (c) 2021 Simas Toleikis) | Visual inspiration only: colour values for the Aurora Classic and Solaris inspired presets. No code, image, icon or font is copied or bundled. | MIT, shown in About for provenance |
| T2D theme, Aurora-Modders, <https://github.com/Aurora-Modders/T2DTheme> (MIT, Copyright (c) 2021 Aurora-Modders) | Visual inspiration only: colour values for the T2D inspired preset. Nothing else of the theme is copied or bundled. | MIT, shown in About for provenance |
| DeepBlue theme, Jorgen_CAB (after the Solaris theme) | Visual inspiration only: colour values for the DeepBlue inspired preset. | The archive keeps the Solaris theme's MIT notice and states no licence of its own for the colours it added. **No licence is claimed for those colours.** |
| Cristotheme, CountCristo (after the Solaris and DeepBlue themes) | Visual inspiration only: colour values for the Cristo inspired preset. | The repository keeps the Solaris theme's MIT notice and states no licence of its own for the colours it added. **No licence is claimed for those colours.** |

The two MIT theme notices are in `src/renderer/utilities/notices/`. Colour values are not text or code; the presets adapt them with surfaces, text, selection and state colours of their own, and Settings lists each preset's changes.

## 9. What this file does not cover

- **The game.** Aurora is by Steve Walmsley; Aurora Electrons is an unofficial companion, and no permission or endorsement from the game's author is claimed. The game's flags, portraits and saves are read from the player's own installation and are not shipped.
- **The sample save `fixtures/AuroraDB.zip`** is game data (a United Earth Federation campaign saved in 2102). It is tracked in the repository for development, is excluded from release packages, and no licence is stated for it here; the project `LICENSE` is not a grant over it. Whether it affects eligibility for the SignPath Foundation programme is an open question (`SIGNPATH_APPLICATION.md`).
- **Community reference material** under `references/aurcalcs` and `references/queries` (the `Aur_Calcs260.xlsx` workbook and a collection of SQL scripts by the community author skoormit). The maintainer reports the author's permission to share them with this project. No licence text accompanies them and none is assigned here. They are development references, not shipped, and are kept as local, git-ignored files (see `README.md`).

## Appendix A: licence texts

The Licence column of section 6 says which text applies. Where a package's licence file holds more than one licence, the one named in that column is the one relied on.

### MIT License

Copyright (c) the holder named for each package in section 6 (and, for section 7, in each package's own licence file).

```text
Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

Lodash additionally carries the notice "Based on Underscore.js, copyright Jeremy Ashkenas, DocumentCloud and Investigative Reporters & Editors <http://underscorejs.org/>", quoted in its row above.

### ISC License

`d3-color`, `earcut`, `semver`. [Copyright notice: as listed for each package in section 6]

```text
Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
```

### BSD 3-Clause License, as shipped with `d3-dispatch`, `d3-drag`, `d3-path`, `d3-shape` and `d3-timer`

[Copyright notice: as listed for each package in section 6]

```text
All rights reserved.

Redistribution and use in source and binary forms, with or without modification,
are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.

* Neither the name of the author nor the names of contributors may be used to
  endorse or promote products derived from this software without specific prior
  written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### BSD 3-Clause License, as shipped with `d3-selection`

[Copyright notice: as listed for each package in section 6]

```text
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.

* The name Michael Bostock may not be used to endorse or promote products
  derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL MICHAEL BOSTOCK BE LIABLE FOR ANY DIRECT,
INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING,
BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY
OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE,
EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### BSD 3-Clause License, as shipped with `qs`

[Copyright notice: as listed for each package in section 6]

```text
BSD 3-Clause License

All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### BSD 3-Clause-style licence, as shipped with `fast-uri`

[Copyright notice: as listed for each package in section 6] The package's licence file ends with a pointer to its contributor list at <https://github.com/garycourt/uri-js/graphs/contributors>.

```text
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:
    * Redistributions of source code must retain the above copyright
      notice, this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above copyright
      notice, this list of conditions and the following disclaimer in the
      documentation and/or other materials provided with the distribution.
    * The names of any contributors may not be used to endorse or promote
      products derived from this software without specific prior written
      permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDERS AND CONTRIBUTORS BE LIABLE FOR ANY
DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

                                  *   *   *

The complete list of contributors can be found at:
- https://github.com/garycourt/uri-js/graphs/contributors
```

### BSD 2-Clause License, as shipped with `json-schema-typed`

```text
BSD 2-Clause License

Original source code is copyright (c) 2019-2025 Remy Rylan
<https://github.com/RemyRylan>

All JSON Schema documentation and descriptions are copyright (c):

2009 [draft-0] IETF Trust <https://www.ietf.org/>, Kris Zyp <kris@sitepen.com>,
and SitePen (USA) <https://www.sitepen.com/>.

2009 [draft-1] IETF Trust <https://www.ietf.org/>, Kris Zyp <kris@sitepen.com>,
and SitePen (USA) <https://www.sitepen.com/>.

2010 [draft-2] IETF Trust <https://www.ietf.org/>, Kris Zyp <kris@sitepen.com>,
and SitePen (USA) <https://www.sitepen.com/>.

2010 [draft-3] IETF Trust <https://www.ietf.org/>, Kris Zyp <kris@sitepen.com>,
Gary Court <gary.court@gmail.com>, and SitePen (USA) <https://www.sitepen.com/>.

2013 [draft-4] IETF Trust <https://www.ietf.org/>), Francis Galiegue
<fgaliegue@gmail.com>, Kris Zyp <kris@sitepen.com>, Gary Court
<gary.court@gmail.com>, and SitePen (USA) <https://www.sitepen.com/>.

2018 [draft-7] IETF Trust <https://www.ietf.org/>, Austin Wright <aaa@bzfx.net>,
Henry Andrews <henry@cloudflare.com>, Geraint Luff <luffgd@gmail.com>, and
Cloudflare, Inc. <https://www.cloudflare.com/>.

2019 [draft-2019-09] IETF Trust <https://www.ietf.org/>, Austin Wright
<aaa@bzfx.net>, Henry Andrews <andrews_henry@yahoo.com>, Ben Hutton
<bh7@sanger.ac.uk>, and Greg Dennis <gregsdennis@yahoo.com>.

2020 [draft-2020-12] IETF Trust <https://www.ietf.org/>, Austin Wright
<aaa@bzfx.net>, Henry Andrews <andrews_henry@yahoo.com>, Ben Hutton
<ben@jsonschema.dev>, and Greg Dennis <gregsdennis@yahoo.com>.

All rights reserved.

Redistribution and use in source and binary forms, with or without modification,
are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### Apache License 2.0, as shipped with `@opentelemetry/api`

The same licence covers Roboto (`roboto-fontface`) and the Material Design Icons icons and fonts (the appendix text below is the standard text, unmodified).

```text
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

### Pictogrammers Free License, as shipped with `@mdi/font`

```text
Pictogrammers Free License
--------------------------

This icon collection is released as free, open source, and GPL friendly by
the [Pictogrammers](http://pictogrammers.com/) icon group. You may use it
for commercial projects, open source projects, or anything really.

# Icons: Apache 2.0 (https://www.apache.org/licenses/LICENSE-2.0)
Some of the icons are redistributed under the Apache 2.0 license. All other
icons are either redistributed under their respective licenses or are
distributed under the Apache 2.0 license.

# Fonts: Apache 2.0 (https://www.apache.org/licenses/LICENSE-2.0)
All web and desktop fonts are distributed under the Apache 2.0 license. Web
and desktop fonts contain some icons that are redistributed under the Apache
2.0 license. All other icons are either redistributed under their respective
licenses or are distributed under the Apache 2.0 license.

# Code: MIT (https://opensource.org/licenses/MIT)
The MIT license applies to all non-font and non-icon files.
```
