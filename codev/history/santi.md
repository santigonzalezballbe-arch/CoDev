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

## 2026-11-22 20:10

Petició: millorar el vídeo promocional de TikTok (l'escena «Everything.» amb tres caixes amb ✕ era pobra i faltava profunditat en general).
Canvis (fora del repo, a `~/Videos/codev-demo/promo/video/src/Promo.tsx`): l'escena del problema ara té tres il·lustracions SVG animades (dues IA xocant amb el mateix fitxer, codi esborrat i reescrit, rellotge nocturn girant); fons amb graella de punts i glifs de codi flotant amb parallax a totes les escenes; zoom lent de càmera; entrades «pop» amb desenfocament; captures de l'app en perspectiva 3D amb ombres. Nous renders: `~/Videos/codev-demo/codev-promo-tiktok-v2.mp4` i `codev-promo-v2.mp4` (els antics es conserven).
Pendent: revisar-lo i, si agrada, substituir els vídeos publicats.

## 2026-11-22 20:45

Petició: un company afegit com a col·laborador no pot entrar al repo privat des de CoDev; i la fletxa del selector de repositoris no fa res.
Causa: el clonatge depenia de `gh` amb sessió iniciada (si no, `git clone` anònim, que falla amb repos privats); `gh repo list` tampoc mostra els repos on ets col·laborador; la fletxa era la d'un `<datalist>`, que a Electron no obre res.
Canvis:
- `desktop/main.js`: inici de sessió amb GitHub (OAuth device flow, IPC `gh-login-start/wait/cancel`, `gh-logout`); token xifrat amb safeStorage (o només en memòria si no hi ha clauer). Llista de repos via API `/user/repos?affiliation=owner,collaborator,organization_member`. Clonatge amb el token (per variables `GIT_CONFIG_*`, no s'escriu a `.git/config`); si falla, diu que cal acceptar la invitació a `github.com/<repo>/invitations`. Les terminals pròpies (no les dels convidats) reben el token per a `git push`/`gh`; el descobriment de sales també.
- `desktop/preload.cjs`: les noves crides.
- `desktop/index.html`, `renderer.js`, `style.css`: desplegable propi (fletxa, filtre, teclat) i botó "Sign in with GitHub" que mostra i copia el codi.
Proves: `npm test` 49/49; a l'app des del codi la fletxa obre la llista (7 repos).
Pendent: `GITHUB_CLIENT_ID` és un marcador: cal registrar una OAuth App de CoDev amb "Device flow" activat i posar-hi el Client ID. Després, release nova. Sense commit.

## 2026-11-22 20:55
Petició: publicar la release amb l'inici de sessió de GitHub.
Canvis: `desktop/main.js` amb el Client ID real de l'OAuth App de CoDev (device flow comprovat contra GitHub); `package.json` i `package-lock.json` a 0.4.8; etiqueta `v0.4.8`.
Pendent: que el company actualitzi a 0.4.8, accepti la invitació del repo i faci "Sign in with GitHub".

## 2026-11-22 21:40

Petició: la detecció de companys al mateix projecte no funcionava amb DiOrg entre dos ordinadors a xarxes diferents.
Causa: el camí per GitHub feia servir la comanda `gh`; si un ordinador no la tenia (p. ex. connectat amb "Sign in with GitHub"), fallava en silenci a l'amfitrió i al visitant.
Canvis:
- `desktop/discovery.js`: `ghApi` crida directament `api.github.com` amb `fetch` i el token; sense token només llegeix (repos públics).
- `desktop/main.js`: fa servir `githubToken()` (token de l'inici de sessió o de `gh auth token`); si no pot publicar la sala, avisa l'amfitrió (`discovery-warning`).
- `desktop/preload.cjs`, `desktop/renderer.js`: mostren l'avís. `README.md`: ja no cal `gh`.
Proves: `npm test` 49/49; publicar, llistar i esborrar una sala real a DiOrg sense `gh` al PATH.
Publicat com a v0.4.9.
Pendent: tornar a provar entre dues xarxes amb la 0.4.9 als dos ordinadors (l'amfitrió ha de prémer "Share online").

## 2026-11-23 — tornar a l'inici des d'una sala
Petició: poder tenir diversos projectes oberts, o almenys tornar a la pantalla d'inici (abans no es podia sortir d'una sala).
Canvis:
- `desktop/index.html`: botó "Leave" a la barra superior.
- `desktop/renderer.js`: `leaveRoom()` demana confirmació si una IA teva treballa (o si ets l'amfitrió), tanca el WebSocket, crida `leave-room` i recarrega la pàgina; la pantalla d'inici es torna a omplir amb els darrers valors.
- `desktop/main.js`: IPC `leave-room` que tanca les terminals, les dels convidats, l'enllaç en línia, l'anunci a la xarxa i a GitHub, el context d'amfitrió, l'historial i el bloqueig de pantalla. El servidor incrustat continua viu i es reutilitza.
- `desktop/preload.cjs`: `leaveRoom`.
Proves: `npm test` OK; a l'app des del codi (Electron + Playwright): crear sala → Leave → inici amb els camps plens → tornar a entrar.
Pendent: diversos projectes alhora (finestres) demana separar per finestra l'estat del procés principal (historial, amfitrió, convidats, anuncis). Sense commit.

## 2026-11-23 — release 0.4.10
Petició: publicar la release amb el botó "Leave".
Canvis: `package.json` i `package-lock.json` a 0.4.10; commit i etiqueta `v0.4.10` pujats perquè GitHub Actions compili i publiqui els instal·ladors.
Pendent: comprovar que la release té els instal·ladors.

## 2026-11-23 — historial de repositoris
Petició: un historial de repositoris per poder-los tornar a seleccionar.
Canvis:
- `desktop/renderer.js`: es desa a `localStorage` (`codev:recentRepos`, màx. 10) cada repositori amb què s'entra a una sala, amb la sala i la data. El desplegable del repositori mostra primer "Recent" (sala · fa quant) i després "Your repositories"; també funciona sense haver iniciat sessió a GitHub. Botó × per treure'n un. La primera vegada s'omple amb el darrer repositori desat.
- `desktop/style.css`: capçaleres de grup i botó ×.
Proves: `npm test` OK; a l'app des del codi (Electron + Playwright): la llista mostra els recents a dalt i el × els esborra.
Pendent: release nova. Sense commit.

## 2026-11-23 — release 0.4.11
Petició: publicar l'historial de repositoris.
Canvis: `package.json` i `package-lock.json` a 0.4.11; commit i etiqueta `v0.4.11` pujats perquè GitHub Actions compili i publiqui els instal·ladors.
Pendent: comprovar que la release té els instal·ladors.

## 2026-11-23 15:10 — commit i push automàtic del registre
Petició: que els companys vegin al repositori que estàs connectat sense haver de fer cap canvi ni commit; l'historial (`codev/history/`) no es veia funcionar.
Canvis:
- `cli/gitsync.js` (nou): `publishLog` fa commit només del registre (`codev/history/<nom>.md` i `codev/README.md`) i push a l'upstream, en un procés en segon pla. No toca la resta de canvis (ni els staged), no fa pull ni rebase, i no fa push si tens commits propis sense pujar (el registre surt amb el teu proper push).
- `cli/hook.js`: SessionStart (inici o represa) escriu "<nom> opened a session" i ho publica; Stop publica el registre si la IA hi ha escrit; SessionEnd escriu "closed the session" i ho publica. Es desactiva amb `"autoPush": false` a `.codev.json` o `CODEV_AUTOPUSH=0`.
- `cli/codev.js`: comanda interna `publish-log`.
- `cli/init.js`, `README.md`: documentació. `test/gitsync.test.js`: proves amb un remot nu.
Proves: `npm test` 52/52; el hook real contra un repositori temporal deixa dos commits al remot.
Pendent: release nova perquè l'app l'inclogui; els projectes ja configurats l'agafen sense tornar a fer `codev init`. Sense commit.
Afegit: a l'AppImage, el procés en segon pla s'executa amb `$APPIMAGE` (el binari muntat desapareix en tancar-se). Nota: el hook Stop només detecta les entrades escrites amb Edit/Write, no amb una comanda de shell.

## 2026-11-23 15:25 — pull en entrar i avís de qui està connectat
Petició: en entrar amb un repositori de GitHub, fer pull; si el registre diu que algú està connectat, que l'app ofereixi connectar-s'hi.
Canvis:
- `desktop/presence.js` (nou): marques ocultes `<!-- codev:open ts=… room=… name=… -->` / `codev:close` i `openSessions()` (sessions obertes de menys de 12 h).
- `cli/hook.js`: les línies d'obrir/tancar sessió porten la marca i el nom de la sala.
- `desktop/main.js`: `prepare-repo` fa `git pull --ff-only` si el repositori ja hi és; `discover` retorna també `sessions`, llegides del clon (després d'un `fetch`, des de l'upstream) o de l'API de GitHub si no està clonat (com a molt un cop per minut). `presence.js` es copia al runtime de l'app empaquetada.
- `desktop/renderer.js`: la pantalla d'inici mostra "X has had a session open… since HH:MM in room Y" amb "Connect" (truca a la porta quan la seva sala es pot trobar) i una notificació d'escriptori la primera vegada.
- `cli/gitsync.js`: el procés en segon pla només fa servir `$APPIMAGE` dins d'Electron (a les terminals de CoDev `APPIMAGE` també hi és i obria l'app gràfica).
- `README.md`; `test/presence.test.js`.
Proves: `npm test` 54/54; a l'app des del codi (Electron + Playwright) amb un remot local: el hook de "Pau" puja el registre i la pantalla d'inici de "Santi" el mostra amb "Connect".
Pendent: connectar de debò requereix que la sala de l'altre sigui trobable (mateixa xarxa o "Share online"). Release 0.4.12. Sense commit.

## 2026-11-23 15:30 — release 0.4.12
Petició: publicar el registre automàtic (commit i push en obrir/tancar sessió) i l'avís de qui està connectat.
Canvis: `package.json` i `package-lock.json` a 0.4.12; commit i etiqueta `v0.4.12` pujats perquè GitHub Actions compili i publiqui els instal·ladors.
Pendent: comprovar que la release té els instal·ladors; instal·lar la 0.4.12 als dos ordinadors i provar-ho entre tots dos.

## 2026-11-23 15:33 — Santi opened a session in room "CoDev" (Claude Code)
<!-- codev:open ts=1795444398245 room="CoDev" name="Santi" -->

## 2026-11-23 15:34 — Santi closed the session
<!-- codev:close ts=1795444479095 -->

## 2026-11-23 15:36 — Santi opened a session in room "CoDev" (Claude Code)
<!-- codev:open ts=1795444573189 room="CoDev" name="Santi" -->

## 2026-11-23 15:45 — historial de repositoris i app responsive
Petició: l'historial de repositoris de la pantalla d'inici no funcionava; l'app quedava malament en fer-la petita o amb moltes finestres.
Canvis:
- `desktop/renderer.js`: el camp de repositori ve emplenat amb la URL (`https://github.com/x/y.git`) i es comparava amb `x/y`, així que la llista sortia buida ("No repository matches"). Ara `repoKey()` normalitza URL/SSH/`owner/repo`; en fer clic al camp la llista s'obre encara que ja tingui text; triar un recent també posa el nom de sala que hi vas fer servir.
- `desktop/renderer.js` (`layout`): columnes segons l'amplada (~420 px per terminal) i files de 300 px com a mínim; si no hi caben, la quadrícula fa scroll en comptes d'aixafar-les. Es recalcula en redimensionar. `--bar-h` segueix l'alçada de la barra superior (History, Chat i el diàleg "Another AI" s'hi col·loquen a sota).
- `desktop/style.css`: barra superior que salta de línia i amb botons més petits sota 1100 px; capçalera de panell compacta amb container query (<560 px); History adaptat a pantalla estreta.
- `desktop/main.js`: mida mínima de finestra 900×560 → 480×420.
Proves: `npm test` OK; app des del codi amb Playwright a 1500, 1000, 700 i 480 px amb 6 terminals, History, Chat i "Another AI"; llista de recents amb la URL al camp.
Pendent: release (0.4.13) perquè arribi a l'app instal·lada. Sense commit.

## 2026-11-23 15:50 — release 0.4.13
Petició: publicar l'arranjament de l'historial de repositoris i l'app responsive.
Canvis: `package.json` i `package-lock.json` a 0.4.13; commit i etiqueta `v0.4.13` pujats perquè GitHub Actions compili i publiqui els instal·ladors.
Pendent: comprovar que la release té els instal·ladors; l'app instal·lada s'actualitza sola amb l'avís.

## 2026-11-23 15:49 — Santi closed the session
<!-- codev:close ts=1795445372169 -->

## 2026-11-23 16:01 — Santi opened a session in room "CoDev" (Claude Code)
<!-- codev:open ts=1795446109381 room="CoDev" name="Santi" -->

## 2026-11-23 16:02 — Santi closed the session
<!-- codev:close ts=1795446176559 -->

## 2026-11-23 16:30
Petició: release nova de CoDev (0.4.14) amb l'arreglament de les sessions "obertes" fantasma.
Canvis: cli/gitsync.js puja també logs antics pendents de codev/history/ i, si el remot ha avançat, crea un commit sobre el remot només amb els logs (sense rebase); test a test/gitsync.test.js; versió 0.4.14 a package.json.
Pendent: comprovar que l'Action de release acaba i instal·lar la 0.4.14.

## 2026-11-23 16:23 — Santi opened a session in room "CoDev" (Claude Code)
<!-- codev:open ts=1795447431696 room="CoDev" name="Santi" -->
