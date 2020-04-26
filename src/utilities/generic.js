export const convertDisplayBase = (value, toBase) => {
  const range = '#ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.split('')
  const toRange = range.slice(0, toBase)

  let decimlValue = value
  let newValue = ''
  while (decimlValue > 0) {
    newValue = toRange[decimlValue % toBase] + newValue
    decimlValue = (decimlValue - (decimlValue % toBase)) / toBase
  }
  
  return newValue || '0'
}
