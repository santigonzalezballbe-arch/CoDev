// Servidor MCP mínim (JSON-RPC per stdio) perquè la IA pugui consultar l'equip i coordinar-se.
import readline from 'node:readline';
import { findConfig, toProjectPath, api, teamSummary } from './config.js';

const TOOLS = [
  {
    name: 'codev_team_status',
    description: "Mostra què fan ara les IA dels teus companys: tasca actual, fitxers reclamats i activitat recent. Consulta-ho abans de començar una tasca gran.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'codev_claim_files',
    description: "Reclama fitxers abans de treballar-hi perquè cap company els toqui. Retorna els que ja són d'algú altre.",
    inputSchema: {
      type: 'object',
      properties: {
        files: { type: 'array', items: { type: 'string' }, description: 'Rutes dels fitxers (relatives al projecte o absolutes)' },
        intent: { type: 'string', description: 'Què hi faràs, en una frase' },
      },
      required: ['files'],
    },
  },
  {
    name: 'codev_release_files',
    description: 'Allibera fitxers que ja no necessites (o tots, si no en passes cap) perquè els companys hi puguin treballar.',
    inputSchema: { type: 'object', properties: { files: { type: 'array', items: { type: 'string' } } } },
  },
  {
    name: 'codev_send_note',
    description: "Envia una nota a un company (o a tot l'equip) que la veurà a la pantalla i la rebrà la seva IA. Útil per demanar un fitxer o avisar d'un canvi d'interfície.",
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        to: { type: 'string', description: "Nom del company. Buit = tot l'equip" },
      },
      required: ['text'],
    },
  },
  {
    name: 'codev_set_intent',
    description: "Anuncia a l'equip el pla o la tasca en què treballes ara.",
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
];

async function callTool(cfg, name, args = {}) {
  if (!cfg) return 'CoDev no està configurat en aquest projecte. Executa `codev init` a l\'arrel del projecte.';
  const files = (args.files || []).map((f) => toProjectPath(cfg, f) || f);
  switch (name) {
    case 'codev_team_status': {
      const state = await api(cfg, 'state');
      return teamSummary(cfg, state, { maxEvents: 12 }) || 'Ara mateix no hi ha cap company a la sala.';
    }
    case 'codev_claim_files': {
      const { claimed, conflicts } = await api(cfg, 'claim', { files, intent: args.intent });
      let text = claimed.length ? `Reclamats: ${claimed.join(', ')}.` : 'No s\'ha reclamat cap fitxer.';
      for (const c of conflicts) text += `\nOCUPAT: ${c.file} és de ${c.owner}${c.intent ? ` (${c.intent})` : ''}. No el modifiquis.`;
      return text;
    }
    case 'codev_release_files':
      await api(cfg, 'release', args.files?.length ? { files } : {});
      return args.files?.length ? `Alliberats: ${files.join(', ')}` : 'Tots els teus fitxers s\'han alliberat.';
    case 'codev_send_note':
      await api(cfg, 'note', { text: args.text, to: args.to || null, from: 'ai' });
      return `Nota enviada${args.to ? ` a ${args.to}` : " a l'equip"}.`;
    case 'codev_set_intent':
      await api(cfg, 'intent', { text: args.text });
      return 'Tasca anunciada a l\'equip.';
    default:
      throw Object.assign(new Error(`Eina desconeguda: ${name}`), { code: -32602 });
  }
}

export function runMcp() {
  const cfg = findConfig();
  const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
  const rl = readline.createInterface({ input: process.stdin });

  rl.on('line', async (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id === undefined || msg.id === null) return; // notificacions: no responem

    try {
      let result;
      switch (msg.method) {
        case 'initialize':
          result = {
            protocolVersion: msg.params?.protocolVersion || '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'codev', version: '0.1.0' },
          };
          break;
        case 'ping':
          result = {};
          break;
        case 'tools/list':
          result = { tools: TOOLS };
          break;
        case 'tools/call':
          try {
            const text = await callTool(cfg, msg.params?.name, msg.params?.arguments);
            result = { content: [{ type: 'text', text }] };
          } catch (err) {
            if (err.code) throw err;
            result = { content: [{ type: 'text', text: `Error de CoDev: ${err.message}` }], isError: true };
          }
          break;
        default:
          throw Object.assign(new Error(`Mètode no suportat: ${msg.method}`), { code: -32601 });
      }
      send({ jsonrpc: '2.0', id: msg.id, result });
    } catch (err) {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: err.code || -32603, message: err.message } });
    }
  });
}
