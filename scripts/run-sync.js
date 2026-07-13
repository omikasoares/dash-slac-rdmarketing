require('dotenv').config();
const { runSync } = require('../lib/sync');

runSync()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('Sync falhou:', e);
    process.exit(1);
  });
