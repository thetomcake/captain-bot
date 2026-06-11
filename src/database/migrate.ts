import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { createDatabase, getDatabasePath } from './client';
import path from 'path';

/**
 * Run pending database migrations
 */
export async function runMigrations() {
  console.log('Running database migrations...');

  const dbPath = getDatabasePath();
  console.log(`Database: ${dbPath}`);

  const { db, sqlite } = createDatabase(dbPath);

  try {
    // Run migrations from the drizzle folder
    const migrationsFolder = path.join(process.cwd(), 'drizzle');
    console.log(`Migrations folder: ${migrationsFolder}`);

    migrate(db, { migrationsFolder });

    console.log('✓ Migrations completed successfully');
  } catch (error) {
    console.error('✗ Migration failed:', error);
    throw error;
  } finally {
    sqlite.close();
  }
}

/**
 * CLI entry point for running migrations
 */
const isMainModule = import.meta.url === `file://${process.argv[1]}`;

if (isMainModule) {
  runMigrations()
    .then(() => {
      console.log('Done!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('Failed:', error);
      process.exit(1);
    });
}
