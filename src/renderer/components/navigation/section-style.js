import { accentMode, activeAppearance } from '../../utilities/appearance'
import { sectionColor, sectionText } from '../../utilities/appearance-contrast'
import { withAlpha } from '../charts/theme'

// The CSS custom properties that colour a navigation element for a section: `--sc` the section colour (its accent of the appearance in the accent mode in force: its own, softened, or the neutral one) for icons, bars, borders and washes, `--sc-text` the same colour made readable for text (4.5:1 on the surfaces text sits on), `--sc-soft` an active wash, `--sc-tint` a hover wash. Without a section (settings), the appearance's neutral accent. Without an appearance, the one in force.
export const sectionStyle = (appearance = activeAppearance(), section, mode = accentMode()) => {
  const { washes } = appearance
  const color = sectionColor(appearance, section, mode)

  return {
    '--sc': color,
    '--sc-text': sectionText(appearance, section, mode),
    '--sc-soft': withAlpha(color, washes.sectionSoft),
    '--sc-tint': withAlpha(color, washes.sectionTint),
  }
}
