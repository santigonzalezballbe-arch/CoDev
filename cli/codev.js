#!/usr/bin/env node
// Punt d'entrada de la CLI de CoDev.
import { findConfig, api, teamSummary } from './config.js';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      args[k] = v ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true);
    } else args._.push(a);
  }
  return args;
}

const HELP = `CoDev — programa en equip amb IA sense trepitjar-vos

Ordres:
  codev server [--port 4321]                       Arrenca el servidor i la web
  codev init --room <sala> --name <nom> [--server URL]
                                                   Connecta aquest projecte a una sala (hooks + MCP)
  codev status                                     Mostra què fan els companys
  codev watch                                      Publica canvis del disc (per a IA sense hooks)
  codev hook                                       (intern) l'executen els hooks de Claude Code
  codev mcp                                        (intern) servidor MCP per stdio
`;

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];

switch (cmd) {
  case 'server': {
    const { startServer } = await import('../server/server.js');
    const port = Number(args.port || process.env.PORT || 4321);
    await startServer({ port, host: args.host || '0.0.0.0' });
    console.log(`CoDev en marxa a http://localhost:${port}`);
    break;
  }
  case 'init': {
    const { runInit } = await import('./init.js');
    await runInit(args);
    break;
  }
  case 'hook': {
    const { runHook } = await import('./hook.js');
    await runHook();
    break;
  }
  case 'mcp': {
    const { runMcp } = await import('./mcp.js');
    runMcp();
    break;
  }
  case 'watch': {
    const { runWatch } = await import('./watch.js');
    runWatch();
    break;
  }
  case 'status': {
    const cfg = findConfig();
    if (!cfg) {
      console.error('No hi ha .codev.json. Executa `codev init`.');
      process.exit(1);
    }
    const state = await api(cfg, 'state');
    console.log(teamSummary(cfg, state, { maxEvents: 10 }) || 'No hi ha cap company a la sala.');
    break;
  }
  default:
    console.log(HELP);
}
