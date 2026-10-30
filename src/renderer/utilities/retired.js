// What a read, a write or a transaction on a database that has been replaced is refused with (utilities/database.js `retireDatabase`). It is not a failure of the save: the work belonged to the copy the app has left, and whoever asked is told by `retired` (never by the message) that its answer is no longer wanted.
export class DatabaseRetired extends Error {
  // `cause` is the error the statement ended with when the retiring cut it off (an interrupted statement), kept for whoever debugs it.
  constructor (cause) {
    super('The save was reloaded; this read belongs to the old copy', cause ? { cause } : undefined)
    this.name = 'DatabaseRetired'
    this.retired = true
  }
}

export const isRetired = (error) => Boolean(error && error.retired === true)
