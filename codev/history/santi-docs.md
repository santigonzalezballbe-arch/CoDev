## 2026-11-22 19:05

Petició: que l'app detecti si a GitHub hi ha una versió més nova, avisi l'usuari i s'instal·li sola amb un botó.
Canvis:
- `desktop/updater.js` (nou): consulta `releases/latest` del repo, compara versions, tria l'instal·lador segons com s'ha instal·lat aquesta còpia (AppImage, .deb, Windows NSIS, macOS arm64) i el descarrega verificant mida i SHA-256 (el `digest` que dona GitHub). AppImage: substitueix el fitxer i reobre; .deb: `pkexec dpkg -i`; Windows: instal·lador silenciós `/S --force-run`; macOS: munta el .dmg i copia l'app. Sense dependències noves ni canvis a la release.
- `desktop/main.js`: comprova 3 s després d'obrir i cada 4 h; IPC `update-install` i `open-releases`. `CODEV_FAKE_VERSION=0.0.1` simula una versió vella per provar-ho.
- `desktop/renderer.js`, `index.html`, `style.css`, `preload.cjs`: avís fix a baix a la dreta ("Update and restart" / "Later"), amb percentatge de descàrrega; si falla, ofereix obrir la pàgina de descàrrega.
- `test/updater.test.js` (nou, 4 tests).
Proves: `npm test` 49/49; descàrrega real de l'AppImage 0.4.2 sobre un fitxer de prova (hash correcte); captura de l'avís a l'app des del codi font.
Pendent: només funciona a partir de la versió que porti aquest codi: cal publicar una release nova (p. ex. v0.4.3) i que tothom l'instal·li a mà un cop. Windows i macOS sense provar en real. Sense commit.

## 2026-11-22 19:10

Petició: (mateixa) ajust final de l'actualitzador.
Canvi a `desktop/updater.js`: la carpeta temporal de descàrrega només es crea quan cal (.deb, Windows, macOS); amb AppImage es descarrega al costat del fitxer i no deixava cap carpeta buida a `/tmp`.
Pendent: el mateix que a l'entrada anterior (release nova i proves a Windows/macOS). Sense commit.

## 2026-11-22 19:15

Petició: fer commit i release.
Canvis: `package.json` i `package-lock.json` a 0.4.3; commit de l'actualitzador automàtic i etiqueta `v0.4.3` pujada perquè GitHub Actions compili i publiqui els instal·ladors.
Pendent: comprovar que la release té els quatre instal·ladors. Qui tingui 0.4.2 o anterior ha d'instal·lar la 0.4.3 a mà un cop; a partir d'aquí, les actualitzacions arriben soles.

## 2026-11-22 19:20

Petició: instal·lar la 0.4.3 en aquest ordinador.
Canvi (fora del repo): `~/Applications/CoDev.AppImage` substituït per la 0.4.3 de la release, amb l'actualitzador mateix (SHA-256 verificat). L'app oberta segueix sent la 0.4.2 fins que es tanqui i es torni a obrir.
Pendent: reiniciar CoDev; els companys han d'instal·lar la 0.4.3 a mà un cop.
