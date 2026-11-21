// "codev watch": per a IA sense hooks (Cursor, Copilot...). Observa el disc i publica els canvis.
import fs from 'node:fs';
import { findConfig, api } from './config.js';

const IGNORED = /(^|\/)(\.git|node_modules|\.next|dist|build|\.venv|__pycache__|graphify-out)(\/|$)|(^|\/)\.codev\.json$|~$|\.swp$/;

export function runWatch() {
  const cfg = findConfig();
  if (!cfg) {
    console.error('No hi ha .codev.json. Executa primer `codev init`.');
    process.exit(1);
  }
  const timers = new Map();
  console.log(`CoDev observa ${cfg.root} → sala "${cfg.room}" com a ${cfg.name}`);

  fs.watch(cfg.root, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    const rel = filename.split('\\').join('/');
    if (IGNORED.test(rel)) return;
    clearTimeout(timers.get(rel));
    timers.set(
      rel,
      setTimeout(async () => {
        timers.delete(rel);
        const exists = fs.existsSync(`${cfg.root}/${rel}`);
        if (exists && fs.statSync(`${cfg.root}/${rel}`).isDirectory()) return;
        try {
          await api(cfg, 'activity', {
            kind: 'edit',
            tool: 'watch',
            summary: exists ? `Ha modificat ${rel}` : `Ha esborrat ${rel}`,
            files: [rel],
            checkClaims: true,
          });
          console.log(`  ↑ ${rel}`);
        } catch (err) {
          console.error(`  ✗ ${rel}: ${err.message}`);
        }
      }, 1200)
    );
  });
}
