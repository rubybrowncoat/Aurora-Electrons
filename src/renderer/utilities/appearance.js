import Vue from 'vue'
import { buildAppearanceFile, contrastReport, parseAppearanceFile } from './appearance-file'
import { ACCENT_MODES, DEFAULT_ACCENT_MODE } from './appearance-contrast'
import { FONT_KEY, appliedFont, familyOf, loadFont } from './appearance-font'

// The appearance contract: one resolved object says what every colour in the app means, and every renderer (Vuetify's theme, the CSS custom properties on the root, Chart.js, Cytoscape, canvas, Pixi) reads its colours from it. A preset is the data for one such object; Light and Dark are the two baseline presets and reproduce the colours the app had before presets existed. Aurora Classic, Solaris, T2D, Cristo and DeepBlue are adaptations of a community reference (see `reference`), listed after them, and Telemagenta is a light palette of the owner's own, which has no reference and is listed last.
//
// A preset holds:
// - `id`, `name`, `version` (raise it when a preset's colours change), `mode` ('light' or 'dark': what Vuetify's own components and the scrollbars take as the base).
// - `surfaces`: `background` (the page and app bar), `chrome` (rail, footer), `card` (cards, tables, chart canvases), `border` (dividers and outlines), `track` and `trackSoft` (the empty part of a meter, the fill of a chip) and `rule` (a hairline under a table head).
// - `inks`: `body` (text), `muted` (secondary text, rail icons, axis ticks), `text` and `textMuted` (the colours Vuetify's own components draw their text in, styles/appearance.scss: the baselines keep Vuetify's own black or white, an adaptation uses its body and muted inks; the text Vuetify draws on the other theme keeps Vuetify's own), `onTooltip` (text on the chart tooltip), `onColor` and `onSnackbar` (the text and icons on a surface filled with one of Vuetify's named colours, a toolbar or a snackbar, and the snackbar's message: the baselines keep Vuetify's own white; an adaptation takes an ink that is 4.5:1 on the primary and the four severities, which scripts/check-contrast.js measures) and `onFill` (text on a chip filled with a severity, status, planner or focus colour: white where the fills are dark enough for it, the page's dark ink where they are light, because a tone that is also drawn as text on the dark surfaces cannot hold white).
// - `focus`: `primary` (focus, selection, links, the Galaxy Map's selection), `hover` (the wash under the pointer) and Vuetify's other two named colours, `secondary` and `accent`; and, optionally, `linkLine`, the `text-decoration-line` a link takes (`underline`) in a preset whose focus colour is too close to its text ink to tell a link by colour (styles/appearance.scss; the key is emitted as `--ae-link-line` only when the preset has it, so the other presets' links do not change).
// - `rows`: table rows that mark something: `selected` (the picked row), `differs` (a compared row that differs), `differsMark` and `differsDot` (the stripe and the dot that go with it), `stripe` and `stripeSoft` (the two bands of the focused row's hatching). Each wash is faint enough that every text colour of the preset, severity tones included, stays 4.5:1 on it, and `focus.hover` is the wash a hovered table row takes (scripts/check-contrast.js measures both).
// - `severity`: Warnings' three levels, `action` (needs action), `attention` and `info`, plus `success`; Vuetify's `error`, `warning`, `info` and `success`.
// - `contacts`, `survey`, `habitability`, `accessibility`, `status` (each optional): the meaning of a colour, not its place in the palette. `contacts`: how the race regards an alien contact (hostile, unknown, neutral, friendly, allied, civilian). `survey`: surveyed, remaining, ground (a ground survey location), unexplored (an unexplored jump point), and the geological, gravitational and both kinds of survey. `habitability`: `band`, the hue the colony-cost bands shade from. `accessibility`: a mineral deposit's good, fair and poor band. `status`: `shortfall` and `inactive` (a standing that is neither good nor bad). Each defaults to its slot in ROLE_SLOTS of the categorical list; a colour here replaces it.
// - `plan`: the Colonization Planner's hues that are not a severity (mining, terraformFree, terraformPartial, terraformCheaper, cheap, moderate, costly, severe, insufficient, rich, cmc, unsurveyed, selected), each given in full. `toneColor` turns a tone, a severity name or a key of `plan` or `status`, into its colour.
// - `charts`: `axis` (axis lines, gridlines at 60%), `tooltip` (its background) and `categorical`, the nine slots every chart series, section accent and status colour is taken from.
// - `sections`: `neutral` (the accent without a section: Settings, About, Empires, and every section while the accents are off) and `accents`, one colour for each of the nine sections of the navigation registry (`accent` of a section indexes it). They start as the colours of the chart categories and are kept apart from them, so that a change of the chart palette never recolours a section; each is 3:1 or more on the page and the card like a category (scripts/check-contrast.js), and none repeats.
// - `space`: the system view's sky and what is drawn on it: `background`, `label` (names), `labelShadow`, `bodyOrbit`, `jumpUnexplored`, `jumpExplored`. The sky is dark in every preset, so the ink on it does not follow the mode.
// - `washes`: alphas of a section's colour for an active item (`sectionSoft`), a hovered one (`sectionTint`), and of the available-status colour in the research tree (`statusSoft`).
// - `reference` (optional, adaptations only): what the preset is an adaptation of and how far. `title` and `summary` (what it looks like), `source` (the inspected community theme: `name`, `author`, `repository`, `revision`, `revisionDate`, `license`, `inspected` (what was read and how it was used: values, not code), `copied` (what was copied: nothing), `note` (what the source does not say)), `compatibility` (optional: what the preset leaves out of the reference's compatibility material, shown apart from the look: `title`, `status`, `text`), `roles` (each reference value: `role`, `value`, `maps` (where the preset uses it)) and `modifications` (what the Electrons adaptation changes or adds). Nothing in it claims that a version of the game ships the palette: a reference is a historical or community one, and the preset an adaptation of it. Settings shows it beside the preview and About's credits list the source. scripts/check-contrast.js keeps the selection colour of a preset with a reference apart from every warning severity.
//
// Physical colours (stars and the star orbit lines drawn in their colour, planet terrain) depict the world, not a meaning, and stay out of presets.
//
// The categorical palette is measured by scripts/check-contrast.js against the surfaces of every preset (page, card, chrome): every slot is 3:1 or more as a colour, in the light preset too (its slots 1, 2, 3, 4 and 8, the three weak hues and the ninth, were darkened to get there, which is why the preset's version is 2), a marker or pattern never standing in for it, and under protanopia, deuteranopia and tritanopia (Machado et al., severity 1.0) neighbouring slots differ by a CIEDE2000 of 9.6 or more. Two slots that are not neighbours can still come close under a colour-vision deficiency (as low as 1.9), which is what SERIES_ENCODINGS is for. A preset that changes the categorical list or the surfaces has to pass the script again; severity, status, planner and contact colours are measured by it too (text 4.5:1, graphics 3:1), and so is `inks.onFill` on every colour a chip is filled with (4.5:1). The planner tones are measured as text and as fills, which is why version 3 moved them (lighter in Dark, darker in Light): one tone has to read as text on the surface and carry the fill's text.
//
// An imported appearance file (utilities/appearance-file.js) is a resolved appearance of its own beside the presets, not a preset: `custom` is the one the settings keep (under CUSTOM_KEY, the validated document, which `loadAppearance` reads back through the same parser) and `custom-draft` the one a file just read is previewed as. `file` on a resolved appearance is null for a preset and, for an imported one, what the file said besides its colours: `description`, `author`, `base` (`{ id, explicit }`), `font`, `provenance` and `defaults` (the roles the base filled in). Reading a file changes nothing that is kept: the draft is only in memory, and `applyPreset` writes the document and the choice in one write, or neither.

const LIGHT = {
  id: 'light',
  name: 'Light',
  version: 5,
  mode: 'light',
  surfaces: { background: '#ffffff', chrome: '#f6f7f9', card: '#ffffff', border: '#e0e3e8', track: 'rgba(0, 0, 0, .08)', trackSoft: 'rgba(0, 0, 0, .06)', rule: 'rgba(0, 0, 0, .12)' },
  inks: { body: '#212121', muted: '#616161', text: 'rgba(0, 0, 0, 0.87)', textMuted: 'rgba(0, 0, 0, 0.6)', onTooltip: '#ffffff', onFill: '#ffffff', onColor: '#ffffff', onSnackbar: 'rgba(255, 255, 255, 0.87)' },
  focus: { primary: '#1867c0', hover: 'rgba(24, 103, 192, .06)', secondary: '#b0bec5', accent: '#8c9eff' },
  rows: { selected: 'rgba(33, 150, 243, .08)', differs: 'rgba(33, 150, 243, .08)', differsMark: '#1e88e5', differsDot: 'rgba(33, 150, 243, .45)', stripe: 'rgba(33, 150, 243, .08)', stripeSoft: 'rgba(33, 150, 243, .04)' },
  severity: { action: '#b71c1c', attention: '#a75d00', info: '#0b72c5', success: '#367d39' },
  status: { inactive: '#707070' },
  plan: { mining: '#b85c00', terraformFree: '#9c27b0', terraformPartial: '#3f51b5', terraformCheaper: '#5d7986', cheap: '#008276', moderate: '#037ab5', costly: '#8a5300', severe: '#d34215', insufficient: '#dc3500', rich: '#b85c00', cmc: '#00695c', unsurveyed: '#a86500', selected: '#f44336' },
  charts: {
    axis: '#cccccc',
    tooltip: 'rgba(97, 97, 97, 0.95)',
    categorical: ['#2a78d6', '#e95c24', '#189d6e', '#ba7e00', '#e25a8e', '#008300', '#4a3aa7', '#e34948', '#0099a8'],
  },
  sections: { neutral: '#546e7a', accents: ['#2a78d6', '#d44b16', '#168b62', '#a67000', '#db3384', '#008300', '#4a3aa7', '#e03242', '#008694'] },
  space: { background: '#000040', label: '#ffffff', labelShadow: 'rgba(0, 0, 0, .7)', bodyOrbit: '#32cd32', jumpUnexplored: '#ff3b30', jumpExplored: '#ffa500' },
  washes: { sectionSoft: 0.14, sectionTint: 0.08, statusSoft: 0.18 },
}

// The community theme both adaptations take their reference values from, at the revision that was inspected. Its public source lists the colours it replaces (the legacy ones) and the four it draws instead (near-black, light grey, controls, planets). Its license is MIT; no code or artwork of it is bundled, so the license notice is shown in About as a courtesy and for provenance.
const SOLARIS_SOURCE = {
  name: 'Solaris theme',
  author: 'Simas Toleikis',
  repository: 'https://github.com/simast/SolarisTheme',
  revision: '83aa53017754216367851620b4457284db654c15',
  revisionDate: '2021-05-20',
  license: 'MIT License',
  inspected: "The colour numbers in the theme's public source: the legacy colours it replaces and the four it puts in their place. Read in October 2026, at the revision above, and typed into this preset as values.",
  copied: 'No source code, image, icon or font of the theme is copied or bundled; colour values are the only thing taken, and the preset does not reproduce the theme.',
  note: 'The source does not say which Aurora version the legacy colours come from; its last commit is dated 2021-05-20. Nothing here states what any release of the game uses today.',
}

// The community theme the T2D inspired preset takes its colours from, at the revision that was inspected. It draws a black window and white text with white outlines; its license is MIT. Its custom icon set is a source asset with its own author and its font is chosen by the player at run time: neither is bundled, and the preset keeps the app's typeface and icons.
const T2D_SOURCE = {
  name: 'T2D theme',
  author: 'Aurora-Modders',
  repository: 'https://github.com/Aurora-Modders/T2DTheme',
  revision: 'ebee1f9feafcac13904740562d96a05b8336e9e7',
  revisionDate: '2021-05-12',
  license: 'MIT License',
  inspected: "The colour numbers in the theme's public source (the legacy navy and pale yellow it replaces, the black and white it puts in their place, the grey it draws map lines in) and the look of its published screenshot (black controls with white outlines). Read in October 2026, at the revision above, and typed into this preset as values.",
  copied: 'No source code, image, icon or font of the theme is copied or bundled; colour values are the only thing taken. The theme\'s custom icon set, made by another author, and its font choice are references only: the preset uses the app\'s own icons and typeface.',
  note: 'The theme lists corner cases that "don\'t quite look good yet" and its published screenshot keeps the default light window chrome on some dialogs, green text on black in a field and overlapping map labels; none of these is reproduced. The source does not say which Aurora version it was drawn for; its last commit is dated 2021-05-12. Nothing here states what any release of the game uses today.',
}

// The community theme the Cristo inspired preset takes its colours from, at the revision that was inspected: a modification of the Solaris theme (above) that takes two colours from a third theme, DeepBlue (Jorgen_CAB), and adds three of its own. The repository states no license of its own; the notice it carries is the Solaris theme's MIT License, which covers the Solaris part and says nothing about the colours the Cristo author or the DeepBlue author added, so no grant is claimed for those. Its icons, event-colour file, compiled patch, screenshot and font name are not used.
const CRISTO_SOURCE = {
  name: 'Cristotheme',
  author: 'CountCristo, after the Solaris theme of Simas Toleikis and the DeepBlue theme of Jorgen_CAB',
  repository: 'https://github.com/CountCristo/Cristotheme',
  revision: '4b30899b984c1dd1bb75d2bd7c17a994a1227bdb',
  revisionDate: '2026-06-15',
  license: 'No license of its own; it keeps the Solaris theme\'s MIT License, and no grant covers the colours added by Cristotheme or DeepBlue',
  inspected: "The colour numbers in the theme's public source (the window, text, map text, planet, orbit and control colours and the border it derives), as of the revision above; the file itself was last changed in August 2022. Read in October 2026 and typed into this preset as values. Nothing was run, and the compiled patch was not opened.",
  copied: "No source code, image, icon, font, event-colour file or compiled file of the theme is copied or bundled; colour values are the only thing taken. Its icons (the Solaris theme's, by other authors) and its font choice are not used: the preset keeps the app's own icons and typeface.",
  note: 'The repository states no license for the colours it adds, and the owner of this app accepted that no explicit grant covers them. Two of its colours (the window and the map text) first appear in DeepBlue and three (the text, the planet and the orbit) are its own. It has no screenshot of its own, only a video thumbnail that agrees with the window, planet and control colours; the compiled patch in the repository draws a white orbit where the source says pale green, so the preset takes neither. It does not say which Aurora version it was drawn for. Nothing here states what any release of the game uses today.',
}

// The community theme the DeepBlue inspired preset takes its colours from, as shipped in the author's own archive: a modification of the Solaris theme (above) with a different set of colours, whose window and map-text colours the Cristotheme modification (above) reuses. The archive is the only version statement (the source reads 1.3.0.0), so it is identified by its SHA-256, which `revision` holds, and the author's thread is its home. The archive keeps the Solaris theme's MIT notice and states no license of its own, so no grant is claimed for the colours the author chose. Its icons, compiled patch, screenshot and font name are not used.
const DEEPBLUE_SOURCE = {
  name: 'DeepBlue theme',
  author: 'Jorgen_CAB, after the Solaris theme of Simas Toleikis',
  repository: 'https://aurora2.pentarch.org/index.php?topic=12593.0',
  revision: '6e2ad38bf75a2b4b17cd9af57ba031b44ee30a5f222465befad693175c7a6614',
  revisionDate: '2021-06-02',
  license: 'No license of its own; it keeps the Solaris theme\'s MIT License, and no grant covers the colours added by DeepBlue',
  inspected: "The colour numbers in the theme's source, from the archive the author linked in the thread (the SHA-256 above, whose source reads version 1.3.0.0 and whose files date from June 2021), and the author's own screenshot, a lossless capture of the theme in the game, which shows every colour used here. Read in October 2026 and typed into this preset as values. Nothing was run, and the compiled files were read as bytes only.",
  copied: "No source code, image, icon, font, event-colour file or compiled file of the theme is copied or bundled; colour values are the only thing taken. Its icons (the Solaris theme's, by other authors) and its font choice are not used: the preset keeps the app's own icons and typeface.",
  note: "The author states no license for the colours chosen and credits the rest to the Solaris author, the app's owner accepted that no explicit grant covers them, and the preset claims none. The thread no longer answers at its own address and was read from a web-archive capture of January 2024, so the revision shown is the archive's hash, not a repository revision. The author's two distributions disagree on the map text colour (#EED8A4 in the archive and in the screenshot, #E7C77C in the older full bundle); the preset takes the first. Cristotheme reuses the window and map-text colours, which the Cristo inspired preset records. It does not say which Aurora version it was drawn for. Nothing here states what any release of the game uses today.",
}

const CLASSIC = {
  id: 'classic',
  name: 'Aurora Classic',
  version: 2,
  mode: 'dark',
  reference: {
    title: 'Legacy navy and pale yellow',
    summary: 'Navy surfaces under pale-yellow text, the legacy colours the reference records as the ones it replaces, adapted so that selection, warnings and charts read as they do in the other presets.',
    source: SOLARIS_SOURCE,
    roles: [
      { role: 'Window background', value: '#000040', maps: 'The page, and the system view sky' },
      { role: 'Text', value: '#FFFFC0', maps: 'Body text, the system view labels and the chart tooltip text' },
      { role: 'Enabled button', value: '#000078', maps: 'The rail and the footer' },
      { role: 'Orbit and comet line', value: '#32CD32', maps: 'Orbit lines in the system view' },
    ],
    modifications: [
      'Cards, tables and chart canvases take a navy between the page and the rail, with a lighter blue border, so a card is told from the page by more than its text.',
      'Secondary text, the status tone, the links and the selection are Electrons additions, each held at 4.5:1 or more on every surface; the legacy reference has no such roles.',
      'Selection is a sky blue, kept clear of the warning levels: Action is red, Attention orange and Info turquoise.',
      'The categorical chart slots, the planner tones and the typeface are the Dark preset\'s; the legacy interface has no equivalent.',
    ],
  },
  surfaces: { background: '#000040', chrome: '#000078', card: '#08085e', border: '#3a3aa0', track: 'rgba(255, 255, 192, .14)', trackSoft: 'rgba(255, 255, 192, .10)', rule: 'rgba(255, 255, 192, .16)' },
  inks: { body: '#ffffc0', muted: '#c4c4a0', text: '#ffffc0', textMuted: '#c4c4a0', onTooltip: '#ffffc0', onFill: '#000040', onColor: '#000040', onSnackbar: '#000040' },
  focus: { primary: '#7fa8ff', hover: 'rgba(127, 168, 255, .12)', secondary: '#2a2a8a', accent: '#FF4081' },
  rows: { selected: 'rgba(127, 168, 255, .14)', differs: 'rgba(127, 168, 255, .14)', differsMark: '#7fa8ff', differsDot: 'rgba(127, 168, 255, .55)', stripe: 'rgba(127, 168, 255, .14)', stripeSoft: 'rgba(127, 168, 255, .06)' },
  severity: { action: '#ff5c5c', attention: '#ffa040', info: '#40d0d0', success: '#90ee90' },
  status: { inactive: '#a8a8c8' },
  plan: { mining: '#ff8f00', terraformFree: '#c759da', terraformPartial: '#7482cf', terraformCheaper: '#6d8b9a', cheap: '#009688', moderate: '#039be5', costly: '#f57c00', severe: '#ea5527', insufficient: '#ff5722', rich: '#ff8f00', cmc: '#2fb5a6', unsurveyed: '#ff9800', selected: '#f44336' },
  charts: {
    axis: '#3a3aa0',
    tooltip: 'rgba(40, 40, 160, 0.97)',
    categorical: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767', '#2ec4d6'],
  },
  sections: { neutral: '#a0a8d8', accents: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008d00', '#9085e9', '#e66767', '#2ec4d6'] },
  space: { background: '#000040', label: '#ffffc0', labelShadow: 'rgba(0, 0, 0, .7)', bodyOrbit: '#32cd32', jumpUnexplored: '#ff3b30', jumpExplored: '#ffa500' },
  washes: { sectionSoft: 0.2, sectionTint: 0.12, statusSoft: 0.28 },
}

const SOLARIS = {
  id: 'solaris',
  name: 'Solaris inspired',
  version: 2,
  mode: 'dark',
  reference: {
    title: 'Near-black with muted blue controls',
    summary: 'A near-black page with light-grey text and blue-grey raised surfaces, after the community Solaris theme, adapted with full semantic surfaces and state colours.',
    source: SOLARIS_SOURCE,
    roles: [
      { role: 'Background', value: '#0C0C0C', maps: 'The page, the app bar and the system view sky' },
      { role: 'Text', value: '#D2D2D2', maps: 'Body text, the system view labels and the chart tooltip text' },
      { role: 'Controls', value: '#171A27', maps: 'Cards, tables, chart canvases, the rail and the footer' },
      { role: 'Planet', value: '#808080', maps: 'Orbit lines in the system view' },
    ],
    modifications: [
      'Secondary text and the status tone are lighter greys than the reference planet grey, which falls just under 4.5:1 on the controls colour; the grey itself stays the orbit line.',
      'Selection is a muted periwinkle, kept clear of the warning levels: Action is red, Attention orange and Info cyan; the reference has no selection or state colours.',
      'The categorical chart slots and the planner tones are the Dark preset\'s, and the typeface is the app\'s own, not Tahoma.',
    ],
  },
  surfaces: { background: '#0c0c0c', chrome: '#171a27', card: '#171a27', border: '#2f3449', track: 'rgba(210, 210, 210, .12)', trackSoft: 'rgba(210, 210, 210, .10)', rule: 'rgba(210, 210, 210, .12)' },
  inks: { body: '#d2d2d2', muted: '#a8a8a8', text: '#d2d2d2', textMuted: '#a8a8a8', onTooltip: '#d2d2d2', onFill: '#0c0c0c', onColor: '#0c0c0c', onSnackbar: '#0c0c0c' },
  focus: { primary: '#a5b4ff', hover: 'rgba(165, 180, 255, .10)', secondary: '#2b3045', accent: '#FF4081' },
  rows: { selected: 'rgba(165, 180, 255, .14)', differs: 'rgba(165, 180, 255, .14)', differsMark: '#a5b4ff', differsDot: 'rgba(165, 180, 255, .55)', stripe: 'rgba(165, 180, 255, .14)', stripeSoft: 'rgba(165, 180, 255, .06)' },
  severity: { action: '#ff6b6b', attention: '#ffa94d', info: '#4dd0e1', success: '#81c784' },
  status: { inactive: '#9a9a9a' },
  plan: { mining: '#ff8f00', terraformFree: '#c759da', terraformPartial: '#7482cf', terraformCheaper: '#6d8b9a', cheap: '#009688', moderate: '#039be5', costly: '#f57c00', severe: '#ea5527', insufficient: '#ff5722', rich: '#ff8f00', cmc: '#2fb5a6', unsurveyed: '#ff9800', selected: '#f44336' },
  charts: {
    axis: '#2f3449',
    tooltip: 'rgba(43, 48, 69, 0.97)',
    categorical: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767', '#2ec4d6'],
  },
  sections: { neutral: '#9aa0b8', accents: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#009700', '#9085e9', '#e66767', '#2ec4d6'] },
  space: { background: '#0c0c0c', label: '#d2d2d2', labelShadow: 'rgba(0, 0, 0, .7)', bodyOrbit: '#808080', jumpUnexplored: '#ff3b30', jumpExplored: '#ffa500' },
  washes: { sectionSoft: 0.2, sectionTint: 0.12, statusSoft: 0.28 },
}

const T2D = {
  id: 't2d',
  name: 'T2D inspired',
  version: 1,
  mode: 'dark',
  reference: {
    title: 'Black and white with outlines',
    summary: 'A pure black page with white text, structure drawn in outlines and weight instead of tints, after the community T2D theme. Chart categories are told apart by marker, dash and pattern on unique greys; the warning levels keep a restrained pastel on top of their icons and labels.',
    source: T2D_SOURCE,
    roles: [
      { role: 'Window background', value: '#000000', maps: 'The page, the app bar, cards, tables, chart canvases, the rail, the footer and the system view sky' },
      { role: 'Text', value: '#FFFFFF', maps: 'Body text, the system view labels, the selection and link colour; the tooltip is white with black text' },
      { role: 'Map lines', value: '#808080', maps: 'Orbit lines in the system view' },
      { role: 'Controls', value: 'Black with a white outline', maps: 'The outline colour of cards, tables and the rail, drawn in light grey' },
    ],
    modifications: [
      'The reference has no state colours: the warning levels, success and the planner\'s cost bands are light pastels (Action a salmon, Attention an amber, Info an aqua, Success a mint) that are each 4.5:1 as text on black and take black text as a fill, and every one of them is also carried by an icon and a label.',
      'Selection, links and the focus ring are white. A link is underlined, and a selected row keeps its 3px bar and a wash that a pressed button, a hovered row and the focused row\'s hatching share, so none of them depends on a hue; the selection stays 20 or more CIEDE2000 from the warning pastels.',
      'The nine chart categories are unique greys alternating between lighter and darker, none under 6:1 on black so that a section accent (an active tab, a rail icon) is never dimmer than an inactive one, neighbours at least 12 CIEDE2000 apart; the marker, dash and bar pattern of each slot (SERIES_ENCODINGS) tell them apart where two greys come close.',
      'The system view\'s jump points differ in lightness (an unexplored one is white, an explored one grey) and keep the square outline of a gate, besides their labels; the reference has no equivalent.',
      'The typeface is the app\'s own and stays an independent preference; the reference\'s font dialog is not reproduced.',
    ],
  },
  surfaces: { background: '#000000', chrome: '#000000', card: '#000000', border: '#8a8a8a', track: 'rgba(255, 255, 255, .22)', trackSoft: 'rgba(255, 255, 255, .16)', rule: 'rgba(255, 255, 255, .4)' },
  inks: { body: '#ffffff', muted: '#b3b3b3', text: '#ffffff', textMuted: '#b3b3b3', onTooltip: '#000000', onFill: '#000000', onColor: '#000000', onSnackbar: '#000000' },
  focus: { primary: '#ffffff', hover: 'rgba(255, 255, 255, .10)', secondary: '#4d4d4d', accent: '#bdbdbd', linkLine: 'underline' },
  rows: { selected: 'rgba(255, 255, 255, .18)', differs: 'rgba(255, 255, 255, .18)', differsMark: '#ffffff', differsDot: 'rgba(255, 255, 255, .6)', stripe: 'rgba(255, 255, 255, .18)', stripeSoft: 'rgba(255, 255, 255, .07)' },
  severity: { action: '#ff8a80', attention: '#ffcc80', info: '#80deea', success: '#a5d6a7' },
  contacts: { hostile: '#ff8a80', friendly: '#a5d6a7', allied: '#f9f9f9' },
  accessibility: { good: '#dedede', fair: '#aaaaaa', poor: '#919191' },
  status: { shortfall: '#ff8a80', inactive: '#9a9a9a' },
  plan: { mining: '#d6d6d6', terraformFree: '#f0f0f0', terraformPartial: '#b4b4b4', terraformCheaper: '#8f8f8f', cheap: '#a5d6a7', moderate: '#80deea', costly: '#ffcc80', severe: '#ff9e94', insufficient: '#ff8a80', rich: '#eaeaea', cmc: '#a2a2a2', unsurveyed: '#7a7a7a', selected: '#ffffff' },
  charts: {
    axis: '#8a8a8a',
    tooltip: 'rgba(255, 255, 255, 0.97)',
    categorical: ['#c4c4c4', '#919191', '#d1d1d1', '#9d9d9d', '#dedede', '#aaaaaa', '#ececec', '#b7b7b7', '#f9f9f9'],
  },
  sections: { neutral: '#b3b3b3', accents: ['#c4c4c4', '#919191', '#d1d1d1', '#9d9d9d', '#dedede', '#aaaaaa', '#ececec', '#b7b7b7', '#f9f9f9'] },
  space: { background: '#000000', label: '#ffffff', labelShadow: 'rgba(0, 0, 0, .7)', bodyOrbit: '#808080', jumpUnexplored: '#ffffff', jumpExplored: '#a0a0a0' },
  washes: { sectionSoft: 0.2, sectionTint: 0.12, statusSoft: 0.28 },
}

const CRISTO = {
  id: 'cristo',
  name: 'Cristo inspired',
  version: 1,
  mode: 'dark',
  reference: {
    title: 'Deep navy with cream text',
    summary: 'A deep navy page under cream text and sand-coloured sky labels, with the dark blue-grey controls of the Solaris theme, after the community Cristo theme, adapted with full semantic surfaces and state colours.',
    source: CRISTO_SOURCE,
    compatibility: {
      title: 'Event-colour compatibility',
      status: 'Not included',
      text: 'The community theme comes with a separate file of alert and text colours for event types. It is not part of this preset and is not read or shipped: the Log shows every event in the colours the save holds for the race, whichever preset is chosen.',
    },
    roles: [
      { role: 'Window and map background', value: '#0D1729', maps: 'The page, the app bar and the system view sky' },
      { role: 'Text', value: '#F0F0C8', maps: 'Body text and the chart tooltip text' },
      { role: 'Map text', value: '#EED8A4', maps: 'The system view labels' },
      { role: 'Button fill', value: '#171A27', maps: 'Cards, tables, chart canvases, the rail and the footer' },
      { role: 'Active button border (derived)', value: '#41486D', maps: 'The outline of cards, tables and the rail, and the chart axis' },
      { role: 'Planet fill', value: '#005700', maps: 'Not drawn as it is: it is 2.02:1 on the page. The substitute is #008A00, the same hue lightened until it is 3:1 or more on every surface, and it is the surveyed colour of the Galaxy Map, the nearest role to a planet; the app draws planets in their own colours' },
      { role: 'Orbit line', value: 'Not taken', maps: 'The source says pale green (#BEFFBE) and the compiled patch white (#FFFFFF), so the orbit lines are a pale blue-grey of the preset\'s own' },
    ],
    modifications: [
      'Cards, tables and chart canvases take the reference button fill, which is almost the page colour, so the derived border colour outlines them: a card is told from the page by its outline as well as its text.',
      'Secondary text and the status tone are of the reference text hue, kept 4.5:1 or more on every surface; the reference has no such roles, and neither it nor its disabled text, which is derived and was not observed, is used.',
      'Selection is a periwinkle blue, kept clear of the warning levels: Action is red, Attention orange and Info cyan; the reference has no selection or state colours.',
      'The planet green is replaced by a lighter one for contrast, and the reference orbit colour is not taken because its two sources disagree.',
      'The reference toolbar group tints, its Space Master and Auto turns colours and its font are not mapped: the app has no equivalent role, and the typeface is the app\'s own, not Tahoma.',
      'The categorical chart slots, the section accents and the planner tones are the Dark preset\'s; the reference has no equivalent.',
    ],
  },
  surfaces: { background: '#0d1729', chrome: '#171a27', card: '#171a27', border: '#41486d', track: 'rgba(240, 240, 200, .14)', trackSoft: 'rgba(240, 240, 200, .10)', rule: 'rgba(240, 240, 200, .14)' },
  inks: { body: '#f0f0c8', muted: '#bdbd9f', text: '#f0f0c8', textMuted: '#bdbd9f', onTooltip: '#f0f0c8', onFill: '#0d1729', onColor: '#0d1729', onSnackbar: '#0d1729' },
  focus: { primary: '#8fb0ff', hover: 'rgba(143, 176, 255, .10)', secondary: '#2b3558', accent: '#FF4081' },
  rows: { selected: 'rgba(143, 176, 255, .14)', differs: 'rgba(143, 176, 255, .14)', differsMark: '#8fb0ff', differsDot: 'rgba(143, 176, 255, .55)', stripe: 'rgba(143, 176, 255, .14)', stripeSoft: 'rgba(143, 176, 255, .06)' },
  severity: { action: '#ff6b6b', attention: '#ffa94d', info: '#4dd0e1', success: '#81c784' },
  survey: { done: '#008a00' },
  status: { inactive: '#a0a4b8' },
  plan: { mining: '#ff8f00', terraformFree: '#c759da', terraformPartial: '#7482cf', terraformCheaper: '#6d8b9a', cheap: '#009688', moderate: '#039be5', costly: '#f57c00', severe: '#ea5527', insufficient: '#ff5722', rich: '#ff8f00', cmc: '#2fb5a6', unsurveyed: '#ff9800', selected: '#f44336' },
  charts: {
    axis: '#41486d',
    tooltip: 'rgba(37, 46, 78, 0.97)',
    categorical: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767', '#2ec4d6'],
  },
  sections: { neutral: '#a3acc8', accents: ['#3987e5', '#d95f26', '#199e70', '#c98500', '#d75994', '#009c00', '#9085e9', '#e66767', '#2ec4d6'] },
  space: { background: '#0d1729', label: '#eed8a4', labelShadow: 'rgba(0, 0, 0, .7)', bodyOrbit: '#b1b9cc', jumpUnexplored: '#ff3b30', jumpExplored: '#ffa500' },
  washes: { sectionSoft: 0.2, sectionTint: 0.12, statusSoft: 0.28 },
}

const DEEPBLUE = {
  id: 'deepblue',
  name: 'DeepBlue inspired',
  version: 1,
  mode: 'dark',
  reference: {
    title: 'Deep navy with violet-grey plates',
    summary: 'A deep navy page under pale-yellow text and sand-coloured sky labels, with raised violet-grey controls and cards, after the community DeepBlue theme, adapted with full semantic surfaces and state colours.',
    source: DEEPBLUE_SOURCE,
    roles: [
      { role: 'Window and map background', value: '#0D1729', maps: 'The page, the app bar and the system view sky' },
      { role: 'Text', value: '#E8E4A8', maps: 'Body text and the chart tooltip text' },
      { role: 'Button fill', value: '#46435A', maps: 'The empty part of a meter, the Vuetify secondary colour and, a shade darker, the fill of a chip' },
      { role: 'Toolbar tint', value: '#2B2937', maps: 'The rail and the footer (#282632) and the cards, tables and chart canvases (#262431), the same hue a little darker so the text stays 4.5:1 under the section tabs\' hover and focus states' },
      { role: 'Map text', value: '#EED8A4', maps: 'The system view labels' },
      { role: 'Orbit line', value: '#969696', maps: 'Orbit lines in the system view' },
      { role: 'Active button border (derived)', value: '#6C688C', maps: 'The outline of cards, tables and the rail, and the chart axis' },
      { role: 'Planet fill', value: '#005A00', maps: 'Not drawn as it is: it is 2.10:1 on the page. The substitute is #008F00, the same hue lightened until it is 3:1 or more on the page, the rail and the cards, and it is the surveyed colour of the Galaxy Map, the nearest role to a planet; the app draws planets in their own colours' },
    ],
    modifications: [
      'The reference\'s violet-grey plate colour cannot be the rail or the cards: under the section tabs\' hover and focus states the text falls under 4.5:1 on it. The plate colour is the meter track and the secondary colour instead, and the surfaces take the darker toolbar tint, with the derived border outlining them.',
      'Secondary text and the status tone are of the reference text hue, kept 4.5:1 or more on every surface; the reference has no such roles, and neither it nor its disabled text, which is derived and was not observed, is used.',
      'Selection is a lavender, kept clear of the warning levels: Action is red, Attention orange and Info cyan; the reference has no selection or state colours, and the row washes are fainter than the other presets\' so the red stays 4.5:1 under them.',
      'The categorical chart slots, the section accents and the planner tones are lighter than the Dark preset\'s, which fall under 3:1 or 4.5:1 on the violet-grey surfaces; the reference has no equivalent of any of them.',
      'The planet green is replaced by a lighter one for contrast.',
      'The reference\'s other toolbar tint, its enabled-button ink and its font are not mapped: the app has no equivalent role, and the typeface is the app\'s own, not Tahoma.',
    ],
  },
  surfaces: { background: '#0d1729', chrome: '#282632', card: '#262431', border: '#6c688c', track: '#46435a', trackSoft: '#3a3849', rule: 'rgba(232, 228, 168, .18)' },
  inks: { body: '#e8e4a8', muted: '#cfcb9a', text: '#e8e4a8', textMuted: '#cfcb9a', onTooltip: '#e8e4a8', onFill: '#0d1729', onColor: '#0d1729', onSnackbar: '#0d1729' },
  focus: { primary: '#b8a9ff', hover: 'rgba(184, 169, 255, .08)', secondary: '#46435a', accent: '#FF4081' },
  rows: { selected: 'rgba(184, 169, 255, .10)', differs: 'rgba(184, 169, 255, .10)', differsMark: '#b8a9ff', differsDot: 'rgba(184, 169, 255, .55)', stripe: 'rgba(184, 169, 255, .10)', stripeSoft: 'rgba(184, 169, 255, .05)' },
  severity: { action: '#ff7a7a', attention: '#ffa94d', info: '#4dd0e1', success: '#81c784' },
  survey: { done: '#008f00' },
  status: { inactive: '#b3b1c8' },
  plan: { mining: '#ff8f00', terraformFree: '#d57ae6', terraformPartial: '#8b98dd', terraformCheaper: '#8aa5b3', cheap: '#1ab5a5', moderate: '#039be5', costly: '#f57c00', severe: '#f2704a', insufficient: '#ff5722', rich: '#ff8f00', cmc: '#2fb5a6', unsurveyed: '#ff9800', selected: '#ff6659' },
  charts: {
    axis: '#6c688c',
    tooltip: 'rgba(43, 41, 55, 0.97)',
    categorical: ['#6fa8ff', '#ff9a66', '#3fd0a0', '#e6b422', '#ff8fb8', '#7fd13b', '#b6a6ff', '#ff8585', '#4fd8e8'],
  },
  sections: { neutral: '#b4b2cf', accents: ['#6fa8ff', '#ff9a66', '#3fd0a0', '#e6b422', '#ff8fb8', '#7fd13b', '#b6a6ff', '#ff8585', '#4fd8e8'] },
  space: { background: '#0d1729', label: '#eed8a4', labelShadow: 'rgba(0, 0, 0, .7)', bodyOrbit: '#969696', jumpUnexplored: '#ff3b30', jumpExplored: '#ffa500' },
  washes: { sectionSoft: 0.2, sectionTint: 0.12, statusSoft: 0.28 },
}

const DARK = {
  id: 'dark',
  name: 'Dark',
  version: 5,
  mode: 'dark',
  surfaces: { background: '#121212', chrome: '#1e1e1e', card: '#1e1e1e', border: '#333333', track: 'rgba(255, 255, 255, .12)', trackSoft: 'rgba(255, 255, 255, .1)', rule: 'rgba(255, 255, 255, .12)' },
  inks: { body: '#f5f5f5', muted: '#b0b0b0', text: '#ffffff', textMuted: 'rgba(255, 255, 255, 0.7)', onTooltip: '#ffffff', onFill: '#121212', onColor: '#ffffff', onSnackbar: 'rgba(255, 255, 255, 0.87)' },
  focus: { primary: '#2196f3', hover: 'rgba(33, 150, 243, .10)', secondary: '#424242', accent: '#FF4081' },
  rows: { selected: 'rgba(33, 150, 243, .10)', differs: 'rgba(33, 150, 243, .10)', differsMark: '#1e88e5', differsDot: 'rgba(33, 150, 243, .45)', stripe: 'rgba(33, 150, 243, .10)', stripeSoft: 'rgba(33, 150, 243, .04)' },
  severity: { action: '#FF5252', attention: '#FB8C00', info: '#2196F3', success: '#4CAF50' },
  status: { inactive: '#9e9e9e' },
  plan: { mining: '#ff8f00', terraformFree: '#c759da', terraformPartial: '#7482cf', terraformCheaper: '#6d8b9a', cheap: '#009688', moderate: '#039be5', costly: '#f57c00', severe: '#ea5527', insufficient: '#ff5722', rich: '#ff8f00', cmc: '#2fb5a6', unsurveyed: '#ff9800', selected: '#f44336' },
  charts: {
    axis: '#333333',
    tooltip: 'rgba(97, 97, 97, 0.95)',
    categorical: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767', '#2ec4d6'],
  },
  sections: { neutral: '#90a4ae', accents: ['#3987e5', '#d95f26', '#199e70', '#c98500', '#d75994', '#009c00', '#9085e9', '#e66767', '#2ec4d6'] },
  space: { background: '#000040', label: '#ffffff', labelShadow: 'rgba(0, 0, 0, .7)', bodyOrbit: '#32cd32', jumpUnexplored: '#ff3b30', jumpExplored: '#ffa500' },
  washes: { sectionSoft: 0.2, sectionTint: 0.12, statusSoft: 0.28 },
}

// The owner's own light palette, taken from a photograph of a room: cream walls, a pinkish ceiling, white trim, a magenta-crimson accent wall and a brown shadowed corner. The page and the rail are cream (the cards a lighter cream), the selection, the focus colour and the neutral section accent are telemagenta, deepened from RAL 4010 until it is 4.5:1 as text on the cream, the ceiling pink is the secondary colour, the wall's crimson the accent and the shadow's brown the secondary ink, and the chart series keep clear of the magenta. No community theme stands behind it, so it has no `reference` and no credits entry; it is not a baseline either, so its page, rail, cards and `body` and `muted` inks are its own, while the inks Vuetify draws (`text`, `textMuted`, `onColor`, `onSnackbar`) stay Vuetify's own, which scripts/check-contrast.js holds every preset without a reference to. scripts/check-telemagenta-preset.js records the sampled colours and where each is used.
const TELEMAGENTA = {
  id: 'telemagenta',
  name: 'Telemagenta',
  version: 1,
  mode: 'light',
  surfaces: { background: '#f6eedc', chrome: '#f3e9de', card: '#fffbf2', border: '#ddd0b8', track: 'rgba(60, 38, 22, .10)', trackSoft: 'rgba(60, 38, 22, .07)', rule: 'rgba(60, 38, 22, .14)' },
  inks: { body: '#2a1a12', muted: '#6a5446', text: 'rgba(0, 0, 0, 0.87)', textMuted: 'rgba(0, 0, 0, 0.6)', onTooltip: '#ffffff', onFill: '#ffffff', onColor: '#ffffff', onSnackbar: 'rgba(255, 255, 255, 0.87)' },
  focus: { primary: '#b8286a', hover: 'rgba(184, 40, 106, .06)', secondary: '#dcc3b8', accent: '#8a0030' },
  rows: { selected: 'rgba(184, 40, 106, .08)', differs: 'rgba(184, 40, 106, .08)', differsMark: '#b8286a', differsDot: 'rgba(184, 40, 106, .45)', stripe: 'rgba(184, 40, 106, .08)', stripeSoft: 'rgba(184, 40, 106, .04)' },
  severity: { action: '#8f1111', attention: '#975300', info: '#0966b2', success: '#307133' },
  status: { inactive: '#6f6254' },
  plan: { mining: '#9f4e00', terraformFree: '#9c27b0', terraformPartial: '#3f51b5', terraformCheaper: '#506874', cheap: '#007167', moderate: '#026a9f', costly: '#8a5300', severe: '#b63811', insufficient: '#be2c00', rich: '#9f4e00', cmc: '#00695c', unsurveyed: '#915700', selected: '#bd2d2c' },
  charts: {
    axis: '#d9ccb4',
    tooltip: 'rgba(60, 38, 22, 0.95)',
    categorical: ['#2874cf', '#c64414', '#165a2d', '#9d6900', '#6b3f2a', '#008300', '#4a3aa7', '#bd2d2c', '#00808e'],
  },
  sections: { neutral: '#a31f5c', accents: ['#2874cf', '#c64414', '#165a2d', '#9d6900', '#6b3f2a', '#008300', '#4a3aa7', '#bd2d2c', '#00808e'] },
  space: { background: '#000040', label: '#ffffff', labelShadow: 'rgba(0, 0, 0, .7)', bodyOrbit: '#32cd32', jumpUnexplored: '#ff3b30', jumpExplored: '#ffa500' },
  washes: { sectionSoft: 0.14, sectionTint: 0.08, statusSoft: 0.18 },
}

// Every preset by id. A preset joins the app by being listed here.
export const PRESETS = { [LIGHT.id]: LIGHT, [DARK.id]: DARK, [CLASSIC.id]: CLASSIC, [SOLARIS.id]: SOLARIS, [T2D.id]: T2D, [CRISTO.id]: CRISTO, [DEEPBLUE.id]: DEEPBLUE, [TELEMAGENTA.id]: TELEMAGENTA }

export const DEFAULT_PRESET_ID = LIGHT.id

// The preset each mode falls back to: the baseline pair the theme policy draws, and where the lamp in the app bar and the Theme control land.
const BASELINE_BY_MODE = { light: LIGHT.id, dark: DARK.id }

// The policy each baseline id stands for: what an id of a baseline under `appearance` (the form before the policy, which an older preferences file still holds) means.
export const BASELINE_POLICIES = Object.fromEntries(Object.entries(BASELINE_BY_MODE).map(([mode, id]) => [id, mode]))

// The settings key of the named appearance that replaces the theme: the id of Aurora Classic, Solaris inspired, T2D inspired, Cristo inspired or the kept imported appearance (`custom`), or `theme` (NO_OVERRIDE) when none does and the baseline pair under the policy is drawn; a settings file that holds none reads the same. App-wide, written only by `applyPreset`, `applyPolicy` and `removeCustom`. Settings from before the policy hold the id of a baseline there (`light` or `dark`), and settings from before presets only a boolean `darkMode`; `adoptAppearance` turns either into the policy once, and nothing writes `darkMode` any more.
export const APPEARANCE_KEY = 'appearance'

// What APPEARANCE_KEY holds when no named appearance replaces the theme. It is written, not left out, so that a preferences file can say so and an import ends the replacement it finds.
export const NO_OVERRIDE = 'theme'

// The theme policy, the settings key it is kept under and its values: how the baseline pair (Light and Dark) is chosen. `light` and `dark` pin one of them; `system` follows the operating system's colour scheme (`followSystem`). It is kept whatever named appearance is chosen, so that removing the appearance returns to it; a settings file with none takes the mode of the named appearance it holds (the baseline it falls back to is then the one of its mode), and one without either the mode `darkMode` said, else the default. Settings keep one writer of the pair, never two competing ones: `applyPolicy`, which also ends a named appearance.
export const POLICY_KEY = 'appearancePolicy'
export const POLICIES = ['light', 'dark', 'system']
const SYSTEM = 'system'
export const DEFAULT_POLICY = LIGHT.mode

// The ids of an imported appearance: the kept one, and the draft of a file just read.
export const CUSTOM_ID = 'custom'
export const DRAFT_ID = 'custom-draft'

// The settings key the kept imported appearance is stored under: the document of the file, as `parseAppearanceFile` accepted it. Written only by `applyPreset` (with the draft) and `removeCustom`.
export const CUSTOM_KEY = 'appearanceCustom'

// The settings key of how the section accents are drawn (`on`, `restrained` or `off`, ACCENT_MODES of utilities/appearance-contrast.js) and what a settings file without it means. App-wide, written only by `applyAccents`, kept whatever preset is chosen. It is written for every choice, the default too, so that a preferences file can say `on` and an import ends a `restrained` it finds.
export const ACCENTS_KEY = 'appearanceAccents'
export { ACCENT_MODES, DEFAULT_ACCENT_MODE }

// The settings the appearance holds, which a reset of the remembered views keeps: the named appearance, the kept imported one, the typeface, the policy and the section accents.
export const APPEARANCE_SETTINGS = [APPEARANCE_KEY, CUSTOM_KEY, FONT_KEY, POLICY_KEY, ACCENTS_KEY]

// Categorical slots of the colours that carry a meaning, by role; `muted` is the preset's muted ink.
export const CONTACT_SLOTS = { hostile: 7, unknown: 7, neutral: 3, friendly: 2, allied: 0, civilian: 'muted' }

// The Galaxy Map's right-click menu: its wedges are the primary colour at `fillAlpha` over the page background, the wedge under the pointer a categorical slot at `activeAlpha` over that wedge, and its icons `inks.onColor`, which scripts/check-contrast.js measures against both (3:1).
export const MAP_MENU = { fillAlpha: 0.88, activeSlot: 2, activeAlpha: 0.9 }

// What tells a categorical slot apart without its colour, one entry per slot: the `marker` a line or scatter series carries (the shapes are in components/charts/theme.js), the `dash` of its line (line widths; empty is solid) and the `pattern` a bar or stack segment is hatched with. Each of the three is unique to a slot, so a series is identifiable by any one of them, and a legend shows all that apply. They belong to the slot, not to the preset, because a preset only recolours the slots. scripts/check-contrast.js checks that the nine are unique.
export const SERIES_ENCODINGS = [
  { marker: 'circle', dash: [], pattern: 'solid' },
  { marker: 'square', dash: [9, 4], pattern: 'diagonal' },
  { marker: 'triangle', dash: [2, 3], pattern: 'dots' },
  { marker: 'diamond', dash: [9, 3, 2, 3], pattern: 'horizontal' },
  { marker: 'cross', dash: [4, 3], pattern: 'crosshatch' },
  { marker: 'ex', dash: [14, 5], pattern: 'vertical' },
  { marker: 'down', dash: [9, 3, 2, 3, 2, 3], pattern: 'backdiagonal' },
  { marker: 'star', dash: [1, 2.5], pattern: 'squares' },
  { marker: 'hexagon', dash: [6, 6], pattern: 'zigzag' },
]

const ROLE_SLOTS = {
  contacts: CONTACT_SLOTS,
  survey: { done: 2, left: 1, ground: 4, unexplored: 3, geological: 0, gravitational: 1, both: 6 },
  habitability: { band: 0 },
  accessibility: { good: 2, fair: 3, poor: 1 },
  status: { shortfall: 7 },
}

const resolved = new WeakMap()

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key)

// The imported appearances, each `{ appearance, parsed, report }` (the resolved appearance, what the parser returned and its contrast report) and frozen, so that Vue leaves it alone. `problem` is what stopped the stored one from loading, or null.
const imported = Vue.observable({ custom: null, draft: null, problem: null })
let revision = 0

const freezeDeep = (value) => {
  Object.values(value).forEach((inner) => {
    if (inner !== null && typeof inner === 'object') {
      freezeDeep(inner)
    }
  })

  return Object.freeze(value)
}

// Gives a parsed file an id, a version (one per registration, so a watcher sees a new file as a new appearance) and a resolved appearance.
const register = (id, parsed) => {
  revision++

  const file = { description: parsed.description, author: parsed.author, base: parsed.base, font: parsed.font, provenance: parsed.provenance, defaults: parsed.defaults }
  const appearance = freezeDeep({ id, name: parsed.name, version: revision, key: `${id}@${revision}`, mode: parsed.mode, reference: null, file, ...JSON.parse(JSON.stringify(parsed.roles)) })

  return Object.freeze({ appearance, parsed, report: contrastReport(appearance, { baseline: resolveAppearance(BASELINE_BY_MODE[parsed.mode]) }) })
}

const isKnown = (id) => hasOwn(PRESETS, id) || (id === CUSTOM_ID && imported.custom !== null) || (id === DRAFT_ID && imported.draft !== null)

// The resolved appearance of a preset, or of the imported one an id names: the object every renderer reads. The same preset gives the same object (its `key`, `id@version`, names it), so a component can watch it.
export const resolveAppearance = (id) => {
  if (id === CUSTOM_ID && imported.custom) {
    return imported.custom.appearance
  }

  if (id === DRAFT_ID && imported.draft) {
    return imported.draft.appearance
  }

  const preset = PRESETS[id] || PRESETS[DEFAULT_PRESET_ID]

  if (!resolved.has(preset)) {
    const { categorical } = preset.charts
    const roles = Object.fromEntries(Object.entries(ROLE_SLOTS).map(([group, slots]) => [group, { ...Object.fromEntries(Object.entries(slots).map(([role, slot]) => [role, slot === 'muted' ? preset.inks.muted : categorical[slot]])), ...preset[group] }]))

    resolved.set(preset, {
      id: preset.id,
      name: preset.name,
      version: preset.version,
      key: `${preset.id}@${preset.version}`,
      mode: preset.mode,
      surfaces: { ...preset.surfaces },
      inks: { ...preset.inks },
      reference: preset.reference || null,
      file: null,
      focus: { ...preset.focus },
      rows: { ...preset.rows },
      severity: { ...preset.severity },
      ...roles,
      plan: { ...preset.plan },
      charts: { ...preset.charts, categorical: [...categorical] },
      sections: { ...preset.sections, accents: [...preset.sections.accents] },
      space: { ...preset.space },
      washes: { ...preset.washes },
    })
  }

  return resolved.get(preset)
}

// `id` is the preset in force (what every renderer draws with), `applied` what the kept choices draw. They differ while a preview is open; `previewing` says one is open, and is kept apart from the two being equal, because `applied` moves with the operating system under the System policy and a preview of the baseline the system has just reached is still a preview, with its Apply and Cancel. `policy` and `override` are the kept choices (`override` is null for none) and `system` is the operating system's colour scheme as last observed, which only the System policy reads.
const state = Vue.observable({ id: DEFAULT_PRESET_ID, applied: DEFAULT_PRESET_ID, previewing: false, policy: DEFAULT_POLICY, override: null, system: 'light', accents: DEFAULT_ACCENT_MODE })

// The preset the kept choices draw: the named appearance, else the baseline of the policy's mode (under System, the mode the operating system is in).
const keptId = () => state.override || BASELINE_BY_MODE[state.policy === SYSTEM ? state.system : state.policy]

// Brings the applied preset in line with the kept choices once one of them, or the operating system, changed, and the preset in force with it unless a preview is open: a preview stays where it is, whatever the applied preset becomes.
const settle = () => {
  state.applied = keptId()

  if (!state.previewing) {
    state.id = state.applied
  }
}

const storedPolicy = (config) => {
  const policy = config.get(POLICY_KEY)

  return POLICIES.includes(policy) ? policy : null
}

// The appearance in force. Read inside a computed property, a render or a watcher, it makes that one depend on the chosen preset, so a switch (light to dark, or dark to another dark) redraws what read it.
export const activeAppearance = () => resolveAppearance(state.id)

// The id of the preset the kept choices draw (reactive). It is what a cancelled preview, and leaving Settings with a preview open, go back to.
export const appliedPresetId = () => state.applied

// The kept theme policy (reactive), the id of the kept named appearance or null (reactive) and the colour scheme of the operating system as last observed (reactive; it matters only while the policy is `system`).
export const appearancePolicy = () => state.policy

export const appearanceOverride = () => state.override

export const systemMode = () => state.system

// How the section accents are drawn now (reactive): what `sectionStyle` of components/navigation/section-style.js reads.
export const accentMode = () => state.accents

// Whether a preview is open: a preset other than the applied one was put in force, and neither a cancel nor a kept choice has ended it since (reactive). A change of the applied preset under the preview, by the operating system, does not end it.
export const isPreviewing = () => state.previewing

// Every preset, resolved, in the order they are listed.
export const listAppearances = () => Object.keys(PRESETS).map((id) => resolveAppearance(id))

// The imported appearances (reactive): `custom`, the kept one, and `draft`, the file just read, each `{ appearance, parsed, report }` or null, and `problem`, what kept the stored one from loading (`{ errors, omitted }`) or null.
export const importedAppearances = () => ({ custom: imported.custom, draft: imported.draft, problem: imported.problem })

// Reads the text of an appearance file and, when it holds a valid one, makes it the draft and puts it in force as a preview, so every page shows it. A file with a failure changes nothing and gives `{ ok: false, errors, omitted }`; a valid one gives `{ ok: true, entry }`. Nothing is kept until `applyPreset` is given the draft's id.
export const importAppearanceFile = (text) => {
  const parsed = parseAppearanceFile(text, { builtIn: (id) => (hasOwn(PRESETS, id) ? resolveAppearance(id) : null), baselines: BASELINE_BY_MODE })

  if (!parsed.ok) {
    return parsed
  }

  imported.draft = register(DRAFT_ID, parsed)
  state.id = DRAFT_ID
  state.previewing = true

  return { ok: true, entry: imported.draft }
}

// The file of a preset or an imported appearance (an id of `custom` or `custom-draft`), as an object ready to be written as JSON, or null for an id that names none. `now` is the time of the export; the file names the typeface in force (utilities/appearance-font.js) unless it is an imported file that named one of its own.
export const exportAppearanceFile = (id, now = Date.now()) => (isKnown(id) ? buildAppearanceFile(resolveAppearance(id), { now, typeface: familyOf(appliedFont().family).name }) : null)

// Puts a preset in force without keeping it, so every page shows it (Vuetify's theme follows through the watcher in plugins/vuetify.js). An unknown id changes nothing. Writes nothing.
export const previewPreset = (id) => {
  if (isKnown(id)) {
    state.id = id
    state.previewing = id !== state.applied
  }
}

// Drops the preview: the applied preset is in force again.
export const cancelPreview = () => {
  state.previewing = false
  imported.draft = null
  state.id = state.applied
}

// Keeps a preset or an imported appearance: puts it in force, makes it the applied one and writes its id to the settings (`config` is the settings store). A baseline (`light`, `dark`) is the policy of that mode and ends any named appearance (`applyPolicy`); any other is the named appearance that replaces the theme, and the policy is kept as it is. An unknown id changes nothing and returns false. The settings are written first, so a failed write leaves the selection as it was. The draft of a file is kept as `custom` (replacing the one kept before): its document and the choice are written together, in one assignment of the store, so the settings hold both or neither.
export const applyPreset = (config, id) => {
  if (!isKnown(id)) {
    return false
  }

  if (id === DRAFT_ID) {
    const entry = imported.draft

    config.update((store) => ({ ...store, [CUSTOM_KEY]: entry.parsed.document, [APPEARANCE_KEY]: CUSTOM_ID }))
    imported.custom = register(CUSTOM_ID, entry.parsed)
    imported.draft = null
    imported.problem = null
    state.override = CUSTOM_ID
    state.policy = storedPolicy(config) || imported.custom.appearance.mode
    state.previewing = false
    settle()

    return true
  }

  if (hasOwn(BASELINE_BY_MODE, id)) {
    return applyPolicy(config, id)
  }

  config.set(APPEARANCE_KEY, id)
  state.override = id
  state.policy = storedPolicy(config) || resolveAppearance(id).mode
  state.previewing = false
  settle()

  return true
}

// Keeps a theme policy (`light`, `dark` or `system`) and ends the named appearance that replaced the theme, in one write, then draws what the policy says: the one path the app bar's lamp and the Theme control of Settings share, and the other half of what `applyPreset` does for a baseline. An unknown policy changes nothing and returns false. The settings are written first, so a failed write leaves the choice as it was.
export const applyPolicy = (config, policy) => {
  if (!POLICIES.includes(policy)) {
    return false
  }

  config.update((store) => ({ ...store, [POLICY_KEY]: policy, [APPEARANCE_KEY]: NO_OVERRIDE }))
  state.policy = policy
  state.override = null
  state.previewing = false
  settle()

  return true
}

// Keeps how the section accents are drawn (`on`, `restrained` or `off`) and draws it at once. An unknown mode changes nothing and returns false. The settings are written first, so a failed write leaves the choice as it was.
export const applyAccents = (config, mode) => {
  if (!ACCENT_MODES.includes(mode)) {
    return false
  }

  config.set(ACCENTS_KEY, mode)
  state.accents = mode

  return true
}

// Forgets the kept imported appearance: removes its document from the settings and, when it was the named appearance, ends it and keeps the policy that applies in its place (the policy in force, which is the mode of the file unless one was kept), in one write over the settings as they are then. Returns false when there is none.
export const removeCustom = (config) => {
  const stored = config.get(CUSTOM_KEY)

  if (stored === undefined && !imported.custom) {
    return false
  }

  const { policy } = state

  config.update((store) => {
    const rest = { ...store }

    delete rest[CUSTOM_KEY]

    return store[APPEARANCE_KEY] === CUSTOM_ID ? { ...rest, [APPEARANCE_KEY]: NO_OVERRIDE, [POLICY_KEY]: policy } : rest
  })
  imported.custom = null
  imported.problem = null

  if (state.override === CUSTOM_ID) {
    state.override = null
  }

  // A preview of the appearance being removed ends with it; a preview of another preset, and the draft of a file just read, stay.
  if (state.id === CUSTOM_ID) {
    state.previewing = false
  }

  settle()

  return true
}

// The saved id when it names no preset this version has (a preset from a newer version, or a damaged value), else null.
export const unsupportedPresetId = (config) => {
  const id = config.get(APPEARANCE_KEY)

  return id === undefined || id === NO_OVERRIDE || isKnown(id) ? null : id
}

// Reads the kept choices from the settings into the state, ends any preview and does what the settings from before the policy need once (`config` is the settings store). A saved section accent mode is applied (an unknown one reads as `on`). A saved policy is applied, and a named appearance this version has replaces the theme. The id of a baseline under APPEARANCE_KEY is the older form of a policy: it becomes the policy, replacing a stored one, and is written back as the policy with `theme` under APPEARANCE_KEY. A file with neither and only the older boolean `darkMode` gets the policy of that mode written the same way; `darkMode` stays in the file and is not read again once a policy is there. A named appearance without a stored policy takes the mode of that appearance as the policy, with no write: the settings stay as they are until a choice is made. A saved id this version doesn't have (a preset from a newer version, a damaged value) is left in the settings and not overwritten, and the policy draws instead. A failed write of the migration is reported and costs only a repeat at the next start.
export const adoptAppearance = (config) => {
  const accents = config.get(ACCENTS_KEY)

  state.accents = ACCENT_MODES.includes(accents) ? accents : DEFAULT_ACCENT_MODE

  const stored = config.get(APPEARANCE_KEY)
  const legacy = config.get('darkMode')
  let policy = storedPolicy(config)
  let override = null
  let migrate = false

  if (hasOwn(BASELINE_BY_MODE, stored)) {
    policy = stored
    migrate = true
  } else if (stored === undefined) {
    if (policy === null && typeof legacy === 'boolean') {
      policy = legacy ? 'dark' : 'light'
      migrate = true
    }
  } else if (stored !== NO_OVERRIDE && isKnown(stored)) {
    override = stored
    policy = policy || resolveAppearance(stored).mode
  }

  state.policy = policy || DEFAULT_POLICY
  state.override = override
  settle()
  cancelPreview()

  if (migrate) {
    try {
      config.update((store) => ({ ...store, [POLICY_KEY]: state.policy, [APPEARANCE_KEY]: NO_OVERRIDE }))
    } catch (error) {
      console.error("Couldn't write the theme policy to the settings", error)
    }
  }
}

// Reads the settings at start: the typeface and text size (`loadFont`), the kept imported appearance and the choices (`adoptAppearance`). The kept imported appearance is read back through the parser whenever there is one, so the card is there beside the presets; one that no longer passes (a file from a newer version, a damaged value) is not loaded, is left in the settings as it is and is reported by `importedAppearances().problem`.
export const loadAppearance = (config) => {
  loadFont(config)

  const document = config.get(CUSTOM_KEY)
  const parsed = document === undefined ? null : parseAppearanceFile(JSON.stringify(document), { builtIn: (id) => (hasOwn(PRESETS, id) ? resolveAppearance(id) : null), baselines: BASELINE_BY_MODE })

  imported.custom = parsed && parsed.ok ? register(CUSTOM_ID, parsed) : null
  imported.problem = parsed && !parsed.ok ? { errors: parsed.errors, omitted: parsed.omitted } : null

  adoptAppearance(config)
}

// The colour scheme query of the operating system: `prefers-color-scheme`, which Electron's `nativeTheme` drives and a browser takes from the system.
export const SYSTEM_QUERY = '(prefers-color-scheme: dark)'

let following = null

// How many times the system's scheme was read (`followSystem`), and how many requests of the native theme were made (`requestNativeTheme`): a reply of the main process is used only when nothing newer has happened since its request.
let observations = 0
let nativeRequests = 0

// Starts following the operating system's colour scheme: `media` is the `MediaQueryList` of SYSTEM_QUERY. The scheme is read now and on every change, and only the System policy draws with it: a pinned policy and a named appearance stay as they are, and nothing is written to the settings. One observer at a time (a second start ends the first). Returns `{ refresh(dark?), stop() }`: `refresh` re-reads the scheme (from `dark` when the caller knows it better than the query does) and `stop` removes the listener.
export const followSystem = (media) => {
  if (following) {
    following.stop()
  }

  const read = (dark = media.matches) => {
    observations++
    state.system = dark ? 'dark' : 'light'
    settle()
  }
  // A change is read only while the native theme is left to the system. Otherwise the scheme the query reports is the one the app asked for (`nativeThemeSource`), not the system's, and the last scheme read from the system is kept.
  const onChange = (event) => {
    if (nativeThemeSource() === SYSTEM) {
      read(event.matches)
    }
  }
  const handle = {
    refresh: read,
    stop: () => {
      media.removeEventListener('change', onChange)

      if (following === handle) {
        following = null
      }
    },
  }

  read()
  media.addEventListener('change', onChange)
  following = handle

  return handle
}

// What the application's native theme (the window frame, the native dialogs, and the `prefers-color-scheme` the renderer sees) is asked to be: the mode of the named appearance in force, else the pinned policy, else `system`. The native parts then match the colours drawn, and the query reports the system's scheme only while the System policy is drawing with it. A named appearance does not read the system, so asking for its mode costs nothing; once it ends, `system` is asked for again and the scheme is read anew (the main process answers with the system's own, and the layout refreshes `followSystem` from it). A preview does not change it. Reactive.
export const nativeThemeSource = () => (state.override ? resolveAppearance(state.override).mode : state.policy)

// What the app bar's lamp does now: it applies the opposite of the mode drawn now as an explicit `light` or `dark` policy, which also ends System or a named appearance. `mode` is that opposite and `replaces` what ends with it (the name of the named appearance, `System`, or null for a pinned policy). Reactive.
export const quickSwitch = () => ({ mode: activeAppearance().mode === 'dark' ? 'light' : 'dark', replaces: state.override ? resolveAppearance(state.override).name : state.policy === SYSTEM ? 'System' : null })

// Asks for the native theme the kept choices call for (`nativeThemeSource`) through `invoke(source)`, which gives the main process's answer (`{ dark }`, whether the system is dark now) or null, and, once the system is asked for, reads the scheme anew from the answer. A reply is used only while it is the latest request, the source it asked for is still the one wanted and the observer has read nothing since the request; otherwise a newer reading or request holds the truth and the reply is dropped. With no usable answer the scheme is read from the query. Gives the source asked for.
export const requestNativeTheme = (invoke) => {
  const source = nativeThemeSource()
  const request = ++nativeRequests
  const seen = observations

  return Promise.resolve(invoke(source)).then((answer) => {
    if (source === SYSTEM && following && request === nativeRequests && nativeThemeSource() === SYSTEM && observations === seen) {
      following.refresh(answer && typeof answer.dark === 'boolean' ? answer.dark : undefined)
    }

    return source
  })
}

// The baseline preset of a mode.
export const baselinePresetId = (mode) => BASELINE_BY_MODE[mode]

// Vuetify's own text colours of each theme: what a component of the theme the preset is not based on (a `dark` toolbar, chip or button on a light preset) keeps drawing.
const VUETIFY_TEXT = { light: { text: 'rgba(0, 0, 0, 0.87)', muted: 'rgba(0, 0, 0, 0.6)' }, dark: { text: '#ffffff', muted: 'rgba(255, 255, 255, 0.7)' } }

// The CSS custom properties the app's styles read, for the root element (`:style` on `v-app`). `--ae-text-light`, `--ae-text-dark` and their `-muted` pairs are the colours Vuetify's components of each theme draw their text in: the preset's `inks.text` and `inks.textMuted` on its own theme, Vuetify's on the other.
export const appearanceStyle = ({ mode, surfaces, inks, focus, rows, space, status }) => ({
  '--ae-bg': surfaces.background,
  '--ae-chrome': surfaces.chrome,
  '--ae-card': surfaces.card,
  '--ae-border': surfaces.border,
  '--ae-track': surfaces.track,
  '--ae-track-soft': surfaces.trackSoft,
  '--ae-rule': surfaces.rule,
  '--ae-ink': inks.body,
  '--ae-muted': inks.muted,
  '--ae-on-fill': inks.onFill,
  '--ae-on-color': inks.onColor,
  '--ae-on-snackbar': inks.onSnackbar,
  '--ae-text-light': mode === 'light' ? inks.text : VUETIFY_TEXT.light.text,
  '--ae-text-muted-light': mode === 'light' ? inks.textMuted : VUETIFY_TEXT.light.muted,
  '--ae-text-dark': mode === 'dark' ? inks.text : VUETIFY_TEXT.dark.text,
  '--ae-text-muted-dark': mode === 'dark' ? inks.textMuted : VUETIFY_TEXT.dark.muted,
  '--ae-primary': focus.primary,
  '--ae-hover': focus.hover,
  '--ae-row-selected': rows.selected,
  '--ae-row-differs': rows.differs,
  '--ae-row-differs-mark': rows.differsMark,
  '--ae-row-differs-dot': rows.differsDot,
  '--ae-row-stripe': rows.stripe,
  '--ae-row-stripe-soft': rows.stripeSoft,
  '--ae-space-ink': space.label,
  '--ae-space-shadow': space.labelShadow,
  '--ae-shortfall': status.shortfall,
  ...(focus.linkLine ? { '--ae-link-line': focus.linkLine } : {}),
})

// The colours Vuetify's theme takes for the appearance's mode: its named colours, `error`, `warning`, `info` and `success` being the severities.
export const vuetifyColors = ({ focus, severity }) => ({
  primary: focus.primary,
  secondary: focus.secondary,
  accent: focus.accent,
  error: severity.action,
  warning: severity.attention,
  info: severity.info,
  success: severity.success,
})

// The colour of a tone: a name Vuetify's theme has (`success`, `info`, `warning`, `error`, `primary`), else a key of the appearance's `plan` or `status` roles. A name that is none of those comes back as it is, so a CSS colour passes through.
export const toneColor = (appearance, tone) => vuetifyColors(appearance)[tone] || appearance.plan[tone] || appearance.status[tone] || tone
