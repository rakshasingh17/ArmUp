/*
 * reset-password.cjs -- set a new password for one account.
 *
 *   node reset-password.cjs "<path to armup.db>" "<account name>" "<new password>"
 *
 * Put this file in the armup-dashboard folder and run it from there. Close the
 * ArmUp app first. The database path is printed in the terminal when the app
 * starts, on the line that begins "[armup] database:".
 */
const fs = require('node:fs');
const db = require('./electron/db.cjs');

const [dbPath, name, newPassword] = process.argv.slice(2);
if (!dbPath || !name || !newPassword) {
  console.error('Usage: node reset-password.cjs "<path to armup.db>" "<account name>" "<new password>"');
  process.exit(1);
}
if (!fs.existsSync(dbPath)) {
  console.error(`No database at: ${dbPath}\nCheck the "[armup] database:" line printed when the app starts.`);
  process.exit(1);
}
if (newPassword.length < 6) {
  console.error('The new password must be at least 6 characters.');
  process.exit(1);
}

db.openDb(dbPath);
const user = db.getUserByName(name);
if (!user) {
  console.error(`No account named "${name}". Accounts in this database:`);
  for (const p of db.listPatientSummaries()) console.error(`  ${p.name} (patient)`);
  console.error('  (therapist names are not listed; type yours exactly as you signed up)');
  process.exit(1);
}
db.setPassword(user.id, newPassword);
console.log(`Done. "${user.name}" (${user.role}) can now log in with the new password.`);
