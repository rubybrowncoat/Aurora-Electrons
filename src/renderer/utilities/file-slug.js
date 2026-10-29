// The letters that no Unicode decomposition reduces to a Latin letter, as a file name spells them.
const LETTERS = { æ: 'ae', ø: 'o', œ: 'oe', ß: 'ss', đ: 'd', ð: 'd', ł: 'l', þ: 'th', ı: 'i' }

// A name made part of a file name, as the exports name their files: lower case, an accented letter as its plain letter (the decomposition with its marks dropped, or the spelling above), each run of other characters a hyphen, none at either end. Empty when nothing of the name is left (a name with no Latin letter or digit), which the caller replaces.
export const fileSlug = (name) => String(name ?? '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036F]/g, '').replace(/[æøœßđðłþı]/g, (letter) => LETTERS[letter]).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
