## 2026-11-21 22:55

Petició: l'activitat de DeepSeek només mostrava "bash" i "read", sense dir què feia.

Causa: el pont ACP del DeepSeek Harness envia cada eina com `{ title: <nom de l'eina>, kind: "other", rawInput }`, sense `locations`. `cli/harness.js` publicava només el `title`, i per això les edicions de DeepSeek tampoc no es registraven com a edicions (sense fitxers).

Canvis:
- `cli/harness-tools.js` (nou): `describeTool()` llegeix els arguments de cada eina (bash, read, write, edit, str_replace_editor, apply_patch, grep, glob, web_fetch, web_search) i en treu el tipus, un resum ("$ git status", "Read README.md", "Edited cli/hook.js", "Fetched …") i els fitxers del projecte que toca. Les altres eines mostren el nom i el seu argument principal.
- `cli/harness.js`: fa servir `describeTool()` tant per publicar l'activitat a la sala com per a la línia que surt a la terminal.
- `test/harness-tools.test.js` (nou): 5 proves amb crides reals del Harness.

Proves: `npm test` 37/37 amb les variables `CODEV_*` buides. Amb les variables d'una sessió de CoDev, 11 proves e2e fallen, també sense aquests canvis.

Pendent: no s'aplica a l'app que ja corre (AppImage 0.4.0, amb la còpia a `~/.config/codev/runtime/0.4.0/cli/`) fins a la propera versió. Encara no hi ha commit.

## 2026-11-21 23:10

Petició: mostrar el saldo de DeepSeek a les seves pestanyes i avisar al botó del xat quan arriba un missatge.

Canvis:
- `desktop/main.js` i `desktop/preload.cjs`: nou `agent-balance`, que demana el saldo a `GET https://api.deepseek.com/user/balance` amb la clau guardada al clauer. La clau no surt del procés principal i la interfície només rep els imports. Té una memòria cau d'1 minut (10 s després d'un torn) i s'esborra quan canvia la clau.
- `desktop/renderer.js` i `desktop/style.css`: les teves terminals de DeepSeek mostren "¥X.XX left" a la capçalera, amb fons vermell si el saldo és inferior a 1 o si el compte no està disponible. S'actualitza cada minut i quan DeepSeek acaba un torn.
- Xat: el comptador de no llegits ignorava els missatges de les teves pròpies terminals, i en una sala on només hi ha les teves sessions mai no comptava res. Ara compta tot el que no has escrit tu mateix, incloses les notes de les teves IA. A més, `.chat-btn.unread` es pintava del mateix negre que el botó. Ara el botó es posa blanc, mostra una insígnia amb el nombre i el color de qui ha escrit, i fa un pols quan arriba un missatge (sense animació si l'usuari té activat `prefers-reduced-motion`).

Proves: `npm test` 37/37 amb les variables `CODEV_*` buides.

Pendent: no he pogut comprovar l'API de saldo contra la documentació (la web refusava la connexió). He seguit el format conegut (`is_available` i `balance_infos[].total_balance`).
