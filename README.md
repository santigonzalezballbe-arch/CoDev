# CoDev

**Programa en equip amb IA sense trepitjar-vos.**

Avui gairebé ningú escriu el codi a mà: cadascú dona instruccions a la seva IA. El problema arriba quan dues persones (i dues IA) treballen en el mateix projecte alhora: es modifiquen els mateixos fitxers, una IA desfà el que ha fet l'altra i acabeu amb conflictes.

CoDev ho soluciona amb tres peces:

1. **Pantalla partida en directe**: una app d'escriptori amb les terminals de Claude Code de tot l'equip, una al costat de l'altra. A la teva hi escrius com sempre. Les dels companys les veus en directe, exactament com les veuen ells. Al damunt de cada terminal hi ha la tasca actual i els fitxers reclamats. També hi ha una versió web amb el flux d'activitat.
2. **La teva IA sap què fa la del company**: abans de cada prompt, CoDev afegeix al context de la teva IA un resum de la feina dels companys (tasca, fitxers reclamats, activitat recent i notes).
3. **Bloqueig de fitxers**: quan una IA edita un fitxer, el reclama. Si una altra IA el vol editar, CoDev bloqueja l'edició i li explica qui hi treballa i en què. Les IA poden demanar-se coses entre elles amb notes.

## App d'escriptori (recomanat)

```bash
npm install          # Electron, xterm.js i el PTY (també descarrega el binari d'Electron)
npm run app
```

1. **Tria la carpeta del projecte** (la teva còpia del repositori), el teu nom i el nom de la sala.
2. Tria **Crear la sala** si el teu ordinador fa de servidor, o **Unir-me a una sala** i escriu l'adreça que t'ha passat el company (p. ex. `http://192.168.1.20:4321`).
3. Entra. L'app configura els hooks i el MCP al projecte i obre Claude Code a la teva terminal.

Què hi trobaràs:
- **La teva terminal** (esquerra): un Claude Code real. Hi escrius com sempre. `Ctrl+Shift+C` copia la selecció.
- **Les terminals dels companys** (dreta): rèpliques en directe i de només lectura, amb les mateixes columnes i files que l'original.
- **+ Claude Code**: obre una altra sessió teva. Cada sessió compta com un agent propi ("Santi 2"...) i té els seus fitxers reclamats.
- **Convida**: copia l'adreça de xarxa local del servidor per enviar-la al company.
- **Notes**: barra superior per enviar missatges a un company o a tot l'equip. Les IA també se'n poden enviar.
- **Avisos**: quan CoDev atura una IA perquè anava a tocar un fitxer d'un altre, surt una franja vermella.

Si el company és en una altra xarxa, exposa el port 4321 amb un túnel (`cloudflared tunnel --url http://localhost:4321`) i passa-li aquella URL.

## Arquitectura

```
 App de l'Ana                           Servidor CoDev                     App del Marc
┌────────────────────────┐        ┌─────────────────────────┐        ┌────────────────────────┐
│ xterm.js ⇄ PTY: claude │──WS───▶│ retransmissió terminals │◀──WS───│ xterm.js ⇄ PTY: claude │
│   ├─ codev hook ───────┼─HTTP──▶│ sales: membres, tasques,│◀─HTTP──┼── codev hook           │
│   └─ codev mcp         │        │ fitxers reclamats,      │        │   codev mcp            │
│ capçaleres ◀── SSE ────│◀───────│ activitat, notes        │───────▶│ ── SSE ──▶ capçaleres  │
└────────────────────────┘        └─────────────────────────┘        └────────────────────────┘
```

- `desktop/`: app Electron. `main.js` gestiona els PTY i pot allotjar el servidor. `renderer.js` conté els terminals xterm.js, la retransmissió i les capçaleres.
- `server/`: API REST, Server-Sent Events (activitat), WebSocket (`terminals.js`, retransmissió de terminals) i la web estàtica.
- `public/`: la versió web (flux d'activitat, sense terminals).
- `cli/`: l'ordre `codev`. Inclou els hooks de Claude Code, el servidor MCP, `init`, `watch` i `status`.
- `scripts/demo.js`: simula dues persones treballant, per veure la web en acció.
- `test/`: proves d'extrem a extrem amb el servidor, els hooks, el MCP i la retransmissió de terminals reals.

**Com es retransmet una terminal:** l'app envia la sortida del PTY quan xterm.js ja l'ha processada. Cada 3 segons envia també una "foto" de la pantalla (`@xterm/addon-serialize`). El servidor guarda la darrera foto i els trossos posteriors, així qui es connecta tard veu la pantalla exacta. Només el propietari pot publicar al seu terminal.

## Ús sense l'app (CLI + web)

### 1. Arrenca el servidor (un sol cop per a tot l'equip)

```bash
node cli/codev.js server            # http://localhost:4321
```

Si el teu company és en una altra xarxa, exposa el port amb un túnel (per exemple, `cloudflared tunnel --url http://localhost:4321`) i feu servir aquesta URL com a `--server`.

### 2. Connecta el projecte (cada persona, a la seva còpia del repositori)

```bash
npm link                            # opcional: fa que l'ordre `codev` estigui disponible a tot arreu
cd el-teu-projecte
codev init --room el-meu-projecte --name Santi --server http://localhost:4321
```

Això:
- crea `.codev.json` (sala, nom i servidor) i l'afegeix al `.gitignore`;
- afegeix els hooks a `.claude/settings.local.json` sense tocar els que ja tinguis;
- registra el servidor MCP `codev` a Claude Code (àmbit local).

La primera vegada, Claude Code et preguntarà si confies en la carpeta, perquè té hooks: respon que sí.

### 3. Obre la pantalla partida i treballa

Obre `http://localhost:4321/?room=el-meu-projecte&name=Santi` i fes servir Claude Code com sempre. Amb el botó **Convida** copies l'enllaç per al teu company.

### Provar-ho sense company

```bash
node cli/codev.js server &
npm run demo                         # simula l'Ana i el Marc a la sala "demo"
# obre http://localhost:4321/?room=demo&name=Ana
```

## Què fa cada hook

| Hook de Claude Code | Què fa CoDev |
|---|---|
| `SessionStart` / `UserPromptSubmit` | Publica el teu prompt com a "tasca actual" i injecta a la IA el resum de l'equip |
| `PreToolUse` (Edit/Write/MultiEdit/NotebookEdit) | Reclama el fitxer. Si és d'un altre, **denega** l'edició i n'explica el motiu |
| `PostToolUse` | Publica l'acció (amb diff si és una edició) |
| `Stop` | Marca la teva IA com a "esperant" |
| `SessionEnd` | Allibera els teus fitxers |

Si el servidor no respon, els hooks no fan res: CoDev no bloqueja mai la feina per una errada pròpia. Les reclamacions caduquen al cap de 20 minuts sense activitat.

## Eines MCP per a la IA

- `codev_team_status`: què fan els companys.
- `codev_claim_files` / `codev_release_files`: reservar o alliberar fitxers per endavant.
- `codev_send_note`: enviar una nota a un company (la veu a la web i la rep la seva IA).
- `codev_set_intent`: anunciar el pla actual.

## Altres IA (Cursor, Copilot...)

Sense hooks no es poden bloquejar edicions, però `codev watch` publica cada canvi del disc a la sala i marca un conflicte si toques un fitxer reclamat per un altre. Si l'eina admet MCP, pots registrar-hi `node cli/codev.js mcp`.

## Tests

```bash
npm test
```

## Limitacions actuals (MVP)

- L'estat és en memòria: si reinicies el servidor, es perd.
- Les terminals dels companys són de només lectura (de moment no es pot escriure a la terminal d'un altre).
- Si una terminal s'encongeix mentre Claude Code treballa (p. ex. quan entra un company nou), poden quedar restes de dibuix fins al següent redibuixat.
- No hi ha autenticació: el nom de la sala fa de contrasenya. No l'exposis a internet amb dades sensibles.
- Els bloquejos són per fitxer, no per funció ni per línia.
- Les ordres de `Bash` que modifiquen fitxers (`sed`, `mv`...) no es bloquegen; només es mostren.

## Idees per a properes versions

- Persistència i autenticació (comptes, sales privades, invitacions).
- Integració amb git: veure les branques de cadascú i avisar de conflictes abans del merge.
- Bloqueig per símbol o funció en lloc de per fitxer.
- Empaquetar l'app (AppImage / .deb / .dmg / .exe) amb electron-builder.
- Permetre que el propietari doni control de la seva terminal a un company.
- Connectors per a més agents (Cursor, Codex, Gemini CLI...).
