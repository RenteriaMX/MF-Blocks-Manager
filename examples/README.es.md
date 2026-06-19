# Ejemplos

> **[Read in English](README.md)**

## Bloque Spacer

Un bloque simple que agrega espacio vertical configurable entre bloques.

### Instalar desde el Control Panel

**Site Setup → Module Federation Blocks → + Instalar Bloque**

| Campo | Valor |
|---|---|
| **Nombre del Bloque** | `Spacer` |
| **Block ID** | `spacer` |
| **Remote Name** | `voltoSpacerBlock` |
| **Bundle (.tar.gz)** | Subir `examples/blocks/spacer/spacer.tar.gz` |

> **Nota:** El campo **Remote Module** se auto-detecta del bundle. Puedes dejarlo en `./block` — el backend lee el `remoteEntry.js` y asigna el valor correcto automaticamente.

Click en **"Instalar y Publicar"**. Recarga la pagina y el bloque aparecera en el editor bajo COMMON.

### Propiedades

| Propiedad | Tipo | Default | Descripcion |
|---|---|---|---|
| `height` | integer | `100` | Altura en pixeles (0-2000) |

---

## Crea Tu Propio Bloque

### Requisitos

- Node.js 18+
- npm 9+

### Paso 1 — Crear estructura

Copia el directorio `spacer/` como plantilla:

```bash
cp -r examples/blocks/spacer examples/blocks/mi-bloque
cd examples/blocks/mi-bloque
```

### Paso 2 — Archivos fuente

Edita los archivos en `src/`. Cada bloque exporta tres cosas desde `index.js`:

```
src/
├── index.js      ← Export default: { id, title, view, edit, schema }
├── View.jsx      ← Lo que ven los visitantes (publico)
├── Edit.jsx      ← Lo que ven los editores (solo preview, sin codigo de sidebar)
└── Schema.js     ← Campos del sidebar (formato JSON Schema de Volto)
```

**View.jsx** — Recibe `{ data }` con los valores de los campos del schema:

```jsx
import React from 'react';

const MiBloqueView = ({ data }) => {
  return <div>{data.text || 'Texto por defecto'}</div>;
};

export default MiBloqueView;
```

**Edit.jsx** — Mismos props. Solo renderiza un preview. El sidebar lo maneja Volto automaticamente usando el schema exportado:

```jsx
import React from 'react';

const MiBloqueEdit = ({ data }) => {
  return (
    <div style={{ border: '1px dashed #999', padding: '1rem' }}>
      {data.text || 'Editame...'}
    </div>
  );
};

export default MiBloqueEdit;
```

**Schema.js** — Formato JSON Schema de Volto. Define los campos del sidebar:

```js
const MiBloqueSchema = {
  title: 'Mi Bloque',
  fieldsets: [
    {
      id: 'default',
      title: 'Configuracion',
      fields: ['text', 'color'],
    },
  ],
  properties: {
    text: {
      title: 'Texto',
      type: 'string',
      default: 'Hola',
    },
    color: {
      title: 'Color',
      type: 'string',
      widget: 'color_picker',
    },
  },
  required: [],
};

export default MiBloqueSchema;
```

**index.js** — Exporta los metadatos del bloque:

```js
import MiBloqueView from './View';
import MiBloqueEdit from './Edit';
import MiBloqueSchema from './Schema';

const MiBloque = {
  id: 'mi-bloque',
  title: 'Mi Bloque',
  icon: null,
  group: 'common',
  view: MiBloqueView,
  edit: MiBloqueEdit,
  schema: MiBloqueSchema,
  restricted: false,
  mostUsed: false,
  blockHasOwnFocusManagement: false,
  sidebarTab: 1,
};

export default MiBloque;
```

### Paso 3 — Configurar webpack

Actualiza `webpack.config.js` con un nombre remoto unico y la clave de expose:

```js
const { createBlockConfig } = require('../../shared/webpack.base');

module.exports = createBlockConfig({
  name: 'voltoMiBloqueBlock',                    // Nombre unico (sin espacios ni caracteres especiales)
  exposes: { './MiBloque': './src/index.js' },    // Clave expose = nombre del bloque en PascalCase
  blockDir: __dirname,
});
```

El `name` debe ser unico entre todos los bloques MF. Convencion: `volto` + nombre en PascalCase + `Block`.

### Paso 4 — Compilar y empaquetar

```bash
npm install
npm run package
# Resultado: mi-bloque.tar.gz
```

El script `package` ejecuta webpack y crea un `.tar.gz` con:
- `remoteEntry.js` — Punto de entrada de Module Federation
- `*.js` — Archivos chunk (code-split automatico)

### Paso 5 — Instalar

Sube `mi-bloque.tar.gz` desde **Site Setup → Module Federation Blocks → + Instalar Bloque**.

Llena:
- **Nombre del Bloque**: `Mi Bloque`
- **Block ID**: `mi-bloque`
- **Remote Name**: `voltoMiBloqueBlock` (debe coincidir con `name` en webpack.config.js)
- **Remote Module**: dejalo en `./block` (se auto-detecta)

Click en **"Instalar y Publicar"**. Recarga la pagina del editor.

---

## La Regla de Oro

Los bloques SOLO usan React. **NUNCA** importar de `@plone/volto`.

```jsx
// CORRECTO
import React from 'react';

// INCORRECTO — fallara en tiempo de ejecucion
import { SidebarPortal } from '@plone/volto/components';
import { flattenToAppURL } from '@plone/volto/helpers';
```

¿Por que? Los bloques MF corren en un contenedor webpack aislado. Comparten React con el host via Module Federation, pero NO tienen acceso a los modulos internos de Volto. El host maneja el sidebar automaticamente usando el `schema` exportado.

## Estructura de archivos

```
examples/
├── shared/
│   └── webpack.base.js    ← Config webpack compartida (Module Federation + React)
├── blocks/
│   └── spacer/
│       ├── src/
│       │   ├── index.js
│       │   ├── View.jsx
│       │   ├── Edit.jsx
│       │   └── Schema.js
│       ├── webpack.config.js
│       ├── package.json
│       └── spacer.tar.gz  ← Bundle listo para subir
├── README.md              ← Version en ingles
└── README.es.md           ← Este archivo
```
