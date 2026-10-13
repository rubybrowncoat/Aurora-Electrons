// The third-party material the app credits, one entry per source: what it covers, who made it, where it comes from, its terms, what was changed and the notices those terms ask for, and how it is used (`reuse`: `Bundled files` are shipped as they are, `Visual inspiration` is not copied at all, only learned from). The About page lists them and shows each notice. The notice texts are imported here, so they are bundled into the renderer and every packaged build carries them. Code libraries keep their licenses in their own packages; About lists them under Built with. An asset whose reuse terms aren't established is not shipped and has no entry.

import mdiLicense from '@mdi/font/LICENSE?raw'
import { version as mdiVersion } from '@mdi/font/package.json'
import apacheLicense from 'roboto-fontface/LICENSE?raw'
import { version as robotoVersion } from 'roboto-fontface/package.json'
import { resolveAppearance } from './appearance'
import solarisLicense from './notices/solaris-theme-license.txt?raw'

const APACHE = { title: 'Apache License 2.0', text: apacheLicense }

// The community theme the Aurora Classic and Solaris inspired presets take their reference colours from; the provenance is the presets' own metadata, so the two cannot differ.
const { source: SOLARIS } = resolveAppearance('solaris').reference
const BUNDLED = { kind: 'Bundled files', detail: 'The files ship inside the app.' }

export const CREDITS = [
  {
    id: 'roboto',
    name: 'Roboto',
    kind: 'Font',
    covers: 'The interface typeface: Roboto from thin to black, with italics, as woff2 and woff files.',
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
    covers: 'Every icon in the interface, as one icon font (woff2, woff, ttf and eot) with its stylesheet.',
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
    covers: 'The legacy navy and pale-yellow colours it replaces and its near-black, light-grey, control and planet colours, the references of the Aurora Classic and Solaris inspired presets.',
    reuse: { kind: 'Visual inspiration', detail: SOLARIS.copied },
    author: SOLARIS.author,
    source: { label: `SolarisTheme ${SOLARIS.revision.slice(0, 7)}, ${SOLARIS.revisionDate}`, href: `${SOLARIS.repository}/tree/${SOLARIS.revision}` },
    license: { label: SOLARIS.license, href: `${SOLARIS.repository}/blob/${SOLARIS.revision}/LICENSE` },
    modifications: 'The two presets adapt the reference colours with surfaces, text, selection and state colours of their own; Settings lists each preset\'s changes.',
    notices: [{ title: 'MIT License (Solaris theme)', text: solarisLicense }],
  },
]
