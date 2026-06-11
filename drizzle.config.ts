import { defineConfig } from 'drizzle-kit';
import path from 'path';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/database/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_PATH || path.join(process.cwd(), 'captain-stats.db'),
  },
  migrations: {
    prefix: 'timestamp',
  },
  strict: true,
  verbose: true,
});
