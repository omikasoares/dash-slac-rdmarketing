require('dotenv').config();
const { runSheetSync } = require('../lib/sheets-sync');

runSheetSync()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('Sync da planilha falhou:', e);
    process.exit(1);
  });
