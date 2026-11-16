import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// process.env (not Prisma's strict env() helper) lets `prisma generate` run without a
// database URL; commands that connect, such as `prisma migrate`, still report it missing.
// https://www.prisma.io/docs/v7/prisma-orm/add-to-existing-project/postgresql
const url = process.env['DATABASE_URL'];

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: url === undefined ? {} : { url },
});
