"""
@blocks-registry endpoint

GET @blocks-registry
-> Devuelve la lista de MFBlock publicados y activos
-> Endpoint público: solo expone metadatos (nombres, URLs de remoteEntry.js)
"""

import logging
import os

from plone import api
from plone.restapi.services import Service
from zope.interface import implementer
from zope.publisher.interfaces import IPublishTraverse

logger = logging.getLogger(__name__)

# Configurable via env var. Default: /mf-blocks/
MF_BLOCKS_URL_PREFIX = os.environ.get("MF_BLOCKS_URL_PREFIX", "/mf-blocks")


@implementer(IPublishTraverse)
class BlocksRegistryGet(Service):
    """GET /@blocks-registry — público, devuelve bloques MF activos"""

    def reply(self):

        blocks = []
        seen = set()

        portal = api.portal.get()
        container_id = "mf-blocks-registry"
        if container_id not in portal:
            self.request.response.setHeader("Content-Type", "application/json")
            return {"blocks": []}

        container = portal[container_id]

        for obj_id in container.objectIds():
            try:
                obj = container[obj_id]
            except Exception:
                continue

            if getattr(obj, "portal_type", None) != "MFBlock":
                continue

            # Solo bloques publicados
            state = api.content.get_state(obj, default="private")
            if state != "published":
                continue

            # Solo bloques activos
            if not getattr(obj, "active", True):
                continue

            block_id = getattr(obj, "block_id", "")
            remote_name = getattr(obj, "remote_name", "")
            remote_module = getattr(obj, "remote_module", "./block")

            if not block_id or not remote_name:
                continue

            # Evitar duplicados
            if block_id in seen:
                continue
            seen.add(block_id)

            version = getattr(obj, "version", "1.0.0") or "1.0.0"

            blocks.append({
                "name": remote_name,
                "block_id": block_id,
                "title": obj.title or block_id,
                "group": getattr(obj, "block_group", "bricks"),
                "url": f"{MF_BLOCKS_URL_PREFIX}/{block_id}/remoteEntry.js?v={version}",
                "module": remote_module,
                "version": version,
            })

        self.request.response.setHeader("Content-Type", "application/json")
        return {"blocks": blocks}
