// The letters that no Unicode decomposition reduces to a Latin letter, as a file name spells them.
const LETTERS = { æ: 'ae', ø: 'o', œ: 'oe', ß: 'ss', đ: 'd', ð: 'd', ł: 'l', þ: 'th', ı: 'i' }

// The longest a slug may be. The longest name built around one (a branch of the ground structure: `-ground-structure-formation-<id>.md`; the preferences export: `aurora-electrons-preferences-…-<date>.json`) then stays near a hundred characters, well within the 255 a file system allows and the shorter paths a browser's download or Windows will take.
export const SLUG_LIMIT = 60

// A name made part of a file name, as the exports name their files: lower case, an accented letter as its plain letter (the decomposition with its marks dropped, or the spelling above), each run of other characters a hyphen, none at either end, and cut to SLUG_LIMIT at the last hyphen that fits (a single word longer than that is cut at the limit). Empty when nothing of the name is left (a name with no Latin letter or digit), which the caller replaces.
export const fileSlug = (name) => {
  const slug = String(name ?? '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036F]/g, '').replace(/[æøœßđðłþı]/g, (letter) => LETTERS[letter]).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

  if (slug.length <= SLUG_LIMIT) {
    return slug
  }

  const end = slug.lastIndexOf('-', SLUG_LIMIT)

  return slug.slice(0, end > 0 ? end : SLUG_LIMIT)
}
