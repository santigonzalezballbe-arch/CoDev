// "codev watch": for AIs without hooks (Cursor, Copilot...). Watches the disk and publishes changes.
import fs from 'node:fs';
import { findConfig, api } from './config.js';

const IGNORED = /(^|\/)(\.git|node_modules|\.next|dist|build|\.venv|__pycache__|graphify-out)(\/|$)|(^|\/)\.codev\.json$|~$|\.swp$/;

export function runWatch() {
  const cfg = findConfig();
  if (!cfg) {
    console.error('No .codev.json found. Run `codev init` first.');
    process.exit(1);
  }
  const timers = new Map();
  console.log(`CoDev is watching ${cfg.root} → room "${cfg.room}" as ${cfg.name}`);

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
            summary: exists ? `Changed ${rel}` : `Deleted ${rel}`,
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
