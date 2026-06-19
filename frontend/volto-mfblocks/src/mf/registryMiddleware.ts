/**
 * Express middleware: GET /@@mfblocks-registry
 *
 * Sirve el registry de bloques MF desde el propio servidor Volto
 * (same-origin). El cliente lo consulta en el boot con un XHR síncrono
 * MUY barato: el handler intenta un fetch asíncrono al backend (frescura)
 * y, si el backend no responde, contesta con la última copia en memoria.
 *
 * Esto desacopla el arranque del browser de la disponibilidad/latencia
 * del backend Plone: el peor caso es una respuesta instantánea con datos
 * de hasta un ciclo de polling de antigüedad.
 */

import { fetchRegistry, getRegistryCache } from './ssrPreRegister';

const express = require('express');

export default function makeRegistryMiddleware() {
  const middleware = express.Router();

  middleware.get('/@@mfblocks-registry', async (req: any, res: any) => {
    const blocks = await fetchRegistry();
    res.setHeader('Cache-Control', 'no-store');
    res.json({ blocks: blocks !== null ? blocks : getRegistryCache() });
  });

  middleware.id = 'mfblocks-registry';
  return middleware;
}
