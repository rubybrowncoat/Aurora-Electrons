import { activeAppearance, asAppearance } from '../../utilities/appearance'
import { withAlpha } from '../charts/theme'

// The CSS custom properties that colour a navigation element for a section: `--sc` the section colour (its slot of the appearance's categorical list), `--sc-soft` an active wash, `--sc-tint` a hover wash. Without a section (settings), the appearance's neutral accent. Without an appearance, the one in force; a caller that has not moved over yet passes the dark flag.
export const sectionStyle = (appearance = activeAppearance(), section) => {
  const { charts, sections, washes } = asAppearance(appearance)
  const color = section ? charts.categorical[section.slot] : sections.neutral

  return {
    '--sc': color,
    '--sc-soft': withAlpha(color, washes.sectionSoft),
    '--sc-tint': withAlpha(color, washes.sectionTint),
  }
}
