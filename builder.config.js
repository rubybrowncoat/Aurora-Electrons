const ICONS_DIR = 'build/icons/'

const windowsOS = {
  win: {
    icon: ICONS_DIR + 'win-icon.ico',
    publisherName: 'nerdship',
    target: 'portable',
  },

  nsis: {
    differentialPackage: true,
  },

  portable: {
    splashImage: 'splash.bmp',
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
  asar: false,
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
  ...windowsOS,
  ...linuxOS,
  ...macOS,
}
