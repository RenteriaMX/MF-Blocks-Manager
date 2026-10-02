#!/usr/bin/env python3
"""
Module Federation Blocks — Instalador automático para Plone 6 (puerto a Python de install.sh; solo stdlib).

Uso:
    curl -sL https://raw.githubusercontent.com/RenteriaMX/MF-Blocks-Manager/main/install.py | python3 -
    curl -sL https://raw.githubusercontent.com/RenteriaMX/MF-Blocks-Manager/main/install.py | python3 - /opt/plone/mi-proyecto
    python3 install.py [ruta/al/proyecto] [--yes] [--dry-run] [--source RUTA]

Opciones:
    --yes       no pregunta nada (usa las respuestas por defecto); es lo que usa el instalador HEOC.
    --dry-run   detecta y muestra el resumen, pero no modifica nada.
    --source    carpeta con una copia del repo (backend/ y frontend/); sin ella se usa la que está junto al script
                o se clona de GitHub.

Qué hace (igual que la versión en shell):
    1. Detecta el proyecto Plone, el usuario, los servicios systemd (de usuario), pip y la config de nginx.
    2. Instala el backend (collective.mfblocks, editable) y el addon de Volto (volto-mfblocks), y compila el frontend.
    3. Prepara var/mf-blocks, el drop-in MF_BLOCKS_DIR de systemd y el `location /mf-blocks/` de nginx (con ACLs).
    4. Activa el add-on en Plone con zconsole.
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO_URL = "https://github.com/RenteriaMX/MF-Blocks-Manager.git"

RED, GREEN, YELLOW, BLUE, NC = "\033[0;31m", "\033[0;32m", "\033[1;33m", "\033[0;34m", "\033[0m"

ARGS = None            # se llena en main()


class InstallError(Exception):
    pass


def log(m):   print(f"{GREEN}[MF-Blocks]{NC} {m}", flush=True)
def warn(m):  print(f"{YELLOW}[MF-Blocks]{NC} {m}", flush=True)
def info(m):  print(f"{BLUE}[MF-Blocks]{NC} {m}", flush=True)
def fail(m):  raise InstallError(m)


# ── utilidades ─────────────────────────────────────────────────────────────────────────────────────────────

def run(cmd, *, cwd=None, env=None, check=True, tail=0, input_text=None):
    """Corre un comando. `tail`=N muestra solo las últimas N líneas de su salida (como `| tail -N`). Con check=True,
    un código distinto de 0 lanza InstallError con las últimas líneas (el .sh dejaba pasar los fallos de pnpm/pip por el pipe)."""
    try:
        r = subprocess.run([str(c) for c in cmd], cwd=cwd, env=env, text=True, capture_output=True, input=input_text)
    except FileNotFoundError:
        if check:
            fail(f"No se encontro el comando '{cmd[0]}'. Instalalo y reintenta.")
        return subprocess.CompletedProcess(cmd, 127, "", f"{cmd[0]}: no encontrado")
    salida = (r.stdout or "") + (r.stderr or "")
    if tail and salida.strip():
        print("\n".join(salida.strip().splitlines()[-tail:]), flush=True)
    if check and r.returncode != 0:
        fail(f"Falló `{' '.join(str(c) for c in cmd)}` (código {r.returncode}):\n" + "\n".join(salida.strip().splitlines()[-30:]))
    return r


def systemd_user(*args):
    """systemctl --user con el entorno que necesita en sesiones sin login gráfico."""
    uid = os.getuid()
    env = dict(os.environ, XDG_RUNTIME_DIR=f"/run/user/{uid}", DBUS_SESSION_BUS_ADDRESS=f"unix:path=/run/user/{uid}/bus")
    try:
        return subprocess.run(["systemctl", "--user", *args], env=env, text=True, capture_output=True)
    except FileNotFoundError:
        return subprocess.CompletedProcess(args, 127, "", "systemctl no encontrado")


def unidades_user(patron_glob=None):
    """Nombres de unidades de servicio del usuario (--all incluye detenidas/fallidas)."""
    cmd = ["list-units", "--all", "--no-legend"] + ([patron_glob] if patron_glob else ["--type=service"])
    r = systemd_user(*cmd)
    out = []
    for ln in (r.stdout or "").splitlines():
        toks = ln.replace("●", " ").replace("*", " ").split()      # systemctl marca con ● las unidades fallidas
        if toks and "." in toks[0]:
            out.append(toks[0])
    return out


def ask(prompt, default=""):
    """Pregunta por la terminal (aunque el script venga por pipe); sin terminal o con --yes usa el valor por defecto."""
    if ARGS and ARGS.yes:
        return default
    try:
        src = sys.stdin if sys.stdin.isatty() else open("/dev/tty")
        sys.stdout.write(prompt)
        sys.stdout.flush()
        ans = src.readline()
        return ans.strip() or default if ans else default
    except OSError:
        return default


# ── 1-5. detección ─────────────────────────────────────────────────────────────────────────────────────────

def detect_plone_project(arg=None):
    if arg:
        p = Path(arg)
        if not p.is_dir():
            fail(f"El directorio {arg} no existe")
        return p.resolve()
    log("Buscando proyectos Plone en /opt/plone/...")
    cands = sorted(d for d in Path("/opt/plone").glob("*/") if (d / "backend").is_dir() and (d / "frontend").is_dir())
    if not cands:
        fail("No se encontro ningun proyecto Plone en /opt/plone/. Usa: install.py /ruta/al/proyecto")
    if len(cands) == 1:
        log(f"Proyecto detectado: {cands[0]}")
        return cands[0]
    print()
    info("Se encontraron multiples proyectos Plone:")
    for i, c in enumerate(cands):
        print(f"  [{i}] {c}")
    print()
    sel = ask("Selecciona el numero del proyecto: ", "0")
    try:
        return cands[int(sel)]
    except (ValueError, IndexError):
        fail(f"Seleccion invalida: {sel}")


def detect_services():
    """(servicio_backend, servicio_frontend) de systemd de usuario, o '' si no hay."""
    nombres = unidades_user()
    be = next((n for n in nombres if re.search(r"plone-.*backend|plone-backend|plone-zeo", n)), "")
    fe = next((n for n in nombres if re.search(r"plone-.*frontend|plone-volto|^volto", n)), "")
    warn("No se detecto servicio de backend. Tendras que reiniciar manualmente.") if not be else log(f"Servicio backend: {be}")
    warn("No se detecto servicio de frontend. Tendras que reiniciar manualmente.") if not fe else log(f"Servicio frontend: {fe}")
    return be, fe


def detect_pip(project):
    """Comando de pip como lista. Prioridad: backend/bin/pip, `uv pip`, backend/.venv/bin/pip, pip."""
    if (project / "backend/bin/pip").is_file():
        cmd = [str(project / "backend/bin/pip")]
    elif shutil.which("uv"):
        cmd = ["uv", "pip"]
    elif (project / "backend/.venv/bin/pip").is_file():
        cmd = [str(project / "backend/.venv/bin/pip")]
    else:
        cmd = ["pip"]
    log(f"Pip detectado: {' '.join(cmd)}")
    return cmd


def detect_nginx_config(project, nginx_root="/etc/nginx"):
    """Config de nginx del sitio: la del proyecto, rutas típicas del sistema, conf.d/<slug>.conf o cualquiera que delate Plone/Volto."""
    cand = [project / "etc/nginx.conf", project / "etc/nginx/nginx.conf"]
    root = Path(nginx_root)
    cand += [root / "sites-enabled/plone.conf", root / "sites-enabled/default", root / "conf.d/plone.conf", root / "conf.d/default.conf"]
    cand += [root / "conf.d" / f"{project.name}.conf"]               # multi-tenant: un server block por slug
    for c in cand:
        if c.is_file():
            log(f"Nginx config: {c}")
            return c
    patron = re.compile(r"proxy_pass.*volto|proxy_pass.*plone|location /static/mf")
    for c in sorted(root.rglob("*")) if root.is_dir() else []:
        try:
            if c.is_file() and patron.search(c.read_text(errors="ignore")):
                log(f"Nginx config: {c}")
                return c
        except OSError:
            continue
    warn("No se detecto config de Nginx.")
    return None


# ── parches de configuración (funciones puras, probadas aparte) ────────────────────────────────────────────

def patch_volto_config(text):
    """Registra 'volto-mfblocks' en volto.config.js. Devuelve (texto, estado): 'ya' | 'ok' | 'manual'."""
    if "volto-mfblocks" in text:
        return text, "ya"
    if "addons:" in text:
        return re.sub(r"addons:\s*\[", "addons: ['volto-mfblocks', ", text, count=1), "ok"
    if "const addons" in text:
        return re.sub(r"const addons\s*=\s*\[", "const addons = ['volto-mfblocks', ", text, count=1), "ok"
    return text, "manual"


def patch_package_json(text):
    """Agrega volto-mfblocks a las dependencias de package.json. None si ya estaba."""
    if "volto-mfblocks" in text:
        return None
    data = json.loads(text)
    data.setdefault("dependencies", {})["volto-mfblocks"] = "workspace:*"
    return json.dumps(data, indent=2) + "\n"


def location_block(mf_dir):
    return ('location /mf-blocks/ {\n'
            f'    alias {mf_dir}/;\n'
            '    add_header Cache-Control "no-cache";\n'
            '    add_header Access-Control-Allow-Origin *;\n'
            '}\n')


def insert_location_inline(content, mf_dir):
    """Inserta el location ANTES del primer `location / {` sin tocar nada más. None si no hay dónde insertarlo."""
    block = ('    # Module Federation Blocks (bundles estaticos)\n'
             '    location /mf-blocks/ {\n'
             f'        alias {mf_dir}/;\n'
             '        add_header Cache-Control "no-cache";\n'
             '        add_header Access-Control-Allow-Origin *;\n'
             '    }\n\n')
    nuevo, n = re.subn(r"(\s*location\s+/\s*\{)", lambda m: block + m.group(1), content, count=1)
    return nuevo if n else None


TIENE_LOCATION = re.compile(r"location\s+/mf-blocks/")


# ── 6-8. repo, backend, frontend ───────────────────────────────────────────────────────────────────────────

def get_source(tmp):
    """Carpeta con backend/ y frontend/ del repo: --source, la que está junto al script, o un clon."""
    cand = []
    if ARGS and ARGS.source:
        cand.append(Path(ARGS.source))
    try:
        cand.append(Path(__file__).resolve().parent)
    except NameError:                                   # ejecutado por stdin (curl | python3 -)
        pass
    for c in cand:
        if (c / "backend/collective.mfblocks").is_dir() and (c / "frontend/volto-mfblocks").is_dir():
            log(f"Usando el código local: {c}")
            return c
    log("Descargando MF-Blocks-Manager...")
    dest = tmp / "mf-blocks"
    r = run(["git", "clone", "--depth", "1", REPO_URL, dest], check=False)
    if r.returncode != 0:
        fail(f"No se pudo clonar {REPO_URL}: {(r.stderr or '').strip()[-200:]}")
    log("Descarga completa.")
    return dest


def replace_dir(origen, destino, nombre):
    if destino.exists():
        warn(f"{nombre} ya existe. Actualizando...")
        shutil.rmtree(destino)
    shutil.copytree(origen, destino, ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "node_modules", ".pytest_cache", "*.egg-info"))


def install_backend(project, src, pip):
    log("=== Instalando Backend ===")
    (project / "backend/packages").mkdir(parents=True, exist_ok=True)
    replace_dir(src / "backend/collective.mfblocks", project / "backend/packages/collective.mfblocks", "collective.mfblocks")
    log("Instalando paquete Python...")
    run([*pip, "install", "--no-config", "-e", "packages/collective.mfblocks"], cwd=project / "backend", tail=3)
    log("Backend instalado correctamente.")


def install_frontend(project, src, frontend_service):
    log("=== Instalando Frontend ===")
    fe = project / "frontend"
    (fe / "packages").mkdir(parents=True, exist_ok=True)
    replace_dir(src / "frontend/volto-mfblocks", fe / "packages/volto-mfblocks", "volto-mfblocks")

    cfg = fe / "volto.config.js"
    if not cfg.is_file():
        fail(f"No se encontro volto.config.js en {fe}")
    nuevo, estado = patch_volto_config(cfg.read_text())
    if estado == "ya":
        log("volto-mfblocks ya esta en volto.config.js")
    elif estado == "ok":
        log("Agregando volto-mfblocks a volto.config.js...")
        cfg.write_text(nuevo)
    else:
        warn("No se pudo detectar el formato de volto.config.js. Agregalo manualmente:")
        warn("  addons: ['volto-mfblocks']")

    pj = fe / "package.json"
    if pj.is_file():
        nuevo = patch_package_json(pj.read_text())
        if nuevo is None:
            log("volto-mfblocks ya esta en package.json")
        else:
            log("Agregando volto-mfblocks a package.json...")
            pj.write_text(nuevo)
            log("package.json actualizado.")

    log("Instalando dependencias npm...")
    run(["pnpm", "install"], cwd=fe, tail=5)
    log("Compilando frontend (esto puede tardar varios minutos)...")
    run(["pnpm", "--filter", "@plone/volto", "build"], cwd=fe, env=dict(os.environ, VOLTOCONFIG=str(cfg)), tail=5)

    if frontend_service:
        log(f"Reiniciando {frontend_service}...")
        systemd_user("restart", frontend_service)
        subprocess.run(["sleep", "3"])
        log("Frontend reiniciado.")
    log("Frontend instalado correctamente.")


# ── 9. bundles y systemd ───────────────────────────────────────────────────────────────────────────────────

def setup_bundles_dir(mf_dir):
    log("=== Configurando directorio de bundles ===")
    if mf_dir.is_dir():
        log(f"{mf_dir} ya existe.")
    else:
        mf_dir.mkdir(parents=True)
        log(f"Directorio creado: {mf_dir}")
    units = unidades_user("plone-*-backend*")
    log(f"Instancias backend detectadas: {len(units)}")
    for svc in units:
        d = Path.home() / ".config/systemd/user" / f"{svc[:-len('.service')] if svc.endswith('.service') else svc}.d"
        d.mkdir(parents=True, exist_ok=True)
        (d / "mf-blocks-env.conf").write_text(f"[Service]\nEnvironment=MF_BLOCKS_DIR={mf_dir}\n")
        log(f"  [{d.name[:-2]}] MF_BLOCKS_DIR={mf_dir}")
    if units:
        systemd_user("daemon-reload")
        log("Systemd recargado.")
    else:
        warn("No se encontraron instancias backend para configurar MF_BLOCKS_DIR.")
        warn(f"Configura manualmente: Environment=MF_BLOCKS_DIR={mf_dir}")


# ── 10. nginx ──────────────────────────────────────────────────────────────────────────────────────────────

def _copiar_con_sudo(origen, destino):
    """cp; si no se puede escribir, con `sudo` INTERACTIVO (nunca `sudo -n`: dar NOPASSWD a setfacl/cp sería una escalada)."""
    d = Path(destino)
    if os.access(d.parent if not d.exists() else d, os.W_OK):
        shutil.copyfile(origen, destino)
    else:
        log("El archivo/dir es de root -> se escribe con sudo (te pedira tu password).")
        if subprocess.run(["sudo", "cp", str(origen), str(destino)]).returncode != 0:
            fail(f"No se pudo escribir {destino} con sudo")


def nginx_user():
    """Usuario de los workers de nginx: el no-root más frecuente en la tabla de procesos; si no, nginx.conf; si no, www-data/nginx."""
    r = subprocess.run(["ps", "-C", "nginx", "-o", "user="], text=True, capture_output=True)
    cuenta = {}
    for u in (r.stdout or "").split():
        if u != "root":
            cuenta[u] = cuenta.get(u, 0) + 1
    if cuenta:
        return max(cuenta, key=cuenta.get)
    try:
        m = re.search(r"^\s*user\s+(\S+?);", Path("/etc/nginx/nginx.conf").read_text(), re.M)
        if m:
            return m.group(1)
    except OSError:
        pass
    import pwd
    for c in ("www-data", "nginx"):
        try:
            pwd.getpwnam(c)
            return c
        except KeyError:
            continue
    return "www-data"


def nginx_binary_from_args(args, fallback="nginx"):
    """Ruta del binario desde la línea de comandos del proceso maestro: «nginx: master process /ruta/nginx -g daemon off;»."""
    m = re.search(r"master process\s+(\S+)", args or "")
    return m.group(1) if m and m.group(1).startswith("/") else fallback


def unit_from_cgroup(text, fallback="nginx"):
    """Unidad de systemd dueña de un proceso, leída de su /proc/<pid>/cgroup («0::/system.slice/heoc-cve-nginx.service»)."""
    for ln in (text or "").splitlines():
        unidades = re.findall(r"/([^/]+)\.service(?=/|$)", ln)
        if unidades:
            return unidades[-1]          # la más interna: bajo una sesión de usuario la primera es user@UID, el administrador
    return fallback


def nginx_runtime():
    """(binario, unidad) del nginx que está CORRIENDO. Con varias instancias (HEOC tiene su propio nginx en ~/<slug>/opt/nginx y
    unidad <slug>-nginx) `sudo nginx -t` / `systemctl reload nginx` apuntaban a uno que no existe o al equivocado."""
    r = subprocess.run(["ps", "-C", "nginx", "-o", "pid=,args="], text=True, capture_output=True)
    for ln in (r.stdout or "").splitlines():
        if "master process" in ln:
            pid, _, args = ln.strip().partition(" ")
            try:
                cg = Path(f"/proc/{pid}/cgroup").read_text()
            except OSError:
                cg = ""
            return nginx_binary_from_args(args, shutil.which("nginx") or "nginx"), unit_from_cgroup(cg)
    return shutil.which("nginx") or "nginx", "nginx"


def setup_nginx(project, nginx_conf, mf_dir, tmp):
    """Devuelve True si quedó todo bien, False si requiere pasos manuales."""
    log("=== Configurando Nginx ===")
    ok = True
    if nginx_conf is None:
        warn("No se detecto config de Nginx. Agrega manualmente:")
        print("\n" + "\n".join("    " + ln for ln in location_block(mf_dir).splitlines()) + "\n")
        return False

    snippet_dir = nginx_conf.with_suffix(".d") if nginx_conf.suffix == ".conf" else Path(str(nginx_conf) + ".d")
    if snippet_dir.is_dir():
        snippet = snippet_dir / "mf-blocks.conf"
        if snippet.is_file() and TIENE_LOCATION.search(snippet.read_text()):
            log(f"location /mf-blocks/ ya existe (drop-in {snippet}).")
        else:
            log(f"Escribiendo location /mf-blocks/ en drop-in {snippet}...")
            tmpf = tmp / "mf-blocks.conf"
            tmpf.write_text(location_block(mf_dir))
            _copiar_con_sudo(tmpf, snippet)
    elif TIENE_LOCATION.search(nginx_conf.read_text(errors="ignore")):
        log("location /mf-blocks/ ya existe en Nginx.")
    else:
        log(f"Agregando location /mf-blocks/ a {nginx_conf} (inline)...")
        nuevo = insert_location_inline(nginx_conf.read_text(), mf_dir)
        if nuevo is None:
            fail(f"Error al generar la nueva config para {nginx_conf}: no hay un `location / {{` donde insertar")
        tmpf = tmp / "nginx-mfblocks.conf"
        tmpf.write_text(nuevo)
        _copiar_con_sudo(tmpf, nginx_conf)

    # nginx necesita x (traversal) en cada componente de la ruta y r en los bundles: ACLs POSIX (requiere root).
    user = nginx_user()
    setfacl = shutil.which("setfacl") or "setfacl"
    ya = False
    if shutil.which("getfacl"):
        g = subprocess.run(["getfacl", str(mf_dir)], text=True, capture_output=True)
        ya = bool(re.search(rf"^user:{re.escape(user)}:..x", g.stdout or "", re.M))
    if ya:
        log(f"Permisos de traversal (ACL) ya presentes para el usuario '{user}'.")
    else:
        log(f"Otorgando a Nginx ('{user}') acceso a los bundles (ACLs, con sudo).")
        log("Sin esto, Nginx daria 403/404 al servir /mf-blocks/. Te pedira tu password.")
        pasos = [["sudo", setfacl, "-m", f"u:{user}:x", str(Path.home()), str(project), str(project / "var")],
                 ["sudo", setfacl, "-R", "-m", f"u:{user}:rX", str(mf_dir)],
                 ["sudo", setfacl, "-d", "-m", f"u:{user}:rX", str(mf_dir)]]
        if all(subprocess.run(p).returncode == 0 for p in pasos):
            log(f"ACLs aplicadas para '{user}'.")
        else:
            warn("No se pudieron aplicar las ACLs (¿falta el paquete 'acl' o el FS no las soporta?). Hazlo a mano:")
            for p in pasos:
                print("  " + " ".join(p))
            ok = False

    binario, unidad = nginx_runtime()
    t = subprocess.run(["sudo", binario, "-t"], text=True, capture_output=True)
    if t.returncode == 0:
        rl = subprocess.run(["sudo", "systemctl", "reload", unidad], text=True, capture_output=True)
        if rl.returncode == 0:
            log("Nginx configurado y recargado.")
        else:
            warn(f"Nginx validado pero no se pudo recargar: {(rl.stderr or rl.stdout).strip()}")
            warn(f"Ejecuta manualmente: sudo systemctl reload {unidad}")
            ok = False
    else:
        warn(f"Error en la validacion de Nginx: {(t.stderr or t.stdout).strip()}")
        warn(f"Ejecuta manualmente: sudo {binario} -t && sudo systemctl reload {unidad}")
        ok = False
    return ok


# ── 11. activar el add-on ──────────────────────────────────────────────────────────────────────────────────

ZCONSOLE_SCRIPT = '''"""Install collective.mfblocks add-on and create registry folder."""
import transaction
from Testing.makerequest import makerequest
from AccessControl.SecurityManagement import newSecurityManager
from AccessControl.users import SimpleUser
from zope.site.hooks import setSite

app = makerequest(app)

SITE_ID = None
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
setSite(portal)

admin_user = SimpleUser("admin", "", ["Manager"], [])
newSecurityManager(None, admin_user.__of__(app.acl_users))

print(f"[MF] Plone site: {SITE_ID}")

from Products.CMFPlone.utils import get_installer
installer = get_installer(portal)
if not installer.is_product_installed("collective.mfblocks"):
    installer.install_product("collective.mfblocks")
    print("[MF] Add-on collective.mfblocks installed.")
else:
    print("[MF] Add-on collective.mfblocks already installed.")

from zope.component import queryUtility
from plone.dexterity.interfaces import IDexterityFTI
fti = queryUtility(IDexterityFTI, name="MFBlock")
print(f"[MF] MFBlock FTI registered: {fti is not None}")

CONTAINER_ID = "mf-blocks-registry"
if CONTAINER_ID not in portal:
    from OFS.Folder import Folder
    folder = Folder(CONTAINER_ID)
    folder.title = "MF Blocks Registry"
    portal._setObject(CONTAINER_ID, folder)
    print(f"[MF] Created {CONTAINER_ID} folder.")
else:
    print(f"[MF] {CONTAINER_ID} folder already exists.")

transaction.commit()
print("[MF] Done.")
'''


def activate_addon(project, tmp):
    log("=== Activando add-on en Plone ===")
    zconsole = project / "backend/.venv/bin/zconsole"
    zope_conf = next((c for c in (project / "backend/instance/etc/zope.conf", project / "backend/etc/zope.conf",
                                  project / "backend/parts/instance/etc/zope.conf") if c.is_file()), None)
    if zconsole.is_file():
        cmd = [str(zconsole)]
    elif shutil.which("uv"):
        warn("zconsole no encontrado en venv, usando: uv run zconsole")
        cmd = ["uv", "run", "zconsole"]
    else:
        warn(f"zconsole no encontrado en {zconsole}")
        warn("Activa el add-on manualmente: Site Setup → Add-ons → Install")
        return
    if zope_conf is None:
        warn("zope.conf no encontrado.")
        warn("Activa el add-on manualmente: Site Setup → Add-ons → Install")
        return
    log(f"zconsole: {' '.join(cmd)}")
    log(f"zope.conf: {zope_conf}")

    # Detener TODAS las instancias de backend para acceso exclusivo a la ZODB (--all incluye las detenidas).
    units = unidades_user("plone-*-backend*")
    if units:
        log(f"Deteniendo {len(units)} instancia(s) backend...")
        for svc in units:
            systemd_user("stop", svc)
            log(f"  Detenido: {svc}")
        subprocess.run(["sleep", "2"])

    script = tmp / "mf_install.py"
    script.write_text(ZCONSOLE_SCRIPT)
    log("Ejecutando instalacion via zconsole...")
    try:
        r = run([*cmd, "run", zope_conf, script], check=False, cwd=project / "backend")
        for ln in ((r.stdout or "") + (r.stderr or "")).splitlines():
            if re.search(r"^\[MF\]|Error|Traceback", ln):
                print(ln, flush=True)
        if r.returncode != 0:
            warn("La activación con zconsole terminó con error: activa el add-on desde Site Setup → Add-ons.")
    finally:
        if units:
            log(f"Arrancando {len(units)} instancia(s) backend...")
            for svc in units:
                systemd_user("start", svc)
                log(f"  Arrancado: {svc}")
            subprocess.run(["sleep", "3"])
            log(f"Backend reiniciado ({len(units)} instancia(s)).")


# ── main ───────────────────────────────────────────────────────────────────────────────────────────────────

def banner():
    print(f"\n{BLUE}╔══════════════════════════════════════════════════════╗{NC}")
    print(f"{BLUE}║   Module Federation Blocks - Instalador v1.1.0      ║{NC}")
    print(f"{BLUE}║   github.com/RenteriaMX/MF-Blocks-Manager           ║{NC}")
    print(f"{BLUE}╚══════════════════════════════════════════════════════╝{NC}\n")


def main(argv=None):
    global ARGS
    ap = argparse.ArgumentParser(description="Instalador de MF-Blocks-Manager para Plone 6")
    ap.add_argument("project", nargs="?", help="ruta del proyecto Plone (por defecto se busca en /opt/plone/)")
    ap.add_argument("--yes", "-y", action="store_true", help="no preguntar nada")
    ap.add_argument("--dry-run", action="store_true", help="solo detectar y mostrar el resumen")
    ap.add_argument("--source", help="carpeta con una copia local del repo")
    ARGS = ap.parse_args(argv)

    banner()
    os.environ["PATH"] = f"{Path.home() / '.local/bin'}{os.pathsep}{os.environ.get('PATH', '')}"     # uv y otros binarios del usuario
    if not ARGS.dry_run:
        for cmd in ("git", "pnpm"):
            if not shutil.which(cmd):
                fail(f"Se requiere '{cmd}' pero no esta instalado.")

    project = detect_plone_project(ARGS.project)
    if not os.access(project, os.W_OK):
        fail(f"No tienes acceso de escritura al directorio del proyecto: {project}")
    mf_dir = project / "var/mf-blocks"
    import getpass
    user = getpass.getuser()
    log(f"Usuario Plone: {user}")
    be_svc, fe_svc = detect_services()
    pip = detect_pip(project)
    nginx_conf = detect_nginx_config(project)

    print()
    info("Resumen de la instalacion:")
    for k, v in (("Proyecto", project), ("Usuario", user), ("Backend", be_svc), ("Frontend", fe_svc),
                 ("Nginx", nginx_conf), ("Bundles", mf_dir)):
        info(f"  {k + ':':10} {v or ''}")
    print()
    if ARGS.dry_run:
        log("--dry-run: no se modifica nada.")
        return 0
    if not re.match(r"^[Yy]", ask("¿Continuar con la instalacion? [Y/n] ", "Y")):
        log("Instalacion cancelada.")
        return 0

    print()
    with tempfile.TemporaryDirectory(prefix="mf-blocks-") as t:
        tmp = Path(t)
        src = get_source(tmp)
        install_backend(project, src, pip)
        install_frontend(project, src, fe_svc)
        setup_bundles_dir(mf_dir)
        nginx_ok = setup_nginx(project, nginx_conf, mf_dir, tmp)
        activate_addon(project, tmp)

    print()
    if not nginx_ok:
        print(f"{YELLOW}╔══════════════════════════════════════════════════════╗{NC}")
        print(f"{YELLOW}║   Instalacion completada con advertencias            ║{NC}")
        print(f"{YELLOW}╚══════════════════════════════════════════════════════╝{NC}\n")
        warn("La configuracion de Nginx requiere pasos manuales: revisa los mensajes anteriores.")
    else:
        print(f"{GREEN}╔══════════════════════════════════════════════════════╗{NC}")
        print(f"{GREEN}║   Instalacion completada exitosamente!               ║{NC}")
        print(f"{GREEN}╚══════════════════════════════════════════════════════╝{NC}")
    print()
    log("MF Blocks Manager esta listo.")
    log("Ve a Site Setup → Module Federation Blocks para subir bloques.\n")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except InstallError as e:
        print(f"{RED}[MF-Blocks]{NC} {e}", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        print("\nCancelado.", file=sys.stderr)
        sys.exit(130)
