# 🚀 Desplegar la versión web

La versión web (carpeta `web/`) es un **sitio estático**: todo corre en el
navegador del usuario (Stockfish en WebAssembly). No necesita servidor, base de
datos ni cuentas. Por eso el despliegue es gratis y sencillo.

Cualquiera que entre a la URL podrá **analizar partidas** y **jugar contra la
IA**. El Elo de cada persona se guarda en su propio navegador (`localStorage`).

---

## Opción A — Vercel con su CLI (rápida, sin GitHub) ⭐

Como tienes Node instalado, puedes subir la carpeta `web/` directamente:

```bash
cd web
npx vercel
```

- La primera vez te pedirá iniciar sesión (correo o GitHub) y confirmar:
  - "Set up and deploy?" → **Yes**
  - "Which scope?" → tu cuenta
  - "Link to existing project?" → **No**
  - Nombre del proyecto → el que quieras (p. ej. `ajedrez`)
  - "In which directory is your code located?" → **`./`** (ya estás dentro de `web`)
  - Si pregunta build/output: deja todo por defecto (es estático).
- Te dará una URL tipo `https://ajedrez-xxxx.vercel.app`.
- Para publicarla como producción definitiva: `npx vercel --prod`.
- Para actualizar tras cambios: vuelve a ejecutar `npx vercel --prod` dentro de `web`.

> El archivo `web/vercel.json` ya configura el cacheo del motor. No necesitas más.

---

## Opción B — Render (sitio estático, necesita repo Git)

Render publica sitios estáticos gratis, pero requiere un repositorio Git.

1. Sube el proyecto a GitHub (ver más abajo "Subir a GitHub"). El `.gitignore`
   ya excluye el motor de escritorio de 108 MB.
2. En **https://dashboard.render.com** → **New → Static Site**.
3. Conecta tu repositorio.
4. Configura:
   - **Build Command:** (déjalo vacío)
   - **Publish Directory:** `web`
5. **Create Static Site**. En 1-2 minutos tendrás una URL `*.onrender.com`.

> El archivo `render.yaml` también permite crear el sitio como "Blueprint".

### Subir a GitHub (para Render o Vercel-por-repo)

```bash
cd "c:/Users/Guancha/Desktop/Proyectos/Ajedrez"
git init
git add .
git commit -m "App de ajedrez (web + escritorio)"
# crea un repo vacío en github.com y luego:
git remote add origin https://github.com/TU-USUARIO/ajedrez.git
git branch -M main
git push -u origin main
```

---

## Opción C — Netlify Drop (la más rápida, sin cuenta)

1. Abre **https://app.netlify.com/drop** en tu navegador.
2. Arrastra la carpeta **`web`** (o el archivo `ajedrez-web.zip`) a esa página.
3. En unos segundos te da una URL pública tipo `https://nombre-azar.netlify.app`.
4. ¡Listo! Compártela.

> Para que el sitio sea permanente y puedas actualizarlo, crea una cuenta
> gratis en Netlify (botón "Sign up") y "reclama" el sitio cuando te lo ofrezca.

**Para actualizarlo después de cambios:** vuelve a arrastrar la carpeta `web`.

---

## Opción B — GitHub Pages (permanente y bajo tu control)

Necesitas una cuenta de GitHub (gratis).

1. Crea un repositorio nuevo, por ejemplo `ajedrez`.
2. Sube el **contenido de la carpeta `web/`** a la raíz del repositorio
   (arrastrando los archivos en la web de GitHub, o con `git`).
3. En el repo: **Settings → Pages**.
4. En "Build and deployment" elige **Deploy from a branch**, rama `main`,
   carpeta `/ (root)`. Guarda.
5. En 1-2 minutos tu sitio estará en
   `https://TU-USUARIO.github.io/ajedrez/`.

Como todas las rutas son relativas, funciona igual aunque esté en un subdirectorio.

---

## Opción C — Cloudflare Pages / Vercel

Mismo principio: conecta el repositorio (o sube la carpeta), indica que **no hay
build** y que la carpeta a publicar es `web/`. Te darán una URL gratis.

---

## Notas técnicas

- **Sin cabeceras especiales:** usamos Stockfish de **1 hilo**, así que NO se
  necesitan las cabeceras COOP/COEP (por eso funciona incluso en GitHub Pages).
- **Rendimiento:** el motor es WebAssembly de 1 hilo; es algo más lento que la
  app local, pero suficiente. Para análisis usa profundidad 8–12.
- **Tamaño:** ~4 MB (la mayoría es el motor). Se cachea tras la primera visita.
- **Privacidad:** no se envía nada a ningún servidor. Todo ocurre en el navegador.
