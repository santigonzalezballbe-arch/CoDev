## 2026-11-23 16:17 — Foix opened a session in room "CoDev" (Claude Code)
<!-- codev:open ts=1795447051655 room="CoDev" name="Foix" -->

## 2026-11-23 16:20 — l'avís d'actualització no sortia
Petició: a la 0.4.13 no apareixia l'avís de la 0.4.14, que ja està publicada.
Causa: `api.github.com` respon 403 (rate limit de 60 peticions/hora per IP sense token) i `checkForUpdate` s'empassava l'error en silenci.
Canvis:
- `desktop/updater.js`: `checkLatest` envia el token de GitHub si n'hi ha (5000/h); si l'API falla, llegeix la versió de la redirecció de `github.com/.../releases/latest` (sense rate limit) i construeix els instal·ladors amb `knownAssets()`.
- `desktop/main.js`: passa el token (`ghToken()`) a `checkLatest` i registra l'error en lloc d'ignorar-lo.
- `test/updater.test.js`: test del fallback. Provat en viu amb l'API bloquejada: detecta 0.4.14 i l'instal·lador respon 200.
Pendent: release 0.4.15 perquè arribi a les apps instal·lades (la 0.4.13 encara té el codi vell; veurà la 0.4.14 quan es reiniciï el límit). Els 6 tests que fallen a Windows ja fallaven abans (auth, discovery, e2e, guests, harness-tools). Sense commit.
