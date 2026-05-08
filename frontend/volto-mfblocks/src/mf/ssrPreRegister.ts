/**
 * SSR Pre-Registration (SÍNCRONO)
 *
 * En el servidor Node.js, hace fetch SÍNCRONO a @blocks-registry
 * y pre-registra los bloques con placeholders ANTES de que el
 * servidor acepte requests.
 *
 * Se re-ejecuta periódicamente para detectar bloques instalados
 * después de que Volto arrancó (el backend puede no estar listo
 * al inicio, o se instalan bloques en caliente).
 *
 * Regla #3: Sin esto, los visitantes anónimos ven "Unknown Block".
 */

const SSRPlaceholder = () => null;

// IDs de bloques ya registrados — evita logs repetitivos
const registeredIds = new Set<string>();

let codeSVG: any = null;
let codeSVGLoaded = false;

function getCodeSVG() {
  if (codeSVGLoaded) return codeSVG;
  codeSVGLoaded = true;
  try {
    codeSVG = require('@plone/volto/icons/code.svg');
  } catch {
    codeSVG = null;
  }
  return codeSVG;
}

export function preRegisterMFBlocksSSR(config: any) {
  const internalApi =
    process.env.RAZZLE_INTERNAL_API_PATH ||
    process.env.RAZZLE_API_PATH ||
    '';

  if (!internalApi) {
    console.warn(
      '[MF SSR] No API path configured. Set RAZZLE_INTERNAL_API_PATH or RAZZLE_API_PATH.',
    );
    return;
  }

  const url = `${internalApi}/@blocks-registry`;

  // Validate URL: only allow http(s) to prevent command injection via env var
  if (!/^https?:\/\//.test(url)) {
    console.warn('[MF SSR] Invalid API URL, skipping pre-registration.');
    return;
  }

  try {
    const { execFileSync } = require('child_process');
    const raw = execFileSync(
      'curl',
      ['-s', '-m', '5', '-H', 'Accept: application/json', url],
      { timeout: 6000, encoding: 'utf-8' },
    );

    const data = JSON.parse(raw);
    const blocks = data.blocks || [];

    if (blocks.length === 0) return;

    const icon = getCodeSVG();
    let newCount = 0;

    for (const entry of blocks) {
      const blockId = entry.block_id || entry.name;

      // No sobreescribir bloques nativos de Volto
      if (
        config.blocks?.blocksConfig?.[blockId] &&
        !config.blocks.blocksConfig[blockId]._mfSSR
      ) {
        continue;
      }

      // Ya registrado en un ciclo anterior
      if (registeredIds.has(blockId)) continue;

      const title = entry.title || blockId;
      const group = entry.group || 'bricks';

      config.blocks.blocksConfig[blockId] = {
        id: blockId,
        title,
        icon,
        group,
        view: SSRPlaceholder,
        edit: SSRPlaceholder,
        restricted: false,
        mostUsed: false,
        sidebarTab: 1,
        blockHasOwnFocusManagement: false,
        _mf: true,
        _mfSSR: true,
      };

      registeredIds.add(blockId);
      newCount++;
    }

    if (newCount > 0) {
      console.info(
        `[MF SSR] Pre-registered ${newCount} new block(s). Total: ${registeredIds.size}`,
      );
    }
  } catch (err: any) {
    console.warn(`[MF SSR] Could not pre-register blocks: ${err.message}`);
  }
}

/**
 * Inicia el polling periódico para detectar bloques nuevos.
 * - Primeros 2 minutos: cada 10 segundos (cubre el arranque lento del backend)
 * - Después: cada 60 segundos (detecta bloques instalados en caliente)
 */
export function startSSRPolling(config: any) {
  // Fase rápida: reintentar cada 10s durante 2 minutos
  const fast = setInterval(() => {
    preRegisterMFBlocksSSR(config);
  }, 10_000);

  setTimeout(() => {
    clearInterval(fast);
    // Fase estable: cada 60s
    setInterval(() => {
      preRegisterMFBlocksSSR(config);
    }, 60_000);
  }, 120_000);
}
