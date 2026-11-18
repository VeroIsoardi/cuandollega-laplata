# Cuándo llega · La Plata

Web app para ver cuándo llega el micro a tu parada en La Plata. Es una
alternativa más rápida a la página oficial de
[Cuándo Llega](https://cuandollega.smartmovepro.net/unionplatense):

- **Paradas cerca tuyo**, usando la ubicación del teléfono.
- **Arribos en vivo**, que se actualizan cada 30 segundos. Distingue los que
  vienen en camino ("En vivo") de los horarios programados, y se pueden filtrar
  por línea.
- **Mapa de la parada** con los micros que se acercan.
- **Paradas favoritas**, con sus próximos arribos en el inicio. Se guardan en tu
  navegador; no hace falta cuenta.
- **Búsqueda** de paradas, calles, líneas y códigos de cartel (por ejemplo
  `LP10217`) en un solo campo. Si no aparece, queda la búsqueda por línea →
  calle → esquina.
- **Recorrido de cada línea**, con sus ramales y paradas en orden.
- **Mapa de la zona** con todas las paradas.
- **Instalable en el celular** (PWA).
- Funciona con teclado y lector de pantalla, en modo claro u oscuro, y en
  pantallas de celular o de escritorio.

> **Proyecto no oficial.** No está afiliado a SmartMove, a Unión Platense
> ni a ninguna empresa de transporte. Los datos salen del sistema público de
> Cuándo Llega y pueden tener demoras o errores. Los tiempos de arribo son
> estimados.

## Cómo funciona

La página oficial no se puede consultar desde otro sitio: cada pedido
necesita una cookie y un token anti-falsificación. `server.js` hace ese paso,
guarda la sesión y expone JSON limpio bajo `/api/*`. También sirve el frontend.

| Endpoint | Parámetros | Cache |
| --- | --- | --- |
| `/api/lineas` | — | 24 h |
| `/api/calles` | `codLinea` | 24 h |
| `/api/intersecciones` | `codLinea`, `codCalle` | 24 h |
| `/api/paradas` | `codLinea`, `codCalle`, `codInterseccion` | 24 h |
| `/api/cercanas` | `lat`, `lng` | 30 min |
| `/api/arribos` | `codLinea` (`0` = todas), `idParada` | 15 s |
| `/api/recorridos` | `codLinea` | 24 h |

Además, a partir de un catálogo propio (ver abajo):

| Endpoint | Parámetros | Devuelve |
| --- | --- | --- |
| `/api/buscar` | `q`, opcional `lat`, `lng` | paradas, líneas y calles que coinciden |
| `/api/calle` | `nombre` | las paradas de esa calle, con su esquina |
| `/api/linea` | `codLinea` | ramales con recorrido y paradas en orden |
| `/api/zona` | `s`, `w`, `n`, `e` | paradas dentro de ese rectángulo del mapa |

El servidor de origen limita pedidos por IP y, si se lo satura, bloquea la IP
por un rato. Por eso:

- Las respuestas se cachean en memoria. Si el origen falla, se sirve la última
  respuesta buena por hasta 30 minutos.
- Ante un límite o un bloqueo, el proxy deja de consultar al origen durante
  10 minutos y responde con lo que tenga en cache.
- Hace una consulta al origen por vez, con una pausa entre una y otra, y
  pedidos iguales al mismo tiempo comparten una sola consulta.
- Las coordenadas de `cercanas` se redondean a unos 100 m, así pedidos cercanos
  comparten la misma respuesta.

### Catálogo de paradas

Búsqueda, recorridos y mapa leen de un catálogo guardado en el servidor
(`data/catalog.json`, fuera de git y no accesible por HTTP). Puede armarse con
un proceso en segundo plano, dentro del mismo servidor:

- Una vez por semana actualiza el recorrido de cada línea.
- Completa los nombres de las paradas que no lo tengan.
- Hace como mucho una consulta cada 30 segundos (`CATALOG_PACE`, en ms) y se
  frena si el origen lo limita. La próxima revisión, cada una hora, sigue desde ahí.
- Está apagado por defecto. Se activa con `CATALOG_JOB=1 npm start`.

Aunque el proceso esté apagado, el catálogo se completa con el uso: abrir una
línea la agrega, y cada búsqueda de paradas cercanas aporta nombres de calles.
Mientras el catálogo esté incompleto, la búsqueda encuentra menos cosas y el
mapa muestra las paradas cercanas al centro. Un armado completo tarda unas
horas.

## Correrlo

Necesitás Node 22 o más nuevo. No tiene dependencias.

```bash
npm start   # http://localhost:3000 (cambiá el puerto con PORT)
npm test
```

Los tests simulan el servidor de origen, así que no hacen pedidos reales.

| Variable | Para qué | Por defecto |
| --- | --- | --- |
| `PORT` | Puerto del servidor | `3000` |
| `CATALOG_JOB` | `1` activa el armado del catálogo en segundo plano | apagado |
| `CATALOG_PACE` | Milisegundos entre consultas del armado | `30000` |
| `UPSTREAM_GAP` | Milisegundos mínimos entre consultas al origen | `1000` |
| `CATALOG_FILE` | Dónde guardar el catálogo | `data/catalog.json` |

### Instalarla en el celular

Abrí la app en el navegador del teléfono y elegí "Agregar a pantalla de inicio"
(Safari: botón Compartir; Chrome: menú ⋮). Necesita servirse por HTTPS. La
pantalla principal funciona sin conexión, pero los arribos siempre se piden en
el momento.

## Archivos

- `server.js`: proxy y servidor de archivos estáticos.
- `catalog.js`: catálogo de paradas y el proceso que lo actualiza.
- `index.html`, `app.js`, `style.css`: el frontend, en JavaScript sin frameworks. El mapa usa [Leaflet](https://leafletjs.com) con OpenStreetMap.
- `manifest.webmanifest`, `sw.js`, `icon*`: lo necesario para instalarla como app.
- `test/`: tests del proxy y del catálogo, con `node:test`.

## Créditos

Inspirado en [Cuándo llega mi bondi](https://github.com/cuando-llega-mi-bondi/cuando-llega-mi-bondi), de Mar del Plata.
Mapas © colaboradores de [OpenStreetMap](https://www.openstreetmap.org/copyright).
