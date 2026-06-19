/**
 * SSR Pre-Registration
 *
 * En el arranque del servidor Node.js hace UN fetch síncrono a
 * @blocks-registry (via curl, antes de aceptar requests) y pre-registra
 * los bloques con placeholders.
 *
 * Después del arranque, el refresco es 100% asíncrono (fetch nativo de
 * Node 18+): nunca vuelve a bloquear el event loop. Cada ciclo registra
 * bloques nuevos Y des-registra los eliminados/desactivados.
 *
 * Regla #3: Sin el pre-registro, los visitantes anónimos ven "Unknown Block".
 * Nota: el placeholder renderiza null — el contenido del bloque MF no se
 * server-renderiza; solo se evita el "Unknown Block" (ver Limitaciones en
 * el README).
 */

const SSRPlaceholder = () => null;

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

// Última respuesta válida del registry — la sirve el middleware express
// como fallback cuando el backend no responde.
let registryCache: any[] = [];

export function getRegistryCache(): any[] {
  return registryCache;
}

function getRegistryUrl(): string | null {
  const internalApi =
    process.env.RAZZLE_INTERNAL_API_PATH ||
    process.env.RAZZLE_API_PATH ||
    '';

  if (!internalApi) {
    console.warn(
      '[MF SSR] No API path configured. Set RAZZLE_INTERNAL_API_PATH or RAZZLE_API_PATH.',
    );
    return null;
  }

  const url = `${internalApi}/@blocks-registry`;

  // Validate URL: only allow http(s) to prevent command injection via env var
  if (!/^https?:\/\//.test(url)) {
    console.warn('[MF SSR] Invalid API URL, skipping pre-registration.');
    return null;
  }

  return url;
}

/**
 * Fetch asíncrono del registry (Node 18+ fetch nativo, timeout 5s).
 * Devuelve la lista de bloques o null si el backend no responde.
 */
export async function fetchRegistry(): Promise<any[] | null> {
  const url = getRegistryUrl();
  if (!url) return null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return null;
    const data = await resp.json();
    const blocks = data.blocks || [];
    registryCache = blocks;
    return blocks;
  } catch (err: any) {
    console.warn(`[MF SSR] Async registry fetch failed: ${err.message}`);
    return null;
  }
}

/**
 * Aplica el registry al config de Volto:
 * - registra placeholders para bloques nuevos
 * - des-registra los bloques _mfSSR que ya no están en el registry
 *   (eliminados o desactivados)
 */
function applyRegistrySSR(config: any, blocks: any[]) {
  const seen = new Set(blocks.map((b: any) => b.block_id || b.name));

  // Des-registrar bloques MF que el registry ya no lista
  let removed = 0;
  for (const id of Object.keys(config.blocks?.blocksConfig || {})) {
    if (config.blocks.blocksConfig[id]?._mfSSR && !seen.has(id)) {
      delete config.blocks.blocksConfig[id];
      removed++;
    }
  }

  const icon = getCodeSVG();
  let added = 0;

  for (const entry of blocks) {
    const blockId = entry.block_id || entry.name;

    // No sobreescribir bloques nativos de Volto
    if (
      config.blocks?.blocksConfig?.[blockId] &&
      !config.blocks.blocksConfig[blockId]._mfSSR
    ) {
      continue;
    }

    if (config.blocks.blocksConfig[blockId]?._mfSSR) continue;

    config.blocks.blocksConfig[blockId] = {
      id: blockId,
      title: entry.title || blockId,
      icon,
      group: entry.group || 'bricks',
      view: SSRPlaceholder,
      edit: SSRPlaceholder,
      restricted: false,
      mostUsed: false,
      sidebarTab: 1,
      blockHasOwnFocusManagement: false,
      _mf: true,
      _mfSSR: true,
    };
    added++;
  }

  if (added > 0 || removed > 0) {
    console.info(
      `[MF SSR] Registry applied: +${added} block(s), -${removed} stale.`,
    );
  }
}

/**
 * Pre-registro SÍNCRONO — se ejecuta UNA sola vez en el arranque,
 * antes de que el servidor acepte requests. Usa curl (requisito ya
 * declarado en el README) porque Node no tiene HTTP síncrono nativo.
 */
export function preRegisterMFBlocksSSR(config: any) {
  const url = getRegistryUrl();
  if (!url) return;

  try {
    const { execFileSync } = require('child_process');
    const raw = execFileSync(
      'curl',
      ['-s', '-m', '5', '-H', 'Accept: application/json', url],
      { timeout: 6000, encoding: 'utf-8' },
    );

    const data = JSON.parse(raw);
    const blocks = data.blocks || [];
    registryCache = blocks;
    applyRegistrySSR(config, blocks);
  } catch (err: any) {
    console.warn(`[MF SSR] Could not pre-register blocks: ${err.message}`);
  }
}

/**
 * Refresco periódico ASÍNCRONO (no bloquea el event loop):
 * - Primeros 2 minutos: cada 10 segundos (cubre el arranque lento del backend)
 * - Después: cada 60 segundos (detecta bloques instalados/eliminados en caliente)
 */
export function startSSRPolling(config: any) {
  const refresh = async () => {
    const blocks = await fetchRegistry();
    if (blocks !== null) applyRegistrySSR(config, blocks);
  };

  const fast = setInterval(refresh, 10_000);

  setTimeout(() => {
    clearInterval(fast);
    setInterval(refresh, 60_000);
  }, 120_000);
}
