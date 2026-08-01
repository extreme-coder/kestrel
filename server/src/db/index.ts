import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import Database from 'better-sqlite3'

import { SCHEMA_SQL } from './schema.js'

export type DB = Database.Database

/**
 * Open a database and bring it up to schema.
 *
 * Pass `':memory:'` (the default) for tests — every suite gets an isolated database
 * with no files to clean up.
 */
export function openDatabase(path = ':memory:'): DB {
  // better-sqlite3 refuses to create a file in a directory that does not exist.
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true })
  }

  const db = new Database(path)

  // Foreign keys are off by default in SQLite; without this, the ON DELETE CASCADE
  // from annealing_points to area_requests silently does nothing.
  db.pragma('foreign_keys = ON')

  if (path !== ':memory:') {
    // WAL lets the SSE readers and the annealing worker touch the database
    // concurrently without blocking each other.
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
  }

  db.exec(SCHEMA_SQL)
  return db
}
