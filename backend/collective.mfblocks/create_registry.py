"""
Creates the mf-blocks-registry folder inside Plone.
Run via zconsole:

    zconsole run instance/etc/zope.conf create_registry.py
"""
import transaction

app = app  # noqa: F841 — injected by zconsole

CONTAINER_ID = "mf-blocks-registry"
SITE_ID = None

# Auto-detect Plone site
for obj_id in app.objectIds():
    obj = app[obj_id]
    if hasattr(obj, "portal_type") and obj.portal_type == "Plone Site":
        SITE_ID = obj_id
        break

if not SITE_ID:
    print("[MF] ERROR: No Plone site found.")
    import sys
    sys.exit(1)

portal = app[SITE_ID]
print(f"[MF] Plone site: {SITE_ID}")

if CONTAINER_ID in portal:
    print(f"[MF] {CONTAINER_ID} already exists. Nothing to do.")
    import sys
    sys.exit(0)

# Create folder using OFS (works without FTI registration)
from OFS.Folder import Folder
folder = Folder(CONTAINER_ID)
folder.title = "MF Blocks Registry"
portal._setObject(CONTAINER_ID, folder)

transaction.commit()
print(f"[MF] Created {CONTAINER_ID} folder successfully.")
