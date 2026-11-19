const test = require('node:test');
const assert = require('node:assert/strict');
const { safeFileName } = require('./pdf-export.cjs');

test('file names are cleaned and always end in .pdf', () => {
  assert.equal(safeFileName('ArmUp report - Asha'), 'ArmUp report - Asha.pdf');
  assert.equal(safeFileName('../../etc/passwd'), 'etcpasswd.pdf');
  assert.equal(safeFileName('report.pdf'), 'report.pdf');
  assert.equal(safeFileName(''), 'ArmUp-report.pdf');
  assert.equal(safeFileName(undefined), 'ArmUp-report.pdf');
  assert.equal(safeFileName('a'.repeat(200)).length, 84);
});
