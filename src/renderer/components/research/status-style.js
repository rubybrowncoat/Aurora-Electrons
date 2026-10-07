import { chartTheme, withAlpha } from '../charts/theme'
import { ACTIVE, AVAILABLE, BLOCKED, DONE, LOCKED, QUEUED } from '../../utilities/research'

// One colour per research status, from the chart palette: researched blue, running and queued orange,
// available teal; locked and out-of-reach techs recede to the muted ink and the border. Shapes carry the
// same meaning (filled, hatched, ringed, hollow, dashed) so colour is never the only cue.
export const statusColors = (dark) => {
  const theme = chartTheme(dark)
  const [blue, orange, teal] = theme.categorical

  return { [DONE]: blue, [ACTIVE]: orange, [QUEUED]: orange, [AVAILABLE]: teal, [LOCKED]: theme.inkMuted, [BLOCKED]: theme.border }
}

// The same colours as custom properties for the components' CSS.
export const statusStyle = (dark) => {
  const colors = statusColors(dark)

  return {
    '--st-done': colors[DONE],
    '--st-active': colors[ACTIVE],
    '--st-available': colors[AVAILABLE],
    '--st-available-soft': withAlpha(colors[AVAILABLE], dark ? 0.28 : 0.18),
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
