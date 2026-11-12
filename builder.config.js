const fs = require('fs')
const path = require('path')

const ICONS_DIR = 'build/icons/'

const windowsOS = {
  win: {
    icon: ICONS_DIR + 'win-icon.ico',
    // Resource editing still runs; only project signing is delegated to the two explicit SignPath stages.
    signExecutable: false,
    signtoolOptions: {
      publisherName: 'nerdship',
    },
    target: 'portable',
  },

  nsis: {
    differentialPackage: true,
  },

  portable: {
    splashImage: 'splash.bmp',
    // Portable has no updater/elevation need. This path avoids adding elevate.exe to the prepackaged payload.
    useZip: true,
  },
}

const linuxOS = {
  linux: {
    icon: ICONS_DIR,
    target: 'deb',
  },
}

const macOS = {
  mac: {
    target: 'dmg',
    icon: ICONS_DIR + 'con.icns',
  },
  dmg: {
    contents: [
      {
        x: 410,
        y: 150,
        type: 'link',
        path: '/Applications',
      },
      {
        x: 130,
        y: 150,
        type: 'file',
      },
    ],
  },
}

module.exports = {
  // One archive instead of thousands of loose files: the portable exe extracts itself to a temp folder on every
  // launch, and that extraction was most of its startup time. Native binaries (sqlite3's) are unpacked beside it
  // into app.asar.unpacked, where Electron loads them from.
  asar: true,
  // sqlite3 ships an N-API prebuilt binary that Electron loads as is. A rebuild at packaging time replaces
  // node_modules/sqlite3's binary in place, and when another process has it loaded that leaves it missing.
  npmRebuild: false,
  productName: 'Aurora Electrons',
  appId: 'net.nerdship.aurora.electrons',
  // eslint-disable-next-line no-template-curly-in-string
  artifactName: 'aurora-electrons-${version}.${ext}',
  directories: {
    output: 'build',
  },
  // default files: https://www.electron.build/configuration/contents. The dependencies in package.json (the
  // modules electron-vite leaves external) are added on their own. out/smoke is the smoke test's build.
  files: [
    'package.json',
    'out/main/**',
    'out/preload/**',
    'out/renderer/**',
  ],
  extraResources: [
    { from: 'LICENSE', to: 'LICENSE' },
    { from: 'THIRD_PARTY_NOTICES.md', to: 'THIRD_PARTY_NOTICES.md' },
  ],
  afterPack: async (context) => {
    if (context.electronPlatformName !== 'win32') return
    // Use the same checksum-pinned toolset the installed builder uses for the wrapper.
    const { getMakeNsisPath } = require('app-builder-lib/out/toolsets/windows')
    const tool = await getMakeNsisPath(context.packager.config.toolsets?.nsis)
    const directory = tool.env?.NSISDIR || path.dirname(tool.path)
    fs.copyFileSync(path.join(directory, 'COPYING'), path.join(context.appOutDir, 'resources', 'LICENSE.nsis.txt'))
  },
  ...windowsOS,
  ...linuxOS,
  ...macOS,
}
