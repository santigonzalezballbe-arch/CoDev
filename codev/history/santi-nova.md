
## 2026-11-21 23:40

Petició: a l'historial/vista de conversa surten coses d'altres IA i duplicats.

Causes i canvis:
- `desktop/renderer.js`, `server/terminals.js`: la vista de conversa filtrava només pel nom del membre, i els noms es reutilitzen (tancar "Nova" allibera el nom per a la IA següent; el terminal principal sempre és "Santi"). Ara cada terminal té `since` (quan va començar) i la vista només mostra esdeveniments des d'aleshores. Els remots el reben via `term-open`/`terms`.
- `cli/hook.js`: les respostes es comptaven amb `replied`, que el Stop reiniciava a 0. Un torn sense prompt (tasca en segon pla, wake-up) tornava a enviar totes les respostes des de l'últim prompt → duplicats. Ara es recorden per `uuid` de l'entrada del transcript a `.codev/turns/<sessió>.sent.json`.
- `test/e2e.test.js`: els tests heretaven `CODEV_*` del terminal i enviaven "Build the login"... a la sala real. Ara s'esborren. Test nou per al torn sense prompt.

Pendent: el `.codev/history.jsonl` local ja conté els duplicats i les dades de test d'abans; no l'he tocat. Sense commit.
