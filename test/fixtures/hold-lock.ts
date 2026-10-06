// Holds the store's write lock from a separate OS process for argv[3] ms, then releases it.
// Prints "locked" once BEGIN IMMEDIATE has succeeded.
import { DatabaseSync } from 'node:sqlite'

const db = new DatabaseSync(process.argv[2])
db.exec('PRAGMA busy_timeout = 10000')
db.exec('BEGIN IMMEDIATE')
process.stdout.write('locked\n')
setTimeout(() => { db.exec('COMMIT'); db.close() }, Number(process.argv[3]))
