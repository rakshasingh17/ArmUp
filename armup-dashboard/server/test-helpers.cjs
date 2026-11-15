/*
 * test-helpers.cjs -- shared by the test files.
 * Tests wipe their database, so this refuses to touch one whose name does not
 * contain "test" (a safety net against pointing it at the real Neon database).
 */
const { Client } = require('pg');

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL || 'postgresql://postgres@127.0.0.1:5433/armup_test';

async function resetTestDatabase() {
  const dbName = new URL(TEST_DATABASE_URL).pathname.replace(/^\//, '');
  if (!/test/i.test(dbName)) {
    throw new Error(`Refusing to wipe database "${dbName}": its name must contain "test".`);
  }
  const client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  try {
    await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  } finally {
    await client.end();
  }
}

module.exports = { resetTestDatabase, TEST_DATABASE_URL };
