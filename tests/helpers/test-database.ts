import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as schema from '#src/database/schema.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export type TestDatabase = {
  db: ReturnType<typeof drizzle>;
  sqlite: Database.Database;
  close: () => void;
};

/**
 * Standard test database setup - ALWAYS in-memory, ALWAYS migrated
 */
export function createTestDatabase(): TestDatabase {
  const sqlite = new Database(':memory:');
  const db = drizzle(sqlite, { schema });

  // Run migrations
  const migrationsFolder = resolve(__dirname, '../../drizzle');
  migrate(db, { migrationsFolder });

  return {
    db,
    sqlite,
    close: () => sqlite.close(),
  };
}
