import { chartTheme, withAlpha } from '../charts/theme'

const NEUTRAL = { light: '#546e7a', dark: '#90a4ae' }

// The CSS custom properties that colour a navigation element for a section: `--sc` the section
// colour, `--sc-soft` an active wash, `--sc-tint` a hover wash. Without a section (settings), a neutral blue-grey.
export const sectionStyle = (dark, section) => {
  const color = section ? chartTheme(dark).categorical[section.slot] : NEUTRAL[dark ? 'dark' : 'light']

  return {
    '--sc': color,
    '--sc-soft': withAlpha(color, dark ? 0.2 : 0.14),
    '--sc-tint': withAlpha(color, dark ? 0.12 : 0.08),
  }
}
