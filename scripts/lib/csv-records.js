/*
  The records of a CSV as a strict reader takes them (RFC 4180): a carriage return, a line feed or both outside quotes end a record, a cell in quotes keeps them and a doubled quote is one. A writer that leaves a bare carriage return unquoted therefore splits a record in this reader, which a reader that only splits on line feeds does not show.
*/
const strictRecords = (text) => {
  const records = []
  let record = []
  let cell = ''
  let quoted = false

  for (let index = 0; index < text.length; index++) {
    const character = text[index]

    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        cell += '"'
        index++
      } else if (character === '"') {
        quoted = false
      } else {
        cell += character
      }
    } else if (character === '"') {
      quoted = true
    } else if (character === ',') {
      record.push(cell)
      cell = ''
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && text[index + 1] === '\n') {
        index++
      }

      record.push(cell)
      records.push(record)
      record = []
      cell = ''
    } else {
      cell += character
    }
  }

  if (cell !== '' || record.length) {
    record.push(cell)
    records.push(record)
  }

  return records
}

module.exports = { strictRecords }
