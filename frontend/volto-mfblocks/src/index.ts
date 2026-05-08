/**
 * volto-mfblocks
 *
 * Addon Volto independiente para Module Federation Blocks.
 * Carga bloques remotos en runtime sin recompilar el frontend.
 *
 * Funcionalidad:
 * - Registro síncrono de bloques MF (browser: XMLHttpRequest, SSR: execSync+curl)
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
    // Browser: registro SÍNCRONO con XMLHttpRequest
    try {
      const apiPath =
        (window as any).env?.apiPath ||
        `${window.location.origin}/++api++`;

      const xhr = new XMLHttpRequest();
      xhr.open('GET', `${apiPath}/@blocks-registry`, false);
      xhr.setRequestHeader('Accept', 'application/json');
      xhr.send();

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
    // SSR: registro SÍNCRONO con execSync + curl
    // + polling periódico para detectar bloques instalados después del arranque
    const { preRegisterMFBlocksSSR, startSSRPolling } = require('./mf/ssrPreRegister');
    preRegisterMFBlocksSSR(config);
    startSSRPolling(config);
  }

  return config;
}

export default applyConfig;
