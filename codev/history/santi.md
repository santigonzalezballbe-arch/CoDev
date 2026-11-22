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
