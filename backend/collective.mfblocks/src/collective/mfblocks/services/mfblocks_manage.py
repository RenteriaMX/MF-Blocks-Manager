"""
@mfblocks-manage endpoint

GET   -> Lista todos los MFBlock con estado, versión, etc.
PATCH -> Cambiar estado (publish/retract) o activar/desactivar.
POST  -> Crear un nuevo MFBlock con bundle incluido.
"""

import base64
import io
import json
import logging
import re
import tarfile

from plone import api
from plone.namedfile.file import NamedBlobFile
from plone.protect.interfaces import IDisableCSRFProtection
from plone.restapi.services import Service
from zope.interface import alsoProvides
from zope.interface import implementer
from zope.publisher.interfaces import IPublishTraverse

logger = logging.getLogger(__name__)

# MFB-5: log de auditoria dedicado. La subida/actualizacion de un bloque MF es
# un DEPLOY DE CODIGO privilegiado (el remoteEntry.js se ejecuta same-origin en
# el navegador de cada visitante), por eso se registra QUIEN hizo QUE. Se puede
# enrutar a su propio handler/archivo via logging config ("collective.mfblocks.audit").
audit = logging.getLogger("collective.mfblocks.audit")


def _current_user_id():
    """Id del usuario autenticado (para la pista de auditoria)."""
    try:
        user = api.user.get_current()
        return (user.getId() if user else None) or "<anon>"
    except Exception:
        return "<unknown>"


# Límite de tamaño del bundle: 50 MB
MAX_BUNDLE_SIZE = 50 * 1024 * 1024

# Regex para block_id válido
VALID_BLOCK_ID = re.compile(r"^[a-zA-Z0-9_-]+$")

# Regex para detectar módulos expuestos en remoteEntry.js
# Busca patrones como: {"./SpacerBlock":()=>...}
EXPOSED_MODULE_RE = re.compile(r'"(\./[^"]+)":\(\)=>')


# Límites de longitud para campos de texto
MAX_TITLE_LENGTH = 200
MAX_REMOTE_NAME_LENGTH = 200
MAX_FILENAME_LENGTH = 255
SAFE_FILENAME_RE = re.compile(r"^[a-zA-Z0-9._-]+\.tar\.gz$")

# Máximo de miembros a inspeccionar en un tar.gz (previene tar bombs)
MAX_TAR_MEMBERS = 100


def _csrf_exempt_if_token_auth(request):
    """Desactiva plone.protect para escrituras restapi que NO son vulnerables
    a CSRF clasico:

    1. Bearer token: un atacante cross-site no puede fijar el header
       Authorization, asi que el CSRF clasico no aplica.
    2. Cuerpo JSON (Content-Type: application/json): un POST/PATCH cross-site
       con ese content-type dispara un *preflight* CORS, que un origen atacante
       no puede pasar -> el navegador bloquea el envio. Por eso una escritura
       restapi JSON autenticada es segura aunque la auth sea por cookie (__ac).

    Nota: el panel de control de Volto a veces llega con auth por cookie (sin
    Bearer); sin el caso (2), plone.protect aborta la transaccion y el MFBlock
    se revierte (el bundle se extrae pero el contenido no queda) -> registro en 0.
    """
    auth = request.getHeader("Authorization") or ""
    if auth.lower().startswith("bearer "):
        alsoProvides(request, IDisableCSRFProtection)
        return

    ctype = (request.getHeader("Content-Type") or "").lower()
    if ctype.startswith("application/json"):
        alsoProvides(request, IDisableCSRFProtection)


# Regex para validar el module path declarado en el manifest
VALID_REMOTE_MODULE = re.compile(r"^\./[a-zA-Z0-9._/-]+$")


def _read_manifest_from_bundle(bundle_bytes):
    """Lee mf-manifest.json del bundle: el contrato explicito del bloque.

    El webpack.base de examples/ lo emite automaticamente con
    {name, module, version}. Es la fuente preferida sobre el parsing
    por regex del remoteEntry.js minificado.
    """
    try:
        with tarfile.open(fileobj=io.BytesIO(bundle_bytes), mode="r:gz") as tar:
            for i, member in enumerate(tar.getmembers()):
                if i >= MAX_TAR_MEMBERS:
                    break
                if member.name == "mf-manifest.json" or member.name.endswith("/mf-manifest.json"):
                    f = tar.extractfile(member)
                    if f:
                        data = json.loads(f.read().decode("utf-8"))
                        if isinstance(data, dict):
                            return data
    except Exception:
        pass
    return None


def _module_from_manifest(manifest):
    """Valida y devuelve el module path del manifest, o None."""
    if not manifest:
        return None
    module = manifest.get("module", "")
    if isinstance(module, str) and VALID_REMOTE_MODULE.match(module):
        return module[:200]
    return None


def _version_from_manifest(manifest):
    if not manifest:
        return None
    version = manifest.get("version", "")
    if isinstance(version, str) and version.strip():
        return version.strip()[:20]
    return None


def _detect_module_from_bundle(bundle_bytes):
    """Auto-detecta el módulo expuesto leyendo remoteEntry.js del tar.gz."""
    try:
        with tarfile.open(fileobj=io.BytesIO(bundle_bytes), mode="r:gz") as tar:
            for i, member in enumerate(tar.getmembers()):
                if i >= MAX_TAR_MEMBERS:
                    break
                if member.name.endswith("remoteEntry.js"):
                    f = tar.extractfile(member)
                    if f:
                        content = f.read().decode("utf-8", errors="ignore")
                        matches = EXPOSED_MODULE_RE.findall(content)
                        if matches:
                            return matches[0]
    except Exception:
        pass
    return None


def _detect_version_from_bundle(bundle_bytes):
    """Auto-detect version from package.json inside the tar.gz."""
    try:
        with tarfile.open(fileobj=io.BytesIO(bundle_bytes), mode="r:gz") as tar:
            for i, member in enumerate(tar.getmembers()):
                if i >= MAX_TAR_MEMBERS:
                    break
                if member.name == "package.json" or member.name.endswith("/package.json"):
                    f = tar.extractfile(member)
                    if f:
                        pkg = json.loads(f.read().decode("utf-8"))
                        version = pkg.get("version", "").strip()
                        if version:
                            return version[:20]
    except Exception:
        pass
    return None


# Matches patterns like: Name-1.0.2.tar.gz, name-2.3.0.tgz, block-0.1.0-beta.tar.gz
VERSION_FROM_FILENAME_RE = re.compile(r"-(\d+\.\d+\.\d+[a-zA-Z0-9._-]*)\.tar\.gz$|\.tgz$")


def _detect_version_from_filename(filename):
    """Extract version from filename like 'ColumnRow-1.0.2.tar.gz' -> '1.0.2'."""
    if not filename:
        return None
    m = VERSION_FROM_FILENAME_RE.search(filename)
    if m and m.group(1):
        return m.group(1)[:20]
    return None


# Container name declarado en remoteEntry.js (convencion del proyecto: voltoXBlock).
CONTAINER_NAME_RE = re.compile(r"\bvolto[A-Za-z0-9]+Block\b")


def _name_from_manifest(manifest):
    """Nombre del contenedor MF segun mf-manifest.json (fuente preferida y exacta).

    El webpack.base de examples/ emite mf-manifest.json con {name, module, version};
    'name' es el global que el host busca en window. Es el contrato explicito.
    """
    if not manifest:
        return None
    name = manifest.get("name", "")
    if isinstance(name, str) and name.strip():
        return name.strip()[:MAX_REMOTE_NAME_LENGTH]
    return None


def _detect_name_from_bundle(bundle_bytes):
    """Auto-detecta el nombre del contenedor leyendo remoteEntry.js del tar.gz.

    Fallback para bundles sin mf-manifest.json. Usa la convencion voltoXBlock.
    Asi el `remote_name` SIEMPRE sale del bundle tal como se compilo: el operador
    no teclea nada y nunca hay mismatch de mayusculas con lo que pide el host.
    """
    try:
        with tarfile.open(fileobj=io.BytesIO(bundle_bytes), mode="r:gz") as tar:
            for i, member in enumerate(tar.getmembers()):
                if i >= MAX_TAR_MEMBERS:
                    break
                if member.name.endswith("remoteEntry.js"):
                    f = tar.extractfile(member)
                    if f:
                        content = f.read().decode("utf-8", errors="ignore")
                        m = CONTAINER_NAME_RE.search(content)
                        if m:
                            return m.group(0)
    except Exception:
        pass
    return None


def _resolve_remote_name(manifest, bundle_bytes, provided=""):
    """Resuelve el remote_name con el BUNDLE como fuente de verdad.

    Orden: mf-manifest.json `name` > regex sobre remoteEntry.js > lo provisto.
    Si el operador mando algo distinto a lo detectado, gana el bundle (se loguea):
    el nombre que el host busca es el que el bundle declara, no lo tecleado.
    """
    detected = _name_from_manifest(manifest) or _detect_name_from_bundle(bundle_bytes)
    if detected:
        if provided and provided != detected:
            logger.info("[MF] remote_name '%s' ignorado; se usa el del bundle: '%s'",
                        provided, detected)
        return detected
    return (provided or "").strip()[:MAX_REMOTE_NAME_LENGTH]


@implementer(IPublishTraverse)
class MFBlocksManageGet(Service):
    """GET /@mfblocks-manage"""

    def reply(self):
        blocks = []

        portal = api.portal.get()
        container_id = "mf-blocks-registry"
        if container_id not in portal:
            self.request.response.setHeader("Content-Type", "application/json")
            return {"blocks": [], "total": 0}

        container = portal[container_id]

        for obj_id in container.objectIds():
            try:
                obj = container[obj_id]
            except Exception:
                continue

            if getattr(obj, "portal_type", None) != "MFBlock":
                continue

            state = api.content.get_state(obj, default="private")

            blocks.append({
                "uid": obj.UID() if hasattr(obj, "UID") else obj_id,
                "title": obj.title or "",
                "block_id": getattr(obj, "block_id", ""),
                "remote_name": getattr(obj, "remote_name", ""),
                "version": getattr(obj, "version", "1.0.0") or "1.0.0",
                "group": getattr(obj, "block_group", "bricks"),
                "active": getattr(obj, "active", True),
                "review_state": state,
                "url": obj.absolute_url(),
                "path": "/".join(obj.getPhysicalPath()),
                "created": obj.created().ISO8601() if obj.created() else "",
                "modified": obj.modified().ISO8601() if obj.modified() else "",
            })

        blocks.sort(key=lambda b: b["title"].lower())

        self.request.response.setHeader("Content-Type", "application/json")
        return {"blocks": blocks, "total": len(blocks)}


@implementer(IPublishTraverse)
class MFBlocksManagePatch(Service):
    """PATCH /@mfblocks-manage"""

    def reply(self):
        _csrf_exempt_if_token_auth(self.request)

        data = json.loads(self.request.get("BODY", "{}"))

        uid = data.get("uid")
        block_id = data.get("block_id")
        action = data.get("action")

        if not action:
            self.request.response.setStatus(400)
            return {"error": "action es obligatorio"}

        if not uid and not block_id:
            self.request.response.setStatus(400)
            return {"error": "uid o block_id es obligatorio"}

        portal = api.portal.get()
        container_id = "mf-blocks-registry"
        obj = None

        if container_id in portal:
            container = portal[container_id]
            if block_id and block_id in container.objectIds():
                obj = container[block_id]
            elif uid:
                for oid in container.objectIds():
                    candidate = container[oid]
                    if hasattr(candidate, "UID") and candidate.UID() == uid:
                        obj = candidate
                        break

        if obj is None:
            self.request.response.setStatus(404)
            return {"error": "Bloque no encontrado"}

        if getattr(obj, "portal_type", None) != "MFBlock":
            self.request.response.setStatus(400)
            return {"error": "El objeto no es un MFBlock"}

        result = {"uid": uid, "action": action, "success": True}

        try:
            if action == "publish":
                api.content.transition(obj=obj, transition="publish")
                result["review_state"] = "published"
            elif action == "retract":
                api.content.transition(obj=obj, transition="retract")
                result["review_state"] = "private"
            elif action == "activate":
                obj.active = True
                obj.reindexObject()
                result["active"] = True
            elif action == "deactivate":
                obj.active = False
                obj.reindexObject()
                result["active"] = False
            elif action == "update":
                bundle_data = data.get("bundle_data")
                new_version = data.get("version", "").strip()[:20]
                if not bundle_data:
                    self.request.response.setStatus(400)
                    return {"error": "bundle_data is required for update"}
                bundle_bytes = base64.b64decode(bundle_data)
                if len(bundle_bytes) > MAX_BUNDLE_SIZE:
                    self.request.response.setStatus(413)
                    return {"error": f"Bundle exceeds {MAX_BUNDLE_SIZE // (1024 * 1024)} MB limit"}
                if not bundle_bytes[:2] == b"\x1f\x8b":
                    self.request.response.setStatus(400)
                    return {"error": "Bundle must be a valid .tar.gz file"}
                bundle_filename = data.get("bundle_filename", "bundle.tar.gz")
                if not isinstance(bundle_filename, str) or not SAFE_FILENAME_RE.match(bundle_filename):
                    bundle_filename = "bundle.tar.gz"
                obj.bundle = NamedBlobFile(
                    data=bundle_bytes,
                    contentType="application/gzip",
                    filename=bundle_filename[:MAX_FILENAME_LENGTH],
                )
                update_manifest = _read_manifest_from_bundle(bundle_bytes)
                # remote_name: re-detectar del bundle nuevo (sigue siendo la fuente
                # de verdad), por si el rebuild cambio el nombre del contenedor.
                detected_name = _resolve_remote_name(update_manifest, bundle_bytes,
                                                     getattr(obj, "remote_name", ""))
                if detected_name and detected_name != getattr(obj, "remote_name", ""):
                    logger.info("[MF] remote_name actualizado desde el bundle: %s", detected_name)
                    obj.remote_name = detected_name
                # Version: el input explicito del usuario gana; el auto-detect
                # (manifest > package.json > filename) es solo fallback
                if new_version:
                    obj.version = new_version
                else:
                    detected_version = _version_from_manifest(update_manifest) \
                        or _detect_version_from_bundle(bundle_bytes) \
                        or _detect_version_from_filename(bundle_filename)
                    if detected_version:
                        obj.version = detected_version
                        logger.info("[MF] Auto-detected version on update: %s", detected_version)
                from collective.mfblocks.subscribers.mfblock import extract_bundle
                extract_bundle(obj, None)
                obj.reindexObject()
                result["version"] = obj.version
                result["message"] = "Block updated successfully"
            elif action == "delete":
                title = obj.title
                api.content.delete(obj=obj)
                result["deleted"] = True
                result["title"] = title
            else:
                self.request.response.setStatus(400)
                return {"error": "Acción no reconocida"}
        except PermissionError:
            logger.error("[MF] Permission error on action '%s' for %s", action, uid)
            self.request.response.setStatus(500)
            return {"error": "Sin permisos para realizar esta acción", "success": False}
        except FileNotFoundError:
            logger.error("[MF] File not found on action '%s' for %s", action, uid)
            self.request.response.setStatus(500)
            return {"error": "Archivos del bloque no encontrados en el servidor", "success": False}
        except Exception as e:
            logger.error("[MF] Action '%s' failed for %s: %s", action, uid, str(e), exc_info=True)
            self.request.response.setStatus(500)
            return {"error": "Error al procesar la acción. Revisa los logs del servidor.", "success": False}

        # MFB-5: pista de auditoria (quien hizo que sobre que bloque)
        audit.info(
            "user=%s action=%s block_id=%s uid=%s version=%s",
            _current_user_id(),
            action,
            getattr(obj, "block_id", ""),
            uid,
            result.get("version", getattr(obj, "version", "")),
        )
        return result


@implementer(IPublishTraverse)
class MFBlocksManagePost(Service):
    """POST /@mfblocks-manage — create a new MFBlock."""

    def reply(self):
        _csrf_exempt_if_token_auth(self.request)

        data = json.loads(self.request.get("BODY", "{}"))

        title = data.get("title", "").strip()[:MAX_TITLE_LENGTH]
        block_id = data.get("block_id", "").strip()
        # remote_name es opcional: se auto-detecta del bundle (fuente de verdad).
        remote_name = data.get("remote_name", "").strip()[:MAX_REMOTE_NAME_LENGTH]
        remote_module = data.get("remote_module", "./block").strip()
        version = data.get("version", "1.0.0").strip()[:20]
        group = data.get("group", "bricks").strip()
        bundle_data = data.get("bundle_data")  # base64
        bundle_filename = data.get("bundle_filename", "bundle.tar.gz")
        auto_publish = data.get("auto_publish", True)

        # Validar bundle_filename
        if not isinstance(bundle_filename, str) or not SAFE_FILENAME_RE.match(bundle_filename):
            bundle_filename = "bundle.tar.gz"
        bundle_filename = bundle_filename[:MAX_FILENAME_LENGTH]

        # Validaciones
        if not title:
            self.request.response.setStatus(400)
            return {"error": "El título es obligatorio"}
        if not block_id:
            self.request.response.setStatus(400)
            return {"error": "El block_id es obligatorio"}
        if not VALID_BLOCK_ID.match(block_id):
            self.request.response.setStatus(400)
            return {"error": "block_id solo puede contener letras, números, guiones y guiones bajos"}
        if not bundle_data:
            self.request.response.setStatus(400)
            return {"error": "El bundle (base64) es obligatorio"}

        # Verificar que no exista duplicado
        portal = api.portal.get()
        container_id = "mf-blocks-registry"
        if container_id not in portal:
            self.request.response.setStatus(500)
            return {
                "error": "Carpeta mf-blocks-registry no encontrada. Reinstala el add-on desde Site Setup.",
                "success": False,
            }
        container = portal[container_id]

        if block_id in container.objectIds():
            self.request.response.setStatus(409)
            return {"error": f"Ya existe un bloque con block_id '{block_id}'"}

        try:
            # Decodificar bundle
            bundle_bytes = base64.b64decode(bundle_data)

            # Validar tamaño
            if len(bundle_bytes) > MAX_BUNDLE_SIZE:
                self.request.response.setStatus(413)
                return {"error": f"El bundle excede el límite de {MAX_BUNDLE_SIZE // (1024 * 1024)} MB"}

            # Validar magic bytes de gzip
            if not bundle_bytes[:2] == b"\x1f\x8b":
                self.request.response.setStatus(400)
                return {"error": "El bundle debe ser un archivo .tar.gz válido"}

            manifest = _read_manifest_from_bundle(bundle_bytes)

            # remote_name: el BUNDLE es la fuente de verdad. El operador no teclea
            # nada; sale del bundle tal como se compilo (manifest name > regex).
            remote_name = _resolve_remote_name(manifest, bundle_bytes, remote_name)
            if not remote_name:
                self.request.response.setStatus(400)
                return {"error": "No se pudo detectar el remote_name del bundle "
                                 "(sin mf-manifest.json ni patron voltoXBlock en "
                                 "remoteEntry.js). Recompila el bloque."}

            # Auto-detect module: manifest (contrato explicito) > regex
            # sobre remoteEntry.js (fallback para bundles sin manifest)
            if not remote_module or remote_module == "./block":
                detected = _module_from_manifest(manifest) \
                    or _detect_module_from_bundle(bundle_bytes)
                if detected:
                    remote_module = detected
                    logger.info("[MF] Auto-detected module: %s", remote_module)

            # Version: si el usuario escribio algo distinto al default del
            # formulario ("1.0.0"), su input gana; el auto-detect
            # (manifest > package.json > filename) solo aplica sobre el default
            if not version or version == "1.0.0":
                detected_version = _version_from_manifest(manifest) \
                    or _detect_version_from_bundle(bundle_bytes) \
                    or _detect_version_from_filename(bundle_filename)
                if detected_version:
                    version = detected_version
                    logger.info("[MF] Auto-detected version: %s", version)

            bundle_file = NamedBlobFile(
                data=bundle_bytes,
                contentType="application/gzip",
                filename=bundle_filename,
            )

            # container ya fue obtenido arriba en la verificación de duplicados

            from plone.dexterity.utils import createContent
            obj = createContent("MFBlock", title=title, id=block_id)
            container._setObject(block_id, obj)
            obj = container[block_id]

            obj.remote_name = remote_name
            obj.remote_module = remote_module
            obj.block_id = block_id
            obj.block_group = group
            obj.version = version
            obj.active = True
            obj.bundle = bundle_file

            # Extraer bundle manualmente (el subscriber se dispara en
            # _setObject antes de que el bundle esté asignado)
            from collective.mfblocks.subscribers.mfblock import extract_bundle
            extract_bundle(obj, None)

            if auto_publish:
                api.content.transition(obj=obj, transition="publish")

            obj.reindexObject()

            state = api.content.get_state(obj, default="private")

            # MFB-5: pista de auditoria de la creacion (deploy de codigo)
            audit.info(
                "user=%s action=create block_id=%s version=%s title=%s",
                _current_user_id(),
                block_id,
                version,
                title,
            )

            return {
                "success": True,
                "uid": obj.UID(),
                "title": title,
                "block_id": block_id,
                "review_state": state,
                "message": f"Bloque '{title}' creado y {'publicado' if auto_publish else 'guardado como borrador'}",
            }

        except PermissionError:
            import transaction
            transaction.abort()
            logger.error("[MF] Permission error creating MFBlock '%s'", title, exc_info=True)
            self.request.response.setStatus(500)
            return {"error": "Sin permisos para crear el bloque o extraer el bundle", "success": False}
        except FileNotFoundError:
            import transaction
            transaction.abort()
            logger.error("[MF] File not found creating MFBlock '%s'", title, exc_info=True)
            self.request.response.setStatus(500)
            return {"error": "Directorio de bundles no encontrado. Verifica que MF_BLOCKS_DIR existe y es accesible.", "success": False}
        except Exception as e:
            import transaction
            transaction.abort()
            logger.error("[MF] Failed to create MFBlock '%s': %s", title, str(e), exc_info=True)
            self.request.response.setStatus(500)
            return {"error": "Error al crear el bloque. Revisa los logs del servidor.", "success": False}
