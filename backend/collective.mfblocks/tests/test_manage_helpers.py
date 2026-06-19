"""Tests for the pure helpers in services/mfblocks_manage.py.

The module imports Plone packages at the top, so these tests are
skipped automatically in environments without Plone installed.
"""

import io
import json
import tarfile

import pytest

pytest.importorskip("plone.restapi")

from collective.mfblocks.services import mfblocks_manage as manage  # noqa: E402


def make_targz(files):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for name, content in files.items():
            data = content.encode("utf-8")
            info = tarfile.TarInfo(name=name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()


# ─── mf-manifest.json (contrato explicito) ───────────────────────


def test_read_manifest_from_bundle():
    manifest = {"name": "voltoSpacerBlock", "module": "./SpacerBlock", "version": "1.2.3"}
    raw = make_targz({"mf-manifest.json": json.dumps(manifest)})
    assert manage._read_manifest_from_bundle(raw) == manifest


def test_read_manifest_nested():
    raw = make_targz({"dist/mf-manifest.json": json.dumps({"version": "2.0.0"})})
    assert manage._read_manifest_from_bundle(raw) == {"version": "2.0.0"}


def test_read_manifest_missing_returns_none():
    raw = make_targz({"remoteEntry.js": "x"})
    assert manage._read_manifest_from_bundle(raw) is None


def test_read_manifest_invalid_json_returns_none():
    raw = make_targz({"mf-manifest.json": "{not json"})
    assert manage._read_manifest_from_bundle(raw) is None


def test_module_from_manifest_valid():
    assert manage._module_from_manifest({"module": "./SpacerBlock"}) == "./SpacerBlock"


@pytest.mark.parametrize(
    "bad", ["../evil", "block", "./a b", "./a;b", "", None, 42]
)
def test_module_from_manifest_rejects_invalid(bad):
    assert manage._module_from_manifest({"module": bad}) is None


def test_module_from_manifest_none_manifest():
    assert manage._module_from_manifest(None) is None


def test_version_from_manifest():
    assert manage._version_from_manifest({"version": "3.1.0"}) == "3.1.0"
    assert manage._version_from_manifest({"version": ""}) is None
    assert manage._version_from_manifest(None) is None
    assert len(manage._version_from_manifest({"version": "1." + "0" * 40})) == 20


# ─── _detect_module_from_bundle ──────────────────────────────────


def test_detect_module_from_remote_entry():
    js = 'var x={"./SpacerBlock":()=>__webpack_require__.e(1)};'
    raw = make_targz({"remoteEntry.js": js})
    assert manage._detect_module_from_bundle(raw) == "./SpacerBlock"


def test_detect_module_missing_pattern_returns_none():
    raw = make_targz({"remoteEntry.js": "var x = 1;"})
    assert manage._detect_module_from_bundle(raw) is None


def test_detect_module_corrupt_bundle_returns_none():
    assert manage._detect_module_from_bundle(b"garbage") is None


# ─── _detect_version_from_bundle ─────────────────────────────────


def test_detect_version_from_package_json():
    raw = make_targz({"package.json": json.dumps({"version": "2.1.0"})})
    assert manage._detect_version_from_bundle(raw) == "2.1.0"


def test_detect_version_nested_package_json():
    raw = make_targz({"dist/package.json": json.dumps({"version": "3.0.1"})})
    assert manage._detect_version_from_bundle(raw) == "3.0.1"


def test_detect_version_no_package_json():
    raw = make_targz({"remoteEntry.js": "x"})
    assert manage._detect_version_from_bundle(raw) is None


def test_detect_version_is_capped_at_20_chars():
    raw = make_targz({"package.json": json.dumps({"version": "1." + "0" * 40})})
    assert len(manage._detect_version_from_bundle(raw)) == 20


# ─── _detect_version_from_filename ───────────────────────────────


@pytest.mark.parametrize(
    "filename,expected",
    [
        ("ColumnRow-1.0.2.tar.gz", "1.0.2"),
        ("block-0.1.0-beta.tar.gz", "0.1.0-beta"),
        ("noversion.tar.gz", None),
        ("", None),
        (None, None),
    ],
)
def test_detect_version_from_filename(filename, expected):
    assert manage._detect_version_from_filename(filename) == expected


# ─── validation regexes ──────────────────────────────────────────


@pytest.mark.parametrize("good", ["spacer", "my-block_2", "ABC123"])
def test_valid_block_id_accepts(good):
    assert manage.VALID_BLOCK_ID.match(good)


@pytest.mark.parametrize("bad", ["../x", "a b", "a/b", "", "a;b"])
def test_valid_block_id_rejects(bad):
    assert not manage.VALID_BLOCK_ID.match(bad)


@pytest.mark.parametrize(
    "good", ["bundle.tar.gz", "Block-1.0.0.tar.gz", "a_b.c-d.tar.gz"]
)
def test_safe_filename_accepts(good):
    assert manage.SAFE_FILENAME_RE.match(good)


@pytest.mark.parametrize(
    "bad", ["../evil.tar.gz", "x.zip", "a b.tar.gz", "x.tar.gz.exe"]
)
def test_safe_filename_rejects(bad):
    assert not manage.SAFE_FILENAME_RE.match(bad)
