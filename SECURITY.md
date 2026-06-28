# Seguridad — MF-Blocks-Manager

Este add-on permite a un **Manager** (`cmf.ManagePortal`) subir un bundle
`.tar.gz` que se extrae a `var/mf-blocks/<block_id>/` y se carga en el navegador
de cada visitante como `remoteEntry.js` (Module Federation).

> ⚠️ **Subir un bloque MF es, por diseño, un _deploy de código_ privilegiado:**
> el JavaScript del bundle se ejecuta **same-origin** en el navegador de todos
> los visitantes. Trátalo con el mismo cuidado que un despliegue de código.

## Controles implementados

| Control | Dónde |
|---|---|
| AuthZ: POST/PATCH/GET-manage requieren `cmf.ManagePortal` | `services/configure.zcml` |
| `@blocks-registry` público solo expone metadatos de bloques **published+active** | `services/blocks_registry.py` |
| Tamaño del bundle comprimido ≤ 50 MB · magic bytes gzip · ≤ 100 miembros | `services/mfblocks_manage.py` |
| **MFB-4** tope de tamaño **descomprimido** (anti gzip-bomb / DoS de disco) | `subscribers/mfblock.py` (`MAX_TOTAL_UNCOMPRESSED`) |
| Anti path-traversal en `block_id` y en cada miembro del tar (realpath) | `subscribers/mfblock.py` |
| Rechazo de symlink/hardlink y de miembros no regulares (FIFO/device) | `subscribers/mfblock.py` |
| Allowlist de URL en el loader (`/mf-blocks/` only; bloquea `..`, `\`, `%2e%2e`) | `frontend/volto-mfblocks/src/mf/loader.ts` |
| CSRF: `plone.protect` solo se exime con Bearer o `Content-Type: application/json` | `services/mfblocks_manage.py` |
| **MFB-5** log de auditoría de creación/cambios (quién subió qué bloque/versión) | logger `collective.mfblocks.audit` |

## Variables de entorno

| Var | Default | Efecto |
|---|---|---|
| `MF_BLOCKS_DIR` | autodetect | Directorio de extracción de bundles |
| `MF_BLOCKS_MAX_UNCOMPRESSED` | `209715200` (200 MB) | Tope del tamaño total descomprimido del tar |
| `MF_BLOCKS_URL_PREFIX` | `/mf-blocks` | Prefijo de URL público de los bundles |

## Recomendaciones de despliegue (defensa en profundidad)

1. **Minimiza quién es Manager.** Es el único rol que puede desplegar bloques.
   La validación garantiza *dónde* caen los archivos y que estén bien formados,
   **no** que el JS sea benigno.
2. **Auditoría.** Enruta el logger `collective.mfblocks.audit` a su propio
   archivo y revísalo. Ejemplo (logging config de la instancia):
   ```
   [logger_mfblocks_audit]
   level=INFO
   handlers=auditfile
   qualname=collective.mfblocks.audit
   ```
3. **CSP (Content-Security-Policy).** Restringe el origen de scripts a same-origin.
   No impide un bundle malicioso subido por un Manager (es same-origin), pero
   corta inyección de scripts de terceros y `eval` descuidado. En el `server`
   de nginx del sitio:
   ```nginx
   add_header Content-Security-Policy "script-src 'self'; object-src 'none'; base-uri 'self'" always;
   ```
   Ajusta si Volto requiere `'unsafe-inline'`/`'unsafe-eval'` en tu build; el
   objetivo mínimo es excluir orígenes de script externos.

## Tests

```bash
cd backend/collective.mfblocks && PYTHONPATH=src python3 -m pytest tests/ -q
```
Cubre el hardening del tar (traversal, symlink/hardlink, gzip-bomb) sin requerir
una capa de test de Plone.
