"""Pruebas de las partes puras de install.py (sin tocar systemd, nginx ni la red). Ejecutar: python3 -m unittest tests/test_install.py"""
import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("mf_install", RAIZ / "install.py")
I = importlib.util.module_from_spec(spec)
spec.loader.exec_module(I)


class VoltoConfig(unittest.TestCase):
    def test_addons_clave(self):
        t, e = I.patch_volto_config("module.exports = { addons: ['volto-x'], theme: '' };")
        self.assertEqual(e, "ok"); self.assertIn("addons: ['volto-mfblocks', 'volto-x']", t)

    def test_addons_array_vacio(self):
        t, e = I.patch_volto_config("const addons = [];\nmodule.exports = { addons };")
        self.assertEqual(e, "ok"); self.assertIn("const addons = ['volto-mfblocks', ];", t)

    def test_const_addons_multilinea(self):
        t, e = I.patch_volto_config("const addons = [\n  'a',\n];")
        self.assertEqual(e, "ok"); self.assertTrue(t.startswith("const addons = ['volto-mfblocks', \n  'a'"))

    def test_ya_registrado_no_cambia(self):
        orig = "const addons = ['volto-mfblocks'];"
        self.assertEqual(I.patch_volto_config(orig), (orig, "ya"))

    def test_formato_desconocido(self):
        self.assertEqual(I.patch_volto_config("module.exports = {};")[1], "manual")

    def test_igual_que_sed(self):
        """Contra el sed del instalador en shell, sobre los dos formatos que soportaba."""
        for orig, patron in (("module.exports = { addons: ['a'] };\n", r"s/addons:\s*\[/addons: ['volto-mfblocks', /"),
                             ("const addons = ['a'];\n", r"s/const addons = \[/const addons = ['volto-mfblocks', /")):
            with tempfile.TemporaryDirectory() as d:
                f = Path(d) / "v.js"; f.write_text(orig)
                r = subprocess.run(["sed", "-E", patron, str(f)], capture_output=True, text=True)
                if r.returncode == 0 and r.stdout != orig:           # el sed de macOS no entiende \s: sin cambio, no hay con qué comparar
                    self.assertEqual(I.patch_volto_config(orig)[0], r.stdout)


class PackageJson(unittest.TestCase):
    def test_agrega_dependencia(self):
        t = I.patch_package_json(json.dumps({"name": "x", "dependencies": {"a": "1"}}))
        self.assertEqual(json.loads(t)["dependencies"], {"a": "1", "volto-mfblocks": "workspace:*"}); self.assertTrue(t.endswith("\n"))

    def test_sin_dependencies(self):
        self.assertEqual(json.loads(I.patch_package_json("{}"))["dependencies"], {"volto-mfblocks": "workspace:*"})

    def test_ya_esta(self):
        self.assertIsNone(I.patch_package_json('{"dependencies": {"volto-mfblocks": "workspace:*"}}'))


class Nginx(unittest.TestCase):
    CONF = "server {\n    listen 80;\n    location / {\n        proxy_pass http://volto;\n    }\n}\n"

    def test_inserta_antes_del_primer_location_raiz(self):
        n = I.insert_location_inline(self.CONF, "/srv/var/mf-blocks")
        self.assertLess(n.index("location /mf-blocks/"), n.index("location / {"))
        self.assertIn("alias /srv/var/mf-blocks/;", n); self.assertIn("proxy_pass http://volto;", n)
        self.assertEqual(n.count("location /mf-blocks/"), 1)

    def test_idempotencia_por_directiva_no_por_comentario(self):
        self.assertIsNone(I.TIENE_LOCATION.search("# nota sobre mf-blocks\nlocation / {}"))
        self.assertIsNotNone(I.TIENE_LOCATION.search("location  /mf-blocks/ {}"))

    def test_sin_location_raiz(self):
        self.assertIsNone(I.insert_location_inline("server { listen 80; }", "/x"))

    def test_bloque_de_drop_in(self):
        b = I.location_block("/srv/mf")
        self.assertIn("alias /srv/mf/;", b); self.assertIn('Cache-Control "no-cache"', b); self.assertIn("Access-Control-Allow-Origin *", b)


class Deteccion(unittest.TestCase):
    def test_proyecto_explicito_inexistente(self):
        with self.assertRaises(I.InstallError):
            I.detect_plone_project("/ruta/que/no/existe")

    def test_nginx_conf_del_proyecto_gana(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "proj"; (p / "etc").mkdir(parents=True); (p / "etc/nginx.conf").write_text("x")
            self.assertEqual(I.detect_nginx_config(p, nginx_root=str(Path(d) / "nginx")), p / "etc/nginx.conf")

    def test_nginx_conf_por_slug(self):
        with tempfile.TemporaryDirectory() as d:
            raiz = Path(d) / "nginx"; (raiz / "conf.d").mkdir(parents=True); (raiz / "conf.d/miproy.conf").write_text("server {}")
            p = Path(d) / "miproy"; p.mkdir()
            self.assertEqual(I.detect_nginx_config(p, nginx_root=str(raiz)), raiz / "conf.d/miproy.conf")

    def test_nginx_conf_por_contenido(self):
        with tempfile.TemporaryDirectory() as d:
            raiz = Path(d) / "nginx"; (raiz / "x").mkdir(parents=True); (raiz / "x/raro.cfg").write_text("location /static/mf {}")
            p = Path(d) / "otro"; p.mkdir()
            self.assertEqual(I.detect_nginx_config(p, nginx_root=str(raiz)), raiz / "x/raro.cfg")

    def test_sin_nginx(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "otro"; p.mkdir()
            self.assertIsNone(I.detect_nginx_config(p, nginx_root=str(Path(d) / "no-hay")))


class NginxEnEjecucion(unittest.TestCase):
    def test_binario_de_la_linea_del_maestro(self):
        self.assertEqual(I.nginx_binary_from_args("nginx: master process /home/u/proj/opt/nginx/sbin/nginx -g daemon off;"),
                         "/home/u/proj/opt/nginx/sbin/nginx")
        self.assertEqual(I.nginx_binary_from_args("nginx: master process /usr/sbin/nginx -g daemon on; master_process on;"), "/usr/sbin/nginx")

    def test_binario_sin_ruta_cae_al_fallback(self):
        self.assertEqual(I.nginx_binary_from_args("nginx: master process nginx", "N"), "N")
        self.assertEqual(I.nginx_binary_from_args("", "N"), "N")

    def test_unidad_del_cgroup(self):
        self.assertEqual(I.unit_from_cgroup("0::/system.slice/heoc-cve-nginx.service\n"), "heoc-cve-nginx")
        self.assertEqual(I.unit_from_cgroup("0::/system.slice/nginx.service"), "nginx")
        self.assertEqual(I.unit_from_cgroup("0::/user.slice/user-1000.slice/user@1000.service/app.slice/x.service/y"), "x")
        self.assertEqual(I.unit_from_cgroup("0::/user.slice/session-3.scope", "nginx"), "nginx")


class Fuente(unittest.TestCase):
    def test_script_embebido_es_python_valido(self):
        compile(I.ZCONSOLE_SCRIPT, "zconsole_script", "exec")


if __name__ == "__main__":
    unittest.main()
