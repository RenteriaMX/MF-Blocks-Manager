/**
 * volto-mfblocks
 *
 * Addon Volto independiente para Module Federation Blocks.
 * Carga bloques remotos en runtime sin recompilar el frontend.
 *
 * Funcionalidad:
 * - Registro de bloques MF (browser: XHR síncrono al endpoint same-origin
 *   /@@mfblocks-registry; SSR: fetch síncrono solo en el arranque + refresco
 *   asíncrono con des-registro de bloques eliminados)
 * - Loader MF con shared scope React/ReactDOM del host
 * - Wrappers View/Edit con SidebarPortal del host
 * - Control Panel en Site Setup para gestión de bloques
 */

import type { ConfigType } from '@plone/registry';

declare const __CLIENT__: boolean;

function applyConfig(config: ConfigType) {
  // ─── Control Panel registration ───────────────────────────
  if (__CLIENT__) {
    const MFBlocksControlPanel =
      require('./components/MFBlocksControlPanel/MFBlocksControlPanel').default;
    const codeSVG = require('@plone/volto/icons/code.svg');

    config.addonRoutes = [
      ...(config.addonRoutes || []),
      {
        path: '/controlpanel/mfblocks-manage',
        component: MFBlocksControlPanel,
      },
    ];

    const apiPath =
      (window as any).env?.apiPath ||
      `${window.location.origin}/++api++`;

    config.settings.controlpanels = [
      ...(config.settings.controlpanels || []),
      {
        '@id': `${apiPath}/@controlpanels/mfblocks-manage`,
        group: 'Add-on Configuration',
        title: 'MF Blocks Manager',
      },
    ];

    config.settings.controlpanelsIcons = {
      ...(config.settings.controlpanelsIcons || {}),
      'mfblocks-manage': codeSVG,
    };
  }

  // ─── Register "Bricks" group for MF blocks ────────────────
  if (!config.blocks.groupBlocksOrder.find((g: any) => g.id === 'bricks')) {
    config.blocks.groupBlocksOrder.push({ id: 'bricks', title: 'Bricks' });
  }

  // ─── Block registration ───────────────────────────────────
  if (__CLIENT__) {
    // Browser: el registro debe completarse ANTES de que Volto congele
    // blocksConfig, por eso es síncrono. Para que ese XHR síncrono no
    // dependa de la latencia/disponibilidad del backend Plone, consulta
    // primero /@@mfblocks-registry — un endpoint same-origin servido por
    // el propio servidor Volto desde memoria (ver registryMiddleware.ts).
    // Solo si ese endpoint no existe (p.ej. build vieja) cae al API.
    try {
      const syncGet = (url: string): XMLHttpRequest => {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', url, false);
        xhr.setRequestHeader('Accept', 'application/json');
        xhr.send();
        return xhr;
      };

      let xhr: XMLHttpRequest | null = null;
      try {
        xhr = syncGet(`${window.location.origin}/@@mfblocks-registry`);
      } catch {
        xhr = null;
      }

      if (!xhr || xhr.status !== 200) {
        const apiPath =
          (window as any).env?.apiPath ||
          `${window.location.origin}/++api++`;
        xhr = syncGet(`${apiPath}/@blocks-registry`);
      }

      if (xhr.status === 200) {
        const { createMFBlockComponents } = require('./mf/MFBlocksLoader');
        const codeSVG = require('@plone/volto/icons/code.svg');
        const data = JSON.parse(xhr.responseText);
        const blocks = data.blocks || [];

        for (const entry of blocks) {
          const blockId = entry.block_id || entry.name;
          const components = createMFBlockComponents(
            entry.name,
            entry.url,
            entry.module || './block',
          );

          config.blocks.blocksConfig[blockId] = {
            id: blockId,
            title: entry.title || blockId,
            icon: codeSVG,
            group: entry.group || 'bricks',
            view: components.View,
            edit: components.Edit,
            restricted: false,
            mostUsed: false,
            sidebarTab: 1,
            blockHasOwnFocusManagement: false,
            _mf: true,
          };

          console.info(`[MF] ✓ Registered block "${blockId}"`);
        }

        if (blocks.length > 0) {
          console.info(
            `[MF] ${blocks.length} block(s) registered synchronously.`,
          );
        }
      }
    } catch (err: any) {
      console.warn('[MF] Sync registry load failed:', err.message);
    }
  } else {
    // SSR: un solo fetch síncrono en el arranque (antes de aceptar requests)
    // + refresco ASÍNCRONO periódico que registra bloques nuevos y
    // des-registra los eliminados/desactivados.
    const { preRegisterMFBlocksSSR, startSSRPolling } = require('./mf/ssrPreRegister');
    const makeRegistryMiddleware = require('./mf/registryMiddleware').default;
    preRegisterMFBlocksSSR(config);
    startSSRPolling(config);

    // Endpoint same-origin /@@mfblocks-registry para el boot del browser
    config.settings.expressMiddleware = [
      ...(config.settings.expressMiddleware || []),
      makeRegistryMiddleware(),
    ];
  }

  return config;
}

export default applyConfig;
