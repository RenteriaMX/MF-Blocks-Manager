"""
Event handler for MFBlock content type.

When an MFBlock is saved (created or modified):
1. Extracts the uploaded .tar.gz bundle
2. Deploys it to MF_BLOCKS_DIR/{block_id}/
3. The block is immediately available via Nginx

When an MFBlock is deleted:
1. Removes the deployed files

Configuration:
  Set environment variable MF_BLOCKS_DIR to change the extraction directory.
  Auto-detection order:
    1. MF_BLOCKS_DIR env var (explicit)
    2. INSTANCE_HOME -> derive <project>/var/mf-blocks
    3. HOME -> <home>/*/var/mf-blocks (first match)
    4. /opt/plone/mf-blocks (legacy fallback)
"""

import glob
import io
import logging
import os
import re
import shutil
import tarfile

logger = logging.getLogger(__name__)


def _resolve_mf_blocks_dir():
    # 1. Explicit env var
    if os.environ.get("MF_BLOCKS_DIR"):
        path = os.environ["MF_BLOCKS_DIR"]
        logger.info("[MF] MF_BLOCKS_DIR from env: %s", path)
        return path

    # 2. Derive from INSTANCE_HOME: .../backend/instance -> .../var/mf-blocks
    instance_home = os.environ.get("INSTANCE_HOME", "")
    if instance_home:
        project = os.path.dirname(os.path.dirname(instance_home))
        candidate = os.path.join(project, "var", "mf-blocks")
        logger.info("[MF] MF_BLOCKS_DIR auto-detected from INSTANCE_HOME: %s", candidate)
        return candidate

    # 3. Scan $HOME/*/var/mf-blocks
    home = os.environ.get("HOME", "")
    if home:
        matches = glob.glob(os.path.join(home, "*", "var", "mf-blocks"))
        if matches:
            logger.info("[MF] MF_BLOCKS_DIR auto-detected from HOME scan: %s", matches[0])
            return matches[0]

    # 4. Legacy fallback
    logger.warning("[MF] MF_BLOCKS_DIR not detected, using default /opt/plone/mf-blocks")
    return "/opt/plone/mf-blocks"


MF_BLOCKS_DIR = _resolve_mf_blocks_dir()

# Regex: solo letras, números, guiones y guiones bajos
VALID_BLOCK_ID = re.compile(r"^[a-zA-Z0-9_-]+$")


def _validate_block_id(block_id):
    """Validate block_id to prevent path traversal."""
    if not VALID_BLOCK_ID.match(block_id):
        logger.error("[MF] Invalid block_id rejected: %s", block_id)
        return None

    target_dir = os.path.realpath(os.path.join(MF_BLOCKS_DIR, block_id))
    base_dir = os.path.realpath(MF_BLOCKS_DIR)

    if not target_dir.startswith(base_dir + os.sep):
        logger.error("[MF] Path traversal detected for block_id: %s", block_id)
        return None

    return target_dir


def _get_safe_tar_members(tar, target_dir):
    """Filter tar members: reject symlinks, hardlinks, and path escapes."""
    safe_members = []
    base = os.path.realpath(target_dir)

    for member in tar.getmembers():
        # Reject symlinks and hardlinks
        if member.issym() or member.islnk():
            logger.error("[MF] Rejected symlink/hardlink in tar: %s", member.name)
            return None

        # Verify extracted path stays within target_dir
        target = os.path.realpath(os.path.join(target_dir, member.name))
        if not target.startswith(base + os.sep) and target != base:
            logger.error("[MF] Path escape in tar member: %s", member.name)
            return None

        safe_members.append(member)

    return safe_members


def extract_bundle(obj, event):
    """Extract the bundle .tar.gz when an MFBlock is created or modified."""

    bundle = getattr(obj, "bundle", None)
    if not bundle:
        logger.warning("[MF] MFBlock '%s' has no bundle, skipping extraction.", obj.title)
        return

    block_id = getattr(obj, "block_id", None)
    if not block_id:
        logger.warning("[MF] MFBlock '%s' has no block_id, skipping.", obj.title)
        return

    target_dir = _validate_block_id(block_id)
    if target_dir is None:
        return

    # Limpiar directorio anterior si existe
    if os.path.exists(target_dir):
        shutil.rmtree(target_dir)

    os.makedirs(target_dir, exist_ok=True)

    try:
        data = bundle.data
        if isinstance(data, bytes):
            fileobj = io.BytesIO(data)
        else:
            # Posponed blob, read from file
            fileobj = io.BytesIO(bundle.open().read())

        with tarfile.open(fileobj=fileobj, mode="r:gz") as tar:
            safe_members = _get_safe_tar_members(tar, target_dir)
            if safe_members is None:
                logger.error("[MF] Bundle rejected for '%s': unsafe tar contents", block_id)
                if os.path.exists(target_dir):
                    shutil.rmtree(target_dir)
                return

            tar.extractall(path=target_dir, members=safe_members)

        logger.info("[MF] Bundle extracted for '%s' -> %s", block_id, target_dir)

    except Exception as e:
        logger.error("[MF] Failed to extract bundle for '%s': %s", block_id, str(e))
        # Limpiar en caso de error
        if os.path.exists(target_dir):
            shutil.rmtree(target_dir)


def remove_bundle(obj, event):
    """Remove deployed files when an MFBlock is deleted."""

    block_id = getattr(obj, "block_id", None)
    if not block_id:
        return

    target_dir = _validate_block_id(block_id)
    if target_dir is None:
        return

    if os.path.exists(target_dir):
        shutil.rmtree(target_dir)
        logger.info("[MF] Removed deployed files for '%s'", block_id)
