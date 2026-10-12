import { chartTheme, withAlpha } from '../charts/theme'
import { activeAppearance } from '../../utilities/appearance'
import { ACTIVE, AVAILABLE, BLOCKED, DONE, LOCKED, QUEUED } from '../../utilities/research'

// One colour per research status, from the chart palette: researched blue, running and queued orange, available teal; locked techs recede to the muted ink and out-of-reach ones to the inactive standing's grey, both 3:1 or more on every surface (scripts/check-contrast.js; the axis colour is a decorative hairline and does not). Shapes carry the same meaning (filled, hatched, ringed, hollow, dashed) and so do the icons below, so colour is never the only cue. The warnings' severities (icon per level), the Galaxy Map's contact relationships (shape inside the disc), the selected row (a bar on its left edge) and the compared row that differs (a mark and a dot) follow the same rule: a shape or icon besides the colour.
export const statusColors = (appearance) => {
  const theme = chartTheme(appearance)
  const [blue, orange, teal] = theme.categorical

  return { [DONE]: blue, [ACTIVE]: orange, [QUEUED]: orange, [AVAILABLE]: teal, [LOCKED]: theme.inkMuted, [BLOCKED]: appearance.status.inactive }
}

// The same colours as custom properties for the components' CSS, from a resolved appearance (the one in force without an argument).
export const statusStyle = (appearance = activeAppearance()) => {
  const colors = statusColors(appearance)

  return {
    '--st-done': colors[DONE],
    '--st-active': colors[ACTIVE],
    '--st-available': colors[AVAILABLE],
    '--st-available-soft': withAlpha(colors[AVAILABLE], appearance.washes.statusSoft),
    '--st-locked': colors[LOCKED],
    '--st-blocked': colors[BLOCKED],
  }
}

export const STATUS_ICONS = {
  [DONE]: 'mdi-check-circle',
  [ACTIVE]: 'mdi-flask',
  [QUEUED]: 'mdi-timer-sand',
  [AVAILABLE]: 'mdi-circle-outline',
  [LOCKED]: 'mdi-lock-outline',
  [BLOCKED]: 'mdi-cancel',
}
