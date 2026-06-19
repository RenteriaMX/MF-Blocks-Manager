/**
 * Redux actions para el API middleware de Volto.
 *
 * Despachar estas actions hace que el middleware de Volto ejecute el
 * request con su plumbing estandar: apiPath correcto, Authorization
 * header con el token vigente del store (incluyendo renovaciones),
 * y manejo uniforme de errores. `dispatch(...)` devuelve una promesa
 * que resuelve con el body de la respuesta.
 */

export const GET_MFBLOCKS = 'GET_MFBLOCKS';
export const MANAGE_MFBLOCK = 'MANAGE_MFBLOCK';
export const CREATE_MFBLOCK = 'CREATE_MFBLOCK';

export function getMFBlocks() {
  return {
    type: GET_MFBLOCKS,
    request: { op: 'get', path: '/@mfblocks-manage' },
  };
}

export function manageMFBlock(data: Record<string, any>) {
  return {
    type: MANAGE_MFBLOCK,
    request: { op: 'patch', path: '/@mfblocks-manage', data },
  };
}

export function createMFBlock(data: Record<string, any>) {
  return {
    type: CREATE_MFBLOCK,
    request: { op: 'post', path: '/@mfblocks-manage', data },
  };
}
