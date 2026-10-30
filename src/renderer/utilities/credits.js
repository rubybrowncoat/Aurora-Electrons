// The third-party material the app credits, one entry per source: what it covers, who made it, where it comes from, its terms, what was changed and the notices those terms ask for, and how it is used (`reuse`: `Bundled files` are shipped as they are, `Visual inspiration` is not copied at all, only learned from). The About page lists them and shows each notice. The notice texts are imported here, so they are bundled into the renderer and every packaged build carries them. Code libraries keep their licenses in their own packages; About lists them under Built with. An asset whose reuse terms aren't established is not shipped and has no entry. An entry may also carry `compatibility`, what the source offers beside its look and the app leaves out (`title`, `status`, `text`), which About shows apart from the colours.

import mdiLicense from '@mdi/font/LICENSE?raw'
import { version as mdiVersion } from '@mdi/font/package.json'
import apacheLicense from 'roboto-fontface/LICENSE?raw'
import { version as robotoVersion } from 'roboto-fontface/package.json'
import { resolveAppearance } from './appearance'
import solarisLicense from './notices/solaris-theme-license.txt?raw'
import t2dLicense from './notices/t2d-theme-license.txt?raw'

const APACHE = { title: 'Apache License 2.0', text: apacheLicense }

// The community themes the colour presets take their reference colours from (the Aurora Classic and Solaris inspired presets from the first, the DeepBlue inspired preset from the second, the T2D inspired preset from the third, the Cristo inspired preset from the fourth); the provenance is each preset's own metadata, so an entry and its preset cannot differ.
const { source: SOLARIS } = resolveAppearance('solaris').reference
const { source: DEEPBLUE } = resolveAppearance('deepblue').reference
const { source: T2D } = resolveAppearance('t2d').reference
const { source: CRISTO, compatibility: CRISTO_COMPATIBILITY } = resolveAppearance('cristo').reference
const BUNDLED = { kind: 'Bundled files', detail: 'The files ship inside the app.' }

export const CREDITS = [
  {
    id: 'roboto',
    name: 'Roboto',
    kind: 'Font',
    covers: 'Provides the bundled Roboto and Roboto Condensed interface fonts.',
    reuse: BUNDLED,
    author: 'Christian Robertson for Google; packaged by Christian Hoffmeister',
    source: { label: `roboto-fontface ${robotoVersion}`, href: 'https://github.com/choffmeister/roboto-fontface-bower' },
    license: { label: 'Apache License 2.0', href: 'https://www.apache.org/licenses/LICENSE-2.0' },
    modifications: 'None. The files ship as published; the build only renames them with a content hash.',
    notices: [APACHE],
  },
  {
    id: 'mdi',
    name: 'Material Design Icons',
    kind: 'Icons',
    covers: 'Provides the interface icons and their stylesheet.',
    reuse: BUNDLED,
    author: 'Pictogrammers (Austin Andrews and contributors)',
    source: { label: `@mdi/font ${mdiVersion}`, href: 'https://github.com/Templarian/MaterialDesign-Webfont' },
    license: { label: 'Pictogrammers Free License: icons and fonts under the Apache License 2.0, the stylesheet under MIT', href: 'https://pictogrammers.com/docs/general/license/' },
    modifications: 'None. The files ship as published; the build only renames them with a content hash.',
    notices: [{ title: 'Pictogrammers Free License', text: mdiLicense }, APACHE],
  },
  {
    id: 'solaris-theme',
    name: SOLARIS.name,
    kind: 'Colour reference',
    covers: 'Provides colour references for the Aurora Classic and Solaris inspired presets.',
    reuse: { kind: 'Visual inspiration', detail: SOLARIS.copied },
    author: SOLARIS.author,
    source: { label: `SolarisTheme ${SOLARIS.revision.slice(0, 7)}, ${SOLARIS.revisionDate}`, href: `${SOLARIS.repository}/tree/${SOLARIS.revision}` },
    license: { label: SOLARIS.license, href: `${SOLARIS.repository}/blob/${SOLARIS.revision}/LICENSE` },
    modifications: 'The two presets adapt the reference colours with surfaces, text, selection and state colours of their own; Settings lists each preset\'s changes.',
    notices: [{ title: 'MIT License (Solaris theme)', text: solarisLicense }],
  },
  {
    id: 'deepblue-theme',
    name: DEEPBLUE.name,
    kind: 'Colour reference',
    covers: 'Provides the colour reference for the DeepBlue inspired preset.',
    reuse: { kind: 'Visual inspiration', detail: DEEPBLUE.copied },
    author: DEEPBLUE.author,
    source: { label: `DeepBlue theme archive ${DEEPBLUE.revision.slice(0, 7)}, ${DEEPBLUE.revisionDate}`, href: 'https://web.archive.org/web/20240106201103/http://aurora2.pentarch.org/index.php?topic=12593.0' },
    license: { label: DEEPBLUE.license, href: 'https://github.com/CountCristo/Cristotheme/blob/4b30899b984c1dd1bb75d2bd7c17a994a1227bdb/Unaltered%20base%20files/Deepblue/Resource/LICENSE' },
    modifications: 'The preset adapts the reference colours with surfaces, text, selection and state colours of its own, a lighter green in place of the planet green and lighter chart colours; Settings lists its changes. No license covers the colours that DeepBlue added to the Solaris theme, and none is claimed: the notice is the one the archive keeps.',
    notices: [{ title: 'MIT License (Solaris theme, kept in the DeepBlue theme)', text: solarisLicense }],
  },
  {
    id: 't2d-theme',
    name: T2D.name,
    kind: 'Colour reference',
    covers: 'Provides the black, white and grey colour reference for the T2D inspired preset.',
    reuse: { kind: 'Visual inspiration', detail: T2D.copied },
    author: T2D.author,
    source: { label: `T2DTheme ${T2D.revision.slice(0, 7)}, ${T2D.revisionDate}`, href: `${T2D.repository}/tree/${T2D.revision}` },
    license: { label: T2D.license, href: `${T2D.repository}/blob/${T2D.revision}/LICENSE` },
    modifications: 'The preset adapts the reference colours with outlines, states, chart greys and a link underline of its own; Settings lists its changes.',
    notices: [{ title: 'MIT License (T2D theme)', text: t2dLicense }],
  },
  {
    id: 'cristo-theme',
    name: CRISTO.name,
    kind: 'Colour reference',
    covers: 'Provides the colour reference for the Cristo inspired preset.',
    reuse: { kind: 'Visual inspiration', detail: CRISTO.copied },
    compatibility: CRISTO_COMPATIBILITY,
    author: CRISTO.author,
    source: { label: `Cristotheme ${CRISTO.revision.slice(0, 7)}, ${CRISTO.revisionDate}`, href: `${CRISTO.repository}/tree/${CRISTO.revision}` },
    license: { label: CRISTO.license, href: `${CRISTO.repository}/blob/${CRISTO.revision}/CristoTheme/LICENSE` },
    modifications: 'The preset adapts the reference colours with surfaces, text, selection and state colours of its own, a lighter green in place of the planet green and an orbit colour of its own; Settings lists its changes. No license covers the colours that Cristotheme and DeepBlue added to the Solaris theme, and none is claimed: the notice is the one the repository keeps.',
    notices: [{ title: 'MIT License (Solaris theme, kept in Cristotheme)', text: solarisLicense }],
  },
]
