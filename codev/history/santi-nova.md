
## 2026-11-21 23:40

Petició: a l'historial/vista de conversa surten coses d'altres IA i duplicats.

Causes i canvis:
- `desktop/renderer.js`, `server/terminals.js`: la vista de conversa filtrava només pel nom del membre, i els noms es reutilitzen (tancar "Nova" allibera el nom per a la IA següent; el terminal principal sempre és "Santi"). Ara cada terminal té `since` (quan va començar) i la vista només mostra esdeveniments des d'aleshores. Els remots el reben via `term-open`/`terms`.
- `cli/hook.js`: les respostes es comptaven amb `replied`, que el Stop reiniciava a 0. Un torn sense prompt (tasca en segon pla, wake-up) tornava a enviar totes les respostes des de l'últim prompt → duplicats. Ara es recorden per `uuid` de l'entrada del transcript a `.codev/turns/<sessió>.sent.json`.
- `test/e2e.test.js`: els tests heretaven `CODEV_*` del terminal i enviaven "Build the login"... a la sala real. Ara s'esborren. Test nou per al torn sense prompt.

Pendent: el `.codev/history.jsonl` local ja conté els duplicats i les dades de test d'abans; no l'he tocat. Sense commit.

## 2026-11-21 23:50

Petició: netejar el `.codev/history.jsonl` local (git-ignored, no és al repo).
Tret: 45 esdeveniments dels tests (3 execucions a les 22:49 com a "Santi · frontend") i 25 respostes repetides. 375 → 305 línies. Còpia de seguretat al scratchpad de la sessió.
Pendent: res. La vista de l'app pot mostrar-los fins que la reiniciïs.

## 2026-11-21 23:58

Petició: dos xats, un perquè les IA parlin i es facin peticions, i un altre només per a persones.

Canvis:
- `desktop/index.html`, `desktop/style.css`, `desktop/renderer.js` (només les funcions del xat: `setupChat`, `addChat`, `openChat`, `showChatTab`, `renderChat`): pestanyes "People" i "AIs". People = notes `from: 'human'`, amb el formulari. AIs = notes `from: 'ai'` i els avisos de conflicte, només lectura per a les persones (s'hi escriu amb `codev_send_note`). Comptador de no llegits per pestanya; en obrir el xat va a la pestanya amb novetats.
- `cli/config.js`, `cli/mcp.js`: el xat de persones ja no arriba mai a cap IA (ni al context del prompt, ni a "Recent activity", ni a `codev_read_chat` ni a `codev_search_history`). Descripcions de les eines actualitzades.
- `test/e2e.test.js`: el test del xat ara comprova que una nota humana no arriba a la IA.

Proves: `npm test` 37/37. No he obert l'app per veure les pestanyes.

Pendent: provar-ho a l'app. Abans, un missatge humà "a X" arribava a la IA de X; ara no (cal escriure-li al seu terminal). Sense commit.
