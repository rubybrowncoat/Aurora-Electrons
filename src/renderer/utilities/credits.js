// The third-party fonts and icons the app ships, one entry per asset set: what it covers, who made it, where it comes from, its terms, what was changed and the notices those terms require. The About page lists them and shows each notice. The notice texts are imported here, so they are bundled into the renderer and every packaged build carries them. Code libraries keep their licenses in their own packages; About lists them under Built with. An asset whose reuse terms aren't established is not shipped and has no entry.

import mdiLicense from '@mdi/font/LICENSE?raw'
import { version as mdiVersion } from '@mdi/font/package.json'
import apacheLicense from 'roboto-fontface/LICENSE?raw'
import { version as robotoVersion } from 'roboto-fontface/package.json'

const APACHE = { title: 'Apache License 2.0', text: apacheLicense }

export const CREDITS = [
  {
    id: 'roboto',
    name: 'Roboto',
    kind: 'Font',
    covers: 'The interface typeface: Roboto from thin to black, with italics, as woff2 and woff files.',
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
    author: 'Pictogrammers (Austin Andrews and contributors)',
    source: { label: `@mdi/font ${mdiVersion}`, href: 'https://github.com/Templarian/MaterialDesign-Webfont' },
    license: { label: 'Pictogrammers Free License: icons and fonts under the Apache License 2.0, the stylesheet under MIT', href: 'https://pictogrammers.com/docs/general/license/' },
    modifications: 'None. The files ship as published; the build only renames them with a content hash.',
    notices: [{ title: 'Pictogrammers Free License', text: mdiLicense }, APACHE],
  },
]
