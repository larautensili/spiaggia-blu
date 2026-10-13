/**
 * Entry point per SpiaggiaBlu.exe (pkg)
 * Imposta percorsi relativi alla cartella dell'eseguibile.
 */
const path = require('path');
const fs = require('fs');

const isPkg = typeof process.pkg !== 'undefined';
// Con pkg: cartella dell'.exe; altrimenti cartella di questo file (backend/)
const baseDir = isPkg ? path.dirname(process.execPath) : path.join(__dirname, '..');
const backendDir = isPkg ? path.join(baseDir, 'backend') : __dirname;
const frontendDir = path.join(baseDir, 'frontend');
const dbDir = path.join(backendDir, 'db');

fs.mkdirSync(dbDir, { recursive: true });
fs.mkdirSync(path.join(frontendDir, 'uploads'), { recursive: true });

process.env.SPIAGGIA_FRONTEND = frontendDir;
process.env.SPIAGGIA_DB = dbDir;
process.chdir(backendDir);

// Carica .env da backend se presente
const envPath = path.join(backendDir, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim();
  });
}

// server.js è sempre sul filesystem (cartella backend/), non dentro lo snapshot
require(path.join(backendDir, 'server.js'));
