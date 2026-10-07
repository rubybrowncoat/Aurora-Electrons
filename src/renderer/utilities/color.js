import ColorHash from 'color-hash'

const hasher = new ColorHash({ lightness: [0.3, 0.4, 0.5], saturation: [0.35, 0.5, 0.65] })
const darkHasher = new ColorHash({ lightness: [0.4, 0.5, 0.6], saturation: [0.45, 0.6, 0.75] })

// A stable colour for a string, readable behind white text in either theme.
export const hashColor = (text, dark) => (dark ? darkHasher.hex(text) : hasher.hex(text))
