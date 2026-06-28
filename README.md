# ♟ Analizador de Partidas de Ajedrez

Programa para analizar tus partidas de ajedrez. Lees una partida en texto (PGN),
la reproduce en un tablero visual y, usando el motor **Stockfish**, marca para
cada jugada cuál habría sido la mejor opción, clasifica errores e imprecisiones
y calcula una **precisión promedio** por jugador (estilo chess.com / Lichess).

## Cómo usarlo

1. Haz doble clic en el acceso directo **"Ajedrez"** de tu escritorio
   (o en **`Iniciar.bat`** dentro de la carpeta, o `py app.py` en una terminal).
2. El navegador se abrirá solo en `http://127.0.0.1:5000` tras un par de segundos.
3. Para apagar el programa, cierra la ventana negra (la consola).

> El acceso directo del escritorio se crea con `crear_acceso_directo.ps1`.
> Si lo borras o mueves la carpeta, vuelve a ejecutar ese script.
3. Pega tu partida en el cuadro de texto (o pulsa **"Cargar ejemplo"**).
4. Elige la profundidad del análisis y pulsa **"Analizar partida"**.
5. Revisa el reporte: navega jugada por jugada con los botones o las flechas ← →.

## Qué muestra

- **Tablero visual** con **flechas**: azul = la jugada que hiciste, verde = la
  mejor jugada del motor (cuando no coinciden).
- **Clasificación de cada jugada**: Mejor jugada, Excelente, Buena, Imprecisión,
  Inexacta, Error, Blunder o Forzada.
- **Explicación de los errores**: por qué una jugada fue mala (qué pieza
  colgaste, si permitiste o te perdiste un mate, cuánta ventaja perdiste).
- **Gráfico de evaluación** de toda la partida: ves de un vistazo dónde se
  torció; los puntos rojos marcan los errores graves. Clic para saltar ahí.
- **Resumen por jugador**: precisión promedio (0–100 %), etiqueta cualitativa y
  conteo de cada tipo de jugada.
- **Lista de jugadas** clicable, con un punto de color según su calidad.

## 🎮 Modo de juego (pestaña "Jugar contra la IA")

Juega partidas reales contra Stockfish con un **ranking que evoluciona**:

- Elige color y dificultad: **Adaptativa** (el rival juega a tu nivel actual) o
  **Fija** (eliges el Elo del rival).
- Mueve haciendo **clic** en tu pieza y luego en la casilla destino (se marcan
  los movimientos legales con puntos).
- Cada jugada tuya se **evalúa en vivo** (mejor, buena, imprecisión, error,
  blunder) y te muestra cuál era la mejor opción.
- Botones de **Pista** (flecha amarilla), **Rendirse** y **Girar**.
- Al terminar, tu **Elo estimado** se actualiza combinando el resultado con tu
  rendimiento real (pérdida media de centipeones) y se guarda en `profile.json`,
  así que tu ranking progresa partida a partida.

> El motor no imita tu estilo personal, pero sí **mide tu fuerza** y **adapta su
> nivel** al tuyo para que siempre tengas un rival a tu medida.

## 🧩 Entrena tus errores

Tras analizar una partida, el programa convierte tus **errores graves** en
ejercicios: te vuelve a poner la posición justo antes de fallar y debes
encontrar la mejor jugada moviéndola en el tablero. Tiene pista, ver solución y
avanza por todos tus errores. Es la forma más directa de aprender de ellos.

## ♟ Detección de apertura

En cada partida analizada se identifica la **apertura** jugada (código ECO y
nombre, p. ej. *B01 Scandinavian Defense*) y hasta qué jugada seguiste teoría
conocida. Usa la base de aperturas de Lichess (`openings.json`, generado con
`build_openings.py`).

## Extras del modo de juego

- **Deshacer** la última jugada (takeback) y **elegir pieza** al coronar.
- **Sonidos** de movimiento, captura, jaque y final (se pueden silenciar).
- **Aviso de blunder**: feedback rojo y sonido cuando cuelgas algo.
- **Analizar esta partida**: pasa la partida jugada a la pestaña de análisis.
- **Gráfico de evolución de tu Elo** partida a partida.

## Varias partidas a la vez

Puedes pegar varias partidas seguidas o **cargar un archivo `.pgn`** con muchas.
El programa analiza todas y añade:

- Un **selector de partidas** para ver cada una en el tablero.
- Un panel de **estadísticas globales por jugador**: precisión media en todas
  tus partidas, récord (V/E/D) y total de blunders y errores. Ideal para ver tu
  progreso y tus errores más frecuentes.

## Profundidad del análisis

A mayor profundidad, mejor el análisis pero más tarda:

| Opción         | Profundidad | Velocidad |
|----------------|-------------|-----------|
| Rápida         | 10          | segundos  |
| Normal         | 15          | ~1 min    |
| Profunda       | 18          | varios min|
| Muy profunda   | 22          | lento     |

## Estructura del proyecto

```
Ajedrez/
├── Iniciar.bat        Lanzador (doble clic)
├── app.py             Servidor web (Flask)
├── analyzer.py        Lógica de análisis con Stockfish
├── requirements.txt   Dependencias de Python
├── static/            Interfaz web (HTML, CSS, JS)
├── engine/            Motor Stockfish 18
└── ejemplos/          Partidas de ejemplo (.pgn)
```

## Requisitos

- Python 3 con los paquetes `chess` y `flask`
  (instalar con `py -m pip install -r requirements.txt`).
- Stockfish ya viene incluido en `engine/`.

## Nota sobre el formato PGN

Acepta tanto notación estándar (`Qxd5`, `Nc3`) como notación larga
(`Qd8xd5`, `Nb1c3`), que es la que generan algunos juegos al descargar partidas.
Las cabeceras entre corchetes (`[White "..."]`, etc.) son opcionales.
