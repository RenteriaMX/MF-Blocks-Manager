"""Tests for the bundle extraction security code (subscribers/mfblock.py).

These tests cover the tar hardening: path traversal via block_id,
symlink/hardlink rejection, member path escapes, and cleanup on
invalid bundles. They use stubs instead of Plone content objects,
so they run with plain pytest (no Plone test layer needed).
"""

import io
import os
import tarfile
import types

import pytest

from collective.mfblocks.subscribers import mfblock


@pytest.fixture
def blocks_dir(tmp_path, monkeypatch):
    """Point MF_BLOCKS_DIR at a temp dir for the duration of the test."""
    target = tmp_path / "mf-blocks"
    target.mkdir()
    monkeypatch.setattr(mfblock, "MF_BLOCKS_DIR", str(target))
    return target


def make_targz(files, member_hook=None):
    """Build an in-memory .tar.gz from a {name: content} dict."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for name, content in files.items():
            data = content.encode("utf-8")
            info = tarfile.TarInfo(name=name)
            info.size = len(data)
            if member_hook:
                member_hook(info)
            tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()


def make_obj(block_id, bundle_bytes, title="Test Block"):
    """Stub that mimics the MFBlock attributes extract_bundle reads."""
    bundle = types.SimpleNamespace(data=bundle_bytes)
    return types.SimpleNamespace(block_id=block_id, bundle=bundle, title=title)


# ─── _validate_block_id ──────────────────────────────────────────


def test_valid_block_id(blocks_dir):
    result = mfblock._validate_block_id("my-block_1")
    assert result == os.path.realpath(str(blocks_dir / "my-block_1"))


@pytest.mark.parametrize(
    "bad_id",
    ["../evil", "..", "a/b", "a\\b", "a b", "", "block;rm", ".hidden/.."],
)
def test_invalid_block_id_rejected(blocks_dir, bad_id):
    assert mfblock._validate_block_id(bad_id) is None


# ─── _get_safe_tar_members ───────────────────────────────────────


def test_safe_members_accepts_normal_files(blocks_dir, tmp_path):
    raw = make_targz({"remoteEntry.js": "x", "static/chunk.js": "y"})
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz") as tar:
        members = mfblock._get_safe_tar_members(tar, str(blocks_dir / "b"))
    assert members is not None
    assert {m.name for m in members} == {"remoteEntry.js", "static/chunk.js"}


def test_safe_members_rejects_path_escape(blocks_dir):
    raw = make_targz({"../escape.js": "x"})
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz") as tar:
        assert mfblock._get_safe_tar_members(tar, str(blocks_dir / "b")) is None


def test_safe_members_rejects_symlink(blocks_dir):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        info = tarfile.TarInfo(name="link.js")
        info.type = tarfile.SYMTYPE
        info.linkname = "/etc/passwd"
        tar.addfile(info)
    with tarfile.open(fileobj=io.BytesIO(buf.getvalue()), mode="r:gz") as tar:
        assert mfblock._get_safe_tar_members(tar, str(blocks_dir / "b")) is None


def test_safe_members_rejects_hardlink(blocks_dir):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        info = tarfile.TarInfo(name="hard.js")
        info.type = tarfile.LNKTYPE
        info.linkname = "remoteEntry.js"
        tar.addfile(info)
    with tarfile.open(fileobj=io.BytesIO(buf.getvalue()), mode="r:gz") as tar:
        assert mfblock._get_safe_tar_members(tar, str(blocks_dir / "b")) is None


# ─── extract_bundle ──────────────────────────────────────────────


def test_extract_bundle_deploys_files(blocks_dir):
    raw = make_targz({"remoteEntry.js": "console.log(1)", "sub/a.js": "x"})
    mfblock.extract_bundle(make_obj("spacer", raw), None)
    assert (blocks_dir / "spacer" / "remoteEntry.js").read_text() == "console.log(1)"
    assert (blocks_dir / "spacer" / "sub" / "a.js").exists()


def test_extract_bundle_replaces_previous_deploy(blocks_dir):
    old = blocks_dir / "spacer"
    old.mkdir()
    (old / "stale.js").write_text("old")
    raw = make_targz({"remoteEntry.js": "new"})
    mfblock.extract_bundle(make_obj("spacer", raw), None)
    assert not (old / "stale.js").exists()
    assert (old / "remoteEntry.js").exists()


def test_extract_bundle_rejects_traversal_block_id(blocks_dir, tmp_path):
    raw = make_targz({"remoteEntry.js": "x"})
    mfblock.extract_bundle(make_obj("../outside", raw), None)
    assert not (tmp_path / "outside").exists()


def test_extract_bundle_cleans_up_on_unsafe_tar(blocks_dir):
    raw = make_targz({"../escape.js": "x"})
    mfblock.extract_bundle(make_obj("spacer", raw), None)
    assert not (blocks_dir / "spacer").exists()


def test_extract_bundle_cleans_up_on_corrupt_gzip(blocks_dir):
    mfblock.extract_bundle(make_obj("spacer", b"not a gzip"), None)
    assert not (blocks_dir / "spacer").exists()


def test_extract_bundle_skips_without_bundle(blocks_dir):
    obj = types.SimpleNamespace(block_id="spacer", bundle=None, title="T")
    mfblock.extract_bundle(obj, None)
    assert not (blocks_dir / "spacer").exists()


# ─── remove_bundle ───────────────────────────────────────────────


def test_remove_bundle_deletes_deploy(blocks_dir):
    deployed = blocks_dir / "spacer"
    deployed.mkdir()
    (deployed / "remoteEntry.js").write_text("x")
    obj = types.SimpleNamespace(block_id="spacer")
    mfblock.remove_bundle(obj, None)
    assert not deployed.exists()


def test_remove_bundle_rejects_traversal(blocks_dir, tmp_path):
    victim = tmp_path / "victim"
    victim.mkdir()
    obj = types.SimpleNamespace(block_id="../victim")
    mfblock.remove_bundle(obj, None)
    assert victim.exists()
