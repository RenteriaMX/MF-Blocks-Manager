# Examples

> **[Leer en Español](README.es.md)**

## Spacer Block

A simple block that adds configurable vertical space between blocks.

### Install from Control Panel

**Site Setup → Module Federation Blocks → + Install Block**

| Field | Value |
|---|---|
| **Block Name** | `Spacer` |
| **Block ID** | `spacer` |
| **Remote Name** | `voltoSpacerBlock` |
| **Bundle (.tar.gz)** | Upload `examples/blocks/spacer/spacer.tar.gz` |

> **Note:** The **Remote Module** field is auto-detected from the bundle. You can leave it as `./block` — the backend reads `remoteEntry.js` and sets the correct value automatically.

Click **"Install and Publish"**. Reload the page and the block will appear in the editor under COMMON.

### Properties

| Property | Type | Default | Description |
|---|---|---|---|
| `height` | integer | `100` | Height in pixels (0-2000) |

---

## Create Your Own Block

### Prerequisites

- Node.js 18+
- npm 9+

### Step 1 — Scaffold

Copy the `spacer/` directory as a template:

```bash
cp -r examples/blocks/spacer examples/blocks/my-block
cd examples/blocks/my-block
```

### Step 2 — Source files

Edit the files in `src/`. Every block exports three things from `index.js`:

```
src/
├── index.js      ← Default export: { id, title, view, edit, schema }
├── View.jsx      ← What visitors see (public)
├── Edit.jsx      ← What editors see (preview only, no sidebar code)
└── Schema.js     ← Sidebar fields (Volto JSON Schema format)
```

**View.jsx** — Receives `{ data }` with the field values from the schema:

```jsx
import React from 'react';

const MyBlockView = ({ data }) => {
  return <div>{data.text || 'Default text'}</div>;
};

export default MyBlockView;
```

**Edit.jsx** — Same props. Only renders a preview. The sidebar is handled by Volto automatically using the exported schema:

```jsx
import React from 'react';

const MyBlockEdit = ({ data }) => {
  return (
    <div style={{ border: '1px dashed #999', padding: '1rem' }}>
      {data.text || 'Edit me...'}
    </div>
  );
};

export default MyBlockEdit;
```

**Schema.js** — Volto JSON Schema format. Defines the sidebar fields:

```js
const MyBlockSchema = {
  title: 'My Block',
  fieldsets: [
    {
      id: 'default',
      title: 'Settings',
      fields: ['text', 'color'],
    },
  ],
  properties: {
    text: {
      title: 'Text',
      type: 'string',
      default: 'Hello',
    },
    color: {
      title: 'Color',
      type: 'string',
      widget: 'color_picker',
    },
  },
  required: [],
};

export default MyBlockSchema;
```

**index.js** — Exports block metadata:

```js
import MyBlockView from './View';
import MyBlockEdit from './Edit';
import MyBlockSchema from './Schema';

const MyBlock = {
  id: 'my-block',
  title: 'My Block',
  icon: null,
  group: 'common',
  view: MyBlockView,
  edit: MyBlockEdit,
  schema: MyBlockSchema,
  restricted: false,
  mostUsed: false,
  blockHasOwnFocusManagement: false,
  sidebarTab: 1,
};

export default MyBlock;
```

### Step 3 — Webpack config

Update `webpack.config.js` with a unique remote name and expose key:

```js
const { createBlockConfig } = require('../../shared/webpack.base');

module.exports = createBlockConfig({
  name: 'voltoMyBlockBlock',                  // Unique name (no spaces/special chars)
  exposes: { './MyBlock': './src/index.js' },  // Expose key = PascalCase block name
  blockDir: __dirname,
});
```

The `name` must be globally unique across all MF blocks. Convention: `volto` + PascalCase block name + `Block`.

### Step 4 — Build and package

```bash
npm install
npm run package
# Output: my-block.tar.gz
```

The `package` script runs webpack and creates a `.tar.gz` containing:
- `remoteEntry.js` — Module Federation entry point
- `*.js` — Chunk files (code-split automatically)

### Step 5 — Install

Upload `my-block.tar.gz` from **Site Setup → Module Federation Blocks → + Install Block**.

Fill in:
- **Block Name**: `My Block`
- **Block ID**: `my-block`
- **Remote Name**: `voltoMyBlockBlock` (must match `name` in webpack.config.js)
- **Remote Module**: leave as `./block` (auto-detected)

Click **"Install and Publish"**. Reload the editor page.

---

## The Golden Rule

Blocks ONLY use React. **NEVER** import from `@plone/volto`.

```jsx
// CORRECT
import React from 'react';

// WRONG — will break at runtime
import { SidebarPortal } from '@plone/volto/components';
import { flattenToAppURL } from '@plone/volto/helpers';
```

Why? MF blocks run in an isolated webpack container. They share React with the host via Module Federation, but they do NOT have access to Volto's internal modules. The host handles the sidebar automatically using the exported `schema`.

## File structure

```
examples/
├── shared/
│   └── webpack.base.js    ← Shared webpack config (Module Federation + React)
├── blocks/
│   └── spacer/
│       ├── src/
│       │   ├── index.js
│       │   ├── View.jsx
│       │   ├── Edit.jsx
│       │   └── Schema.js
│       ├── webpack.config.js
│       ├── package.json
│       └── spacer.tar.gz  ← Ready-to-upload bundle
├── README.md              ← This file
└── README.es.md           ← Spanish version
```
