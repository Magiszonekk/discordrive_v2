const { config } = require('dotenv');
const { resolve } = require('path');
const { execSync } = require('child_process');

config({ path: resolve(__dirname, '..', '..', '.env') });
const port = process.env.FRONTEND_PORT || 3001;
const cmd = process.argv[2] || 'dev';
execSync(`npx next ${cmd} -p ${port}`, { stdio: 'inherit' });
