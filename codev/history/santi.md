## 2026-11-21 22:39

Petición: comprobar si el README está actualizado respecto al código.

Revisado el README completo contra el código en `v0.2.0` (CLI, hooks, MCP, servidor, app de escritorio, web, invitados y workflows). Todo coincide: comandos, tabla de hooks, herramientas MCP, archivos de arquitectura, instaladores, túnel de Cloudflare, historial local y limitaciones.

Cambio: en `README.md` añadido el ancla `<a id="desktop-app-recommended"></a>` antes de `## Install`. La UI (`desktop/index.html`) todavía enlaza a `#desktop-app-recommended`, un ancla que desapareció al renombrar la sección en el último commit; ahora el enlace vuelve a funcionar sin tocar la interfaz.

Pendiente: decidir si se corrigen dos restos ajenos al README: `cli/mcp.js` anuncia `serverInfo.version: '0.1.0'` y `package.json` conserva el script `demo` apuntando a `scripts/demo.js`, que no existe.

## 2026-11-21 22:48

Petición: "seguro??" después de que Santi subiera los cambios a GitHub.

Actualizado el checkout local a `origin/main` (`1f96a7b`, versión `0.4.0`, 6 commits nuevos) y revisado el README nuevo contra ese código: cuatro IAs (Claude Code, DeepSeek Harness, Ollama local y Codex), instaladores, hooks, MCP, arquitectura y limitaciones.

Cambios: en `README.md`, restaurado el ancla `<a id="desktop-app-recommended"></a>` y actualizado el ejemplo de tag `v0.2.0` a `v0.4.0`; la frase de tests ahora dice "cómo arranca cada IA" en vez de "el arranque de cada IA". En `desktop/main.js`, la comprobación de keychain ahora rechaza el backend `basic_text` de Linux, que Electron considera disponible aunque cifre con una clave fija; así se cumple lo que ya prometían el README y la UI.

Verificado: el release `v0.4.0` existe con los cuatro instaladores; `npm test` pasa 32/32 (con las variables `CODEV_*` del entorno vacías; sin eso los e2e detectan este proyecto como si fuera la sala).

Pendiente: `cli/mcp.js` sigue anunciando `serverInfo.version: '0.1.0'` y `package.json` mantiene `demo` sin `scripts/demo.js`. Sin commit todavía.

## 2026-11-21 23:45

Petició: que una IA llegeixi automàticament la nota que li envia una altra IA, sense esperar que la seva persona li escrigui.

Canvi a `desktop/renderer.js`: quan arriba una nota d'IA adreçada pel nom a un terminal local, l'app la posa en una cua i l'escriu al terminal (com si fos un prompt) quan l'IA està lliure (`waiting`/`sleeping`: ni treballant, ni preguntant, ni algú escrivint). Les notes a tot l'equip no desperten ningú. Límit de 6 notes automàtiques per terminal cada 10 minuts per evitar bucles entre IA; les que passen del límit es veuen al següent prompt (el hook ja hi afegeix les últimes notes). `npm test` 37/37.

Pendent: provar-ho en viu entre dues màquines (cal que l'altra persona actualitzi l'app). Sense commit.

## 2026-11-22 01:05

Petició: donar a conèixer CoDev (demo en vídeo, Reddit, TikTok, GitHub).
Canvis: `docs/codev-demo.gif` (gravació real de Claude Code + DeepSeek al mateix repo: DeepSeek reclama els fitxers, Claude li escriu i espera, després continua) i el GIF a dalt de `README.md`. Fora del repo: descripció i topics del repo a GitHub i GIF a les notes de la release v0.4.2. Vídeos i textos per a xarxes a `~/Videos/codev-demo/`.
Pendent: enviar CoDev a awesome-claude-code a partir del 28/11 (demanen repo d'una setmana); el post de r/vibecoding espera revisió dels moderadors.
Commit: `221991b` (README + GIF), pujat a `main`.

## 2026-11-22 18:30

Petició: si dues persones del mateix projecte fan servir CoDev, que s'assabentin i es puguin unir a la mateixa sala.
Canvis:
- `desktop/discovery.js` (nou): identitat del projecte (hash del primer commit i del repo de GitHub; mai el nom), anunci per multicast UDP a la LAN (`239.255.43.219:43219`) i llistat a GitHub amb una ref amagada `refs/codev/rooms/<nom>` (via `gh api`), que només s'escriu mentre la sala està compartida online.
- `server/server.js`: `POST /api/knock` sense clau; espera la decisió de l'amfitrió (`knocks.ask`) i només llavors torna la clau. Màxim 5 peticions alhora. `/api/info` diu `knock: true`.
- `desktop/main.js`: anuncia la sala en ser amfitrió, la publica a GitHub quan s'obre el túnel (refresc cada 10 min) i l'esborra en aturar-lo o tancar l'app; IPC `discover`; `knockHooks` reutilitza `askHost` (90 s).
- `desktop/renderer.js`, `index.html`, `style.css`, `preload.cjs`: a la pantalla d'inici, avís "X is working on this project in room Y — Ask to join" (cada 8 s); l'amfitrió veu la petició a la barra d'avisos amb Allow/Deny; en acceptar, s'entra a la sala automàticament.
- `test/discovery.test.js` (nou, 8 tests), `README.md` (secció "Teammates on the same project" i limitació).
Proves: `npm test` 45/45 (inclou multicast real). GitHub real: ref creada, llegida, actualitzada i esborrada al repo CoDev. Prova completa amb dues finestres a la LAN: Maya troba la sala d'Alex des d'una altra còpia, truca, Alex accepta i Maya entra.
Pendent: provar el camí per GitHub amb dues xarxes diferents de veritat (túnel de Cloudflare). Sense commit.

## 2026-11-22 19:40

Petició: un avís quan cada finestra (IA) acaba de treballar; triades: ressaltat al panell, so curt i notificació d'escriptori, només per a les finestres pròpies.
Canvis:
- `desktop/renderer.js`: `trackDone()` a `updateHead()` detecta el pas de `working` a `waiting`/`sleeping` en terminals locals i convidats d'aquest ordinador. Compta si ha treballat ≥ 8 s i queda quiet 3 s (evita sorolls de redibuixat). Llavors: distintiu "✓ Done" i pols verd al panell (s'esborra en clicar-hi, enfocar-lo o escriure-hi), "ding" amb WebAudio i notificació d'escriptori (només amb l'app en segon pla; en clicar-la porta la finestra al davant i enfoca el terminal).
- `desktop/index.html`: botó "Sound on/off" a la barra (només app; es desa a localStorage).
- `desktop/style.css`: `.who-done` i animació `done-pulse`.
- `desktop/main.js` + `preload.cjs`: IPC `focus-window`.
Proves: `npm test` 49/49. No provat en viu a l'app.
Pendent: provar-ho a l'app real i ajustar els temps (8 s / 3 s) si cal.

## 2026-11-22 19:55

Petició: treure versió nova per provar l'actualitzador amb l'avís de "Done".
Canvis: `package.json` i `package-lock.json` a 0.4.4; etiqueta `v0.4.4` pujada perquè GitHub Actions compili i publiqui els instal·ladors.
Pendent: comprovar que la release té els quatre instal·ladors i que la 0.4.3 instal·lada mostra l'avís d'actualització i s'actualitza.

## 2026-11-22 19:45
Request: after an in-app update the AppImage did not reopen ("Cannot mount AppImage, please check your FUSE setup").
Cause: KDE starts CoDev as a systemd service (KillMode=control-group); when CoDev quits, systemd kills everything left in the service, including the new copy that app.relaunch() was mounting.
Changed: desktop/main.js — new relaunch(): on Linux inside a systemd service (INVOCATION_ID set) it starts the new copy with `systemd-run --user --scope` once the old process has exited; otherwise app.relaunch(). The pause before closing went from 300 ms to 1 s so the scope is created first.
Left to do: try it with a real release (0.4.5); the fix only applies from the version that includes it.

## 2026-11-22 19:55
Request: commit the relaunch fix and publish 0.4.5.
Changed: package.json, package-lock.json (version 0.4.5); tag v0.4.5 pushed, the Release workflow builds the installers.
Left to do: update from 0.4.4 to 0.4.5 (0.4.4 may still fail to reopen; open it by hand), then check that 0.4.5 → next reopens by itself.

## 2026-11-22 20:10
Request: make the "finished" notice on a window clearer, mainly for when you were away: a particle cascade besides "Done", gone when the cursor passes over.
Changed: desktop/renderer.js — showVeil()/hideVeil(): when an AI finishes, a veil over the pane body with a big "✓ Done", how long it worked, and a canvas of falling particles that runs until you come back; a real cursor move over it fades it out (a still cursor does not), clicking/typing also clears it. No animation with prefers-reduced-motion. desktop/style.css — .done-veil, .done-canvas, .done-msg styles.
Left to do: try it in the real app; the "Done" badge in the head stays until you click the window, as before.

## 2026-11-22 20:15
Request: publish a release with the "Done" veil.
Changed: package.json, package-lock.json (version 0.4.6); tag v0.4.6 pushed, the Release workflow builds the installers.
Left to do: update from 0.4.5 and check the veil in the real app.
