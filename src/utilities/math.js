export const roundToDecimal = (number, decimals = 0) => {
  return Math.round(number * Math.pow(10, decimals)) / Math.pow(10, decimals)
}

export const floorToDecimal = (number, decimals = 0) => {
  return Math.floor(number * Math.pow(10, decimals)) / Math.pow(10, decimals)
}

export const ceilToDecimal = (number, decimals = 0) => {
  return Math.ceil(number * Math.pow(10, decimals)) / Math.pow(10, decimals)
}

export const separatedNumber = (number, separator = `'`) => {
  return number.toString().replace(/\B(?<!\.\d*)(?=(\d{3})+(?!\d))/g, separator);
}
