/**
 * Module Federation Remote Loader
 *
 * Carga un remoteEntry.js de un bloque MF externo.
 * Provee React y ReactDOM en el shared scope para que
 * los bloques usen la MISMA instancia que Volto.
 *
 * Regla #2: El shared scope DEBE incluir React/ReactDOM del host.
 * Sin esto, se crean instancias duplicadas y los hooks fallan.
 */

import React from 'react';
import ReactDOM from 'react-dom';

// Detectar versión de React dinámicamente
const REACT_VERSION = React.version || '18.0.0';

// Cache de containers ya inicializados
const containerCache: Record<string, any> = {};

// Shared scope con React del host — se crea una sola vez
let sharedScope: Record<string, any> | null = null;

function getSharedScope() {
  if (sharedScope) return sharedScope;

  sharedScope = {
    react: {
      [REACT_VERSION]: {
        get: () => Promise.resolve(() => React),
        loaded: true,
        from: 'volto-host',
        eager: false,
      },
    },
    'react-dom': {
      [REACT_VERSION]: {
        get: () => Promise.resolve(() => ReactDOM),
        loaded: true,
        from: 'volto-host',
        eager: false,
      },
    },
  };

  return sharedScope;
}

// Cache de promesas de carga para evitar race conditions
// cuando múltiples instancias del mismo bloque cargan simultáneamente
const scriptPromises: Record<string, Promise<void>> = {};

function loadScript(url: string): Promise<void> {
  // Validate URL: only allow relative paths under /mf-blocks/, no traversal
  if (!url.startsWith('/mf-blocks/') || url.includes('..')) {
    return Promise.reject(
      new Error(`Untrusted remote URL rejected: ${url}. Only /mf-blocks/ URLs are allowed.`),
    );
  }

  if (scriptPromises[url]) return scriptPromises[url];

  scriptPromises[url] = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${url}"]`) as HTMLScriptElement;
    if (existing) {
      if (existing.dataset.loaded === 'true') {
        resolve();
        return;
      }
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error(`Failed to load script: ${url}`)));
      return;
    }

    const script = document.createElement('script');
    script.src = url;
    script.type = 'text/javascript';
    script.async = true;
    script.onload = () => { script.dataset.loaded = 'true'; resolve(); };
    script.onerror = () => reject(new Error(`Failed to load script: ${url}`));
    document.head.appendChild(script);
  });

  return scriptPromises[url];
}

export async function loadRemoteModule(
  remoteName: string,
  remoteUrl: string,
  moduleName: string = './block',
): Promise<any> {
  await loadScript(remoteUrl);

  const container = (window as any)[remoteName];
  if (!container) {
    throw new Error(
      `Remote container "${remoteName}" not found on window after loading ${remoteUrl}`,
    );
  }

  if (!containerCache[remoteName]) {
    await container.init(getSharedScope());
    containerCache[remoteName] = container;
  }

  const factory = await container.get(moduleName);
  const module = factory();
  return module;
}

export default loadRemoteModule;
