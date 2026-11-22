
## 2026-11-22
Petició: que l'ordinador no es bloquegi mentre una IA programa amb CoDev obert (com quan mires un vídeo).
- desktop/main.js: IPC `keep-awake` amb `powerSaveBlocker.start('prevent-display-sleep')`; s'atura quan cap IA treballa.
- desktop/preload.cjs: exposa `codev.keepAwake(on)`.
- desktop/renderer.js: `keepAwake()` a cada `renderHeads` (400 ms): actiu si algun panell està en estat `working`.
Pendent: provar-ho a l'app real (Linux usa l'Inhibit de org.freedesktop.ScreenSaver).
