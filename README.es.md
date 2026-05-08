# MF-Blocks-Manager

> **[Read in English](README.md)**

Carga dinamica de bloques para Plone 6 / Volto usando Webpack Module Federation. Instala, activa y elimina bloques Volto en tiempo de ejecucion — sin recompilar el frontend.

## Instalacion Rapida

```bash
curl -sLO https://raw.githubusercontent.com/RenteriaMX/MF-Blocks-Manager/main/install.sh
bash install.sh
```

Sin `sudo`. Ejecuta como el usuario del sistema Plone. El script auto-detecta tu proyecto Plone, instala backend + frontend + Nginx, compila, reinicia servicios y activa el add-on.

## Que Hace

Volto tradicional requiere recompilar todo el frontend para agregar un bloque nuevo (5-10 min de compilacion + deploy + restart). Con MF-Blocks-Manager:

1. Compila tu bloque como paquete webpack independiente
2. Sube el `.tar.gz` desde **Site Setup → Module Federation Blocks**
3. La pagina se recarga automaticamente y el bloque aparece en el editor bajo el grupo **Bricks**

Sin recompilar. Sin reiniciar. Sin pipeline de deploy.

## Arquitectura

```
┌─────────────────────────────────────────────────┐
│                Plone Backend                     │
│  collective.mfblocks                             │
│  ├── Content Type: MFBlock                       │
│  │   (subir .tar.gz, auto-extraccion, publicar)  │
│  ├── GET @blocks-registry (publico)              │
│  └── GET/PATCH/POST @mfblocks-manage (admin)     │
└───────────────────┬─────────────────────────────┘
                    │ REST API
┌───────────────────▼─────────────────────────────┐
│                Volto Frontend                    │
│  volto-mfblocks                                  │
│  ├── Registro sincrono (XHR + execFileSync)      │
│  ├── Loader MF (shared scope React/ReactDOM)     │
│  ├── Wrappers View/Edit (host maneja sidebar)    │
│  └── Control Panel UI (Site Setup)               │
└───────────────────┬─────────────────────────────┘
                    │ HTTP
┌───────────────────▼─────────────────────────────┐
│                   Nginx                          │
│  /mf-blocks/{block_id}/remoteEntry.js            │
└─────────────────────────────────────────────────┘
```

## Que Se Instala

| Componente | Descripcion |
|---|---|
| **Backend** (`collective.mfblocks`) | Content Type MFBlock, endpoint `@blocks-registry` (publico), endpoint `@mfblocks-manage` (admin), subscribers para extraccion de bundles |
| **Frontend** (`volto-mfblocks`) | Loader MF con shared scope, pre-registro SSR, wrappers View/Edit con sidebar del host, Control Panel en Site Setup |
| **Nginx** | Servir archivos estaticos en `/mf-blocks/` con headers CORS |

## Funciones del Instalador Automatico

El script `install.sh` automaticamente:

- Detecta el directorio del proyecto Plone (o te deja elegir si hay varios)
- Detecta el usuario actual (`whoami`), servicios systemd `--user` (patron `plone-*-backend` / `plone-*-frontend`), herramienta pip (`uv` / `pip`)
- Instala el paquete Python del backend
- Copia el addon frontend y lo registra en `volto.config.js` y `package.json`
- Ejecuta `pnpm install` y compila el frontend
- Crea el directorio `<proyecto>/var/mf-blocks` para los bundles de bloques
- Configura el location block en Nginx (usa `sudo` solo para `nginx -t` y `systemctl reload nginx`)
- Activa el add-on via `zconsole` (fallback: `uv run zconsole`)
- Reinicia todos los servicios via `systemctl --user`

> **Nota Nginx:** El instalador llama a `sudo /usr/sbin/nginx -t` y `sudo /usr/bin/systemctl reload nginx`. Agrega una regla `sudoers` con `NOPASSWD` para estos dos comandos para que el usuario Plone pueda recargar Nginx sin contrasena.

## Control Panel

Despues de la instalacion, ve a **Site Setup → Module Federation Blocks**:

- Ver todos los bloques instalados con nombre, block ID, version, grupo, estado
- **+ Instalar Bloque** — subir un bundle `.tar.gz` con metadatos
- Publicar / Retirar / Activar / Desactivar / Eliminar bloques
- Block ID y Remote Name se auto-generan desde el titulo
- **Auto-reload** — la pagina se recarga automaticamente despues de instalar/publicar/retirar/eliminar para que el bloque aparezca inmediatamente en el editor
- Los bloques MF aparecen bajo un grupo dedicado **Bricks** en el selector de bloques (separados de los bloques nativos de Volto)

## Las Tres Reglas

### Regla #1: La Regla de Oro
Los bloques SOLO dependen de React. **NUNCA** importar componentes de Volto (`SidebarPortal`, `BlockDataForm`, `@plone/volto/helpers`, etc.). El host maneja la sidebar usando el schema exportado.

### Regla #2: Shared Scope
El host provee React y ReactDOM a los bloques remotos via shared scope de Module Federation. Sin esto, los bloques crean instancias duplicadas de React y los hooks fallan.

### Regla #3: Pre-Registro SSR
En el servidor (Node.js), los bloques se pre-registran sincronamente al iniciar via `@blocks-registry`. Sin esto, los visitantes anonimos ven "Unknown Block".

## Crear un Bloque

### Estructura del Bloque

```
mi-bloque/
├── package.json
├── webpack.config.js
└── src/
    ├── index.js      ← exporta { view, edit, schema }
    ├── View.jsx       ← Componente React (modo vista)
    ├── Edit.jsx       ← Componente React (preview en edicion)
    └── Schema.js      ← Objeto schema para BlockDataForm
```

### Contrato de Exportacion (`src/index.js`)

```js
import View from './View';
import Edit from './Edit';
import schema from './Schema';

export default { view: View, edit: Edit, schema };
```

- `view` — Componente React renderizado en modo vista
- `edit` — Componente React renderizado como preview en modo edicion (NO es la sidebar)
- `schema` — Objeto schema. El HOST renderiza `SidebarPortal` + `BlockDataForm` usando este schema

### Ejemplo de Schema (`src/Schema.js`)

```js
const schema = {
  title: 'Mi Bloque',
  fieldsets: [
    { id: 'default', title: 'Default', fields: ['miCampo'] },
  ],
  properties: {
    miCampo: {
      title: 'Mi Campo',
      type: 'string',
    },
  },
  required: [],
};

export default schema;
```

### webpack.config.js

```js
const base = require('../../shared/webpack.base');

module.exports = base({
  name: 'voltoMiBloqueBlock',    // Remote Name
  entry: './src/index.js',
  exposes: {
    './block': './src/index.js',  // Remote Module
  },
});
```

### Compilar y Empaquetar

```bash
cd blocks/mi-bloque
npx webpack --mode production
tar -czf mi-bloque.tar.gz -C dist .
```

### Instalar

**Site Setup → Module Federation Blocks → + Instalar Bloque** → Subir `.tar.gz` → Listo.

## Instalacion Manual (sin script)

### 1. Backend

```bash
cd /opt/plone/<proyecto>/backend
git clone https://github.com/RenteriaMX/MF-Blocks-Manager.git /tmp/MF-Blocks-Manager
cp -r /tmp/MF-Blocks-Manager/backend/collective.mfblocks packages/
pip install -e packages/collective.mfblocks
systemctl --user restart plone-backend-1
# Site Setup → Add-ons → Instalar collective.mfblocks
```

### 2. Frontend

```bash
cd /opt/plone/<proyecto>/frontend
cp -r /tmp/MF-Blocks-Manager/frontend/volto-mfblocks packages/
# Agregar 'volto-mfblocks' al array addons en volto.config.js
# Agregar "volto-mfblocks": "workspace:*" a dependencies en package.json
pnpm install
VOLTOCONFIG=$(pwd)/volto.config.js pnpm --filter @plone/volto build
systemctl --user restart plone-volto
```

### 3. Nginx

```nginx
location /mf-blocks/ {
    alias /opt/plone/<proyecto>/var/mf-blocks/;
    expires 1h;
    add_header Access-Control-Allow-Origin *;
}
```

```bash
mkdir -p /opt/plone/<proyecto>/var/mf-blocks
sudo /usr/sbin/nginx -t && sudo /usr/bin/systemctl reload nginx
```

## Estructura del Repositorio

```
MF-Blocks-Manager/
├── install.sh                                    ← Instalador automatico
├── README.md                                     ← English version
├── README.es.md                                  ← Este archivo (Español)
├── backend/
│   └── collective.mfblocks/                      ← Plone add-on
│       ├── pyproject.toml
│       └── src/collective/mfblocks/
│           ├── content/mfblock.py                ← Content Type IMFBlock
│           ├── services/blocks_registry.py       ← GET @blocks-registry
│           ├── services/mfblocks_manage.py       ← GET/PATCH/POST @mfblocks-manage
│           └── subscribers/mfblock.py            ← Eventos de extraccion/borrado
└── frontend/
    └── volto-mfblocks/                           ← Volto addon
        ├── package.json
        └── src/
            ├── index.ts                          ← applyConfig (registro sincrono)
            ├── mf/loader.ts                      ← loadRemoteModule + shared scope
            ├── mf/MFBlocksLoader.tsx             ← Wrappers View/Edit
            ├── mf/ssrPreRegister.ts              ← Pre-registro SSR
            └── components/MFBlocksControlPanel/  ← Control Panel UI
```

## Requisitos

- Plone 6.1+ con Volto
- Python 3.10+
- Node.js 18+
- pnpm 9+
- Nginx
- git, curl

## Solucion de Problemas

| Problema | Causa | Solucion |
|---|---|---|
| "Unknown Block" en vista publica | SSR no tiene los bloques registrados | Reiniciar `plone-volto` |
| Bloque no aparece en el selector | MFBlock no esta publicado o activo | Verificar en MF Blocks Manager, recargar pagina |
| Bloque aparece en Common en vez de Bricks | Se instalo con `group: "common"` anterior | Eliminar y reinstalar el bloque |
| `null is not an object (useState)` | Instancias duplicadas de React | Verificar shared scope incluye React del host |
| Sidebar vacia al editar | El bloque importa SidebarPortal de Volto | Aplicar Regla de Oro: bloque solo exporta schema |
| Build no incluye addons | Falta `VOLTOCONFIG` | Usar `VOLTOCONFIG=$(pwd)/volto.config.js` |
| Crash `icon: null` en block chooser | Icon es null en blocksConfig | Usa `codeSVG` de `@plone/volto/icons/code.svg` |

## Autor

- **Juan Renteria** — juan.renteria@it4s.mx

## Colaboradores

- **Julia Bernuy S.** — bernuy@unam.mx

## Licencia

MIT
