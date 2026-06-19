"""
Setup handlers for collective.mfblocks
"""

import logging

from plone import api
from Products.CMFPlone.interfaces import INonInstallable
from zope.interface import implementer

logger = logging.getLogger("collective.mfblocks")

CONTAINER_ID = "mf-blocks-registry"


@implementer(INonInstallable)
class HiddenProfiles:
    def getNonInstallableProfiles(self):
        return [
            "collective.mfblocks:uninstall",
        ]

    def getNonInstallableProducts(self):
        return []


def uninstall(context):
    """Uninstall handler: remove mf-blocks-registry folder."""
    portal = api.portal.get()

    if CONTAINER_ID not in portal:
        logger.info("[MF] mf-blocks-registry folder not found. Nothing to remove.")
        return

    container = portal[CONTAINER_ID]
    block_count = len(container.contentIds())

    if block_count > 0:
        logger.warning(
            "[MF] Removing mf-blocks-registry with %d block(s) inside.",
            block_count,
        )

    api.content.delete(obj=container, check_linkintegrity=False)
    logger.info("[MF] Removed mf-blocks-registry folder.")
