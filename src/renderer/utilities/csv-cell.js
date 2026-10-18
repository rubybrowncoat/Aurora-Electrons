// One cell of a CSV, written the way every export of the app writes it. A text that holds a quote, a comma, a carriage return or a line feed is quoted with its quotes doubled; an empty value (null or undefined) is an empty cell, never 0 or the word null; a number is left as it is. With `guard` (the default) a text that starts with a character a spreadsheet reads as the start of a formula (`=`, `+`, `-`, `@`, a tab or a carriage return) is written with a leading apostrophe, so it is shown as text and never run. A column of numbers is written with `guard: false`, so a negative figure stays a number.

const FORMULA_START = /^[=+\-@\t\r]/

export const csvCell = (value, { guard = true } = {}) => {
  const text = guard && typeof value === 'string' && FORMULA_START.test(value) ? `'${value}` : value

  return typeof text === 'string' && /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text === null || text === undefined ? '' : text
}

// A line of cells joined with commas.
export const csvLine = (values, options) => values.map((value) => csvCell(value, options)).join(',')
