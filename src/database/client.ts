import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import * as schema from './schema.js';
import path from 'path';
import fs from 'fs';

// Export Database type for external use
export type DatabaseInstance = Database.Database;

/**
 * Get the database path from environment or use default
 */
export function getDatabasePath(): string {
  const dbPath = process.env.DATABASE_PATH || path.join(process.cwd(), 'captain-stats.db');

  // Ensure parent directory exists
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  return dbPath;
}

/**
 * Database connection result
 */
export interface DatabaseConnection {
  db: BetterSQLite3Database<typeof schema>;
  sqlite: DatabaseInstance;
}

/**
 * Create and configure SQLite database connection
 */
export function createDatabase(dbPath?: string): DatabaseConnection {
  const actualPath = dbPath || getDatabasePath();

  // Create better-sqlite3 connection
  const sqlite = new Database(actualPath);

  // Enable WAL mode for better concurrency
  sqlite.pragma('journal_mode = WAL');

  // Enable foreign key constraints
  sqlite.pragma('foreign_keys = ON');

  // Create Drizzle instance with schema
  const db = drizzle(sqlite, { schema });

  return { db, sqlite };
}

// Singleton instance for application use
let dbInstance: DatabaseConnection | null = null;

/**
 * Get or create the singleton database instance
 */
export function getDatabase(): DatabaseConnection {
  if (!dbInstance) {
    dbInstance = createDatabase();
  }
  return dbInstance;
}

/**
 * Close the database connection (for graceful shutdown)
 */
export function closeDatabase() {
  if (dbInstance) {
    dbInstance.sqlite.close();
    dbInstance = null;
  }
}

// Export the db instance for convenience
export const { db } = getDatabase();
