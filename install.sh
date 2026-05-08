#!/bin/bash
###############################################################################
# Module Federation Blocks - Instalador automatico para Plone 6
#
# Uso:
#   curl -sL https://raw.githubusercontent.com/RenteriaMX/MF-Blocks-Manager/main/install.sh | bash
#
# O con ruta especifica:
#   curl -sL https://raw.githubusercontent.com/RenteriaMX/MF-Blocks-Manager/main/install.sh | bash -s /opt/plone/mi-proyecto
#
###############################################################################
set -e

# Colores
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()   { echo -e "${GREEN}[MF-Blocks]${NC} $1"; }
warn()  { echo -e "${YELLOW}[MF-Blocks]${NC} $1"; }
error() { echo -e "${RED}[MF-Blocks]${NC} $1"; exit 1; }
info()  { echo -e "${BLUE}[MF-Blocks]${NC} $1"; }

# Wrapper para servicios systemd del usuario actual
systemd_user() {
    XDG_RUNTIME_DIR=/run/user/$(id -u) \
    DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u)/bus \
    systemctl --user "$@"
}

REPO_URL="https://github.com/RenteriaMX/MF-Blocks-Manager.git"
TEMP_DIR=$(mktemp -d)
MF_BLOCKS_DIR=""  # Se asigna en main despues de detectar PROJECT_DIR

###############################################################################
# 1. Detectar directorio del proyecto Plone
###############################################################################
detect_plone_project() {
    # Si se paso como argumento
    if [ -n "$1" ]; then
        PROJECT_DIR="$1"
        if [ ! -d "$PROJECT_DIR" ]; then
            error "El directorio $PROJECT_DIR no existe"
        fi
        return
    fi

    log "Buscando proyectos Plone en /opt/plone/..."

    # Buscar directorios con estructura backend/frontend
    CANDIDATES=()
    for dir in /opt/plone/*/; do
        if [ -d "${dir}backend" ] && [ -d "${dir}frontend" ]; then
            CANDIDATES+=("$dir")
        fi
    done

    if [ ${#CANDIDATES[@]} -eq 0 ]; then
        error "No se encontro ningun proyecto Plone en /opt/plone/. Usa: install.sh /ruta/al/proyecto"
    elif [ ${#CANDIDATES[@]} -eq 1 ]; then
        PROJECT_DIR="${CANDIDATES[0]}"
        log "Proyecto detectado: $PROJECT_DIR"
    else
        echo ""
        info "Se encontraron multiples proyectos Plone:"
        for i in "${!CANDIDATES[@]}"; do
            echo "  [$i] ${CANDIDATES[$i]}"
        done
        echo ""
        read -p "Selecciona el numero del proyecto: " selection </dev/tty
        PROJECT_DIR="${CANDIDATES[$selection]}"
    fi
}

###############################################################################
# 2. Detectar usuario de Plone
###############################################################################
detect_plone_user() {
    PLONE_USER=$(whoami)
    log "Usuario Plone: $PLONE_USER"
}

###############################################################################
# 3. Detectar servicios systemd (del usuario, sin root)
###############################################################################
detect_services() {
    BACKEND_SERVICE=""
    FRONTEND_SERVICE=""

    # Buscar servicios de backend en el scope del usuario (patron plone-*-backend o plone-backend*)
    BACKEND_SERVICE=$(systemd_user list-units --type=service --all --no-legend 2>/dev/null \
        | awk '{print $1}' | grep -E 'plone-.*backend|plone-backend|plone-zeo' | head -1)

    # Buscar servicios de frontend en el scope del usuario (patron plone-*-frontend o plone-volto*)
    FRONTEND_SERVICE=$(systemd_user list-units --type=service --all --no-legend 2>/dev/null \
        | awk '{print $1}' | grep -E 'plone-.*frontend|plone-volto|^volto' | head -1)

    if [ -z "$BACKEND_SERVICE" ]; then
        warn "No se detecto servicio de backend. Tendras que reiniciar manualmente."
    else
        log "Servicio backend: $BACKEND_SERVICE"
    fi

    if [ -z "$FRONTEND_SERVICE" ]; then
        warn "No se detecto servicio de frontend. Tendras que reiniciar manualmente."
    else
        log "Servicio frontend: $FRONTEND_SERVICE"
    fi
}

###############################################################################
# 4. Detectar herramienta de pip
###############################################################################
detect_pip() {
    # Buscar el virtualenv de Plone
    if [ -f "$PROJECT_DIR/backend/bin/pip" ]; then
        PIP_CMD="$PROJECT_DIR/backend/bin/pip"
    elif command -v uv &>/dev/null; then
        PIP_CMD="uv pip"
    elif [ -f "$PROJECT_DIR/backend/.venv/bin/pip" ]; then
        PIP_CMD="$PROJECT_DIR/backend/.venv/bin/pip"
    else
        PIP_CMD="pip"
    fi
    log "Pip detectado: $PIP_CMD"
}

###############################################################################
# 5. Detectar config de Nginx
###############################################################################
detect_nginx_config() {
    NGINX_CONF=""

    # Primero buscar en el proyecto (arquitectura Plone AMA)
    for conf in "$PROJECT_DIR/etc/nginx.conf" \
                "$PROJECT_DIR/etc/nginx/nginx.conf"; do
        if [ -f "$conf" ]; then
            NGINX_CONF="$conf"
            break
        fi
    done

    # Fallback: ubicaciones del sistema
    if [ -z "$NGINX_CONF" ]; then
        for conf in /etc/nginx/sites-enabled/plone.conf \
                    /etc/nginx/sites-enabled/default \
                    /etc/nginx/conf.d/plone.conf \
                    /etc/nginx/conf.d/default.conf; do
            if [ -f "$conf" ]; then
                NGINX_CONF="$conf"
                break
            fi
        done
    fi

    if [ -z "$NGINX_CONF" ]; then
        NGINX_CONF=$(grep -rl "proxy_pass.*volto\|proxy_pass.*plone" /etc/nginx/ 2>/dev/null | head -1)
    fi

    if [ -n "$NGINX_CONF" ]; then
        log "Nginx config: $NGINX_CONF"
    else
        warn "No se detecto config de Nginx."
    fi
}

###############################################################################
# 6. Clonar repo
###############################################################################
clone_repo() {
    log "Descargando MF-Blocks-Manager..."
    git clone --depth 1 "$REPO_URL" "$TEMP_DIR/mf-blocks" 2>/dev/null
    log "Descarga completa."
}

###############################################################################
# 7. Instalar Backend
###############################################################################
install_backend() {
    log "=== Instalando Backend ==="

    # Crear directorio de packages si no existe
    mkdir -p "$PROJECT_DIR/backend/packages"

    # Copiar paquete
    if [ -d "$PROJECT_DIR/backend/packages/collective.mfblocks" ]; then
        warn "collective.mfblocks ya existe. Actualizando..."
        rm -rf "$PROJECT_DIR/backend/packages/collective.mfblocks"
    fi
    cp -r "$TEMP_DIR/mf-blocks/backend/collective.mfblocks" "$PROJECT_DIR/backend/packages/"

    # Instalar con pip
    log "Instalando paquete Python..."
    cd "$PROJECT_DIR/backend"
    $PIP_CMD install --no-config -e packages/collective.mfblocks 2>&1 | tail -3
    cd - > /dev/null

    log "Backend instalado correctamente."
}

###############################################################################
# 8. Instalar Frontend
###############################################################################
install_frontend() {
    log "=== Instalando Frontend ==="

    FRONTEND_DIR="$PROJECT_DIR/frontend"

    # Crear directorio de packages si no existe
    mkdir -p "$FRONTEND_DIR/packages"

    # Copiar paquete
    if [ -d "$FRONTEND_DIR/packages/volto-mfblocks" ]; then
        warn "volto-mfblocks ya existe. Actualizando..."
        rm -rf "$FRONTEND_DIR/packages/volto-mfblocks"
    fi
    cp -r "$TEMP_DIR/mf-blocks/frontend/volto-mfblocks" "$FRONTEND_DIR/packages/"

    # --- Modificar volto.config.js ---
    VOLTO_CONFIG="$FRONTEND_DIR/volto.config.js"
    if [ -f "$VOLTO_CONFIG" ]; then
        if grep -q "volto-mfblocks" "$VOLTO_CONFIG"; then
            log "volto-mfblocks ya esta en volto.config.js"
        else
            log "Agregando volto-mfblocks a volto.config.js..."
            if grep -q "addons:" "$VOLTO_CONFIG"; then
                sed -i.bak "s/addons:\s*\[/addons: ['volto-mfblocks', /" "$VOLTO_CONFIG"
            elif grep -q "const addons" "$VOLTO_CONFIG"; then
                sed -i.bak "s/const addons = \[/const addons = ['volto-mfblocks', /" "$VOLTO_CONFIG"
            else
                warn "No se pudo detectar el formato de volto.config.js. Agregalo manualmente:"
                warn "  addons: ['volto-mfblocks']"
            fi
            rm -f "${VOLTO_CONFIG}.bak"
        fi
    else
        error "No se encontro volto.config.js en $FRONTEND_DIR"
    fi

    # --- Modificar package.json ---
    PACKAGE_JSON="$FRONTEND_DIR/package.json"
    if [ -f "$PACKAGE_JSON" ]; then
        if grep -q "volto-mfblocks" "$PACKAGE_JSON"; then
            log "volto-mfblocks ya esta en package.json"
        else
            log "Agregando volto-mfblocks a package.json..."
            python3 -c "
import json
with open('$PACKAGE_JSON', 'r') as f:
    data = json.load(f)
if 'dependencies' not in data:
    data['dependencies'] = {}
data['dependencies']['volto-mfblocks'] = 'workspace:*'
with open('$PACKAGE_JSON', 'w') as f:
    json.dump(data, f, indent=2)
    f.write('\n')
"
            log "package.json actualizado."
        fi
    fi

    # --- pnpm install ---
    log "Instalando dependencias npm..."
    cd "$FRONTEND_DIR"
    pnpm install 2>&1 | tail -5

    # --- Build ---
    log "Compilando frontend (esto puede tardar varios minutos)..."
    VOLTOCONFIG="$FRONTEND_DIR/volto.config.js" pnpm --filter @plone/volto build 2>&1 | tail -5

    # Reiniciar frontend
    if [ -n "$FRONTEND_SERVICE" ]; then
        log "Reiniciando $FRONTEND_SERVICE..."
        systemd_user restart "$FRONTEND_SERVICE"
        sleep 3
        log "Frontend reiniciado."
    fi

    log "Frontend instalado correctamente."
}

###############################################################################
# 9. Configurar directorio de bundles y variable de entorno MF_BLOCKS_DIR
###############################################################################
setup_bundles_dir() {
    log "=== Configurando directorio de bundles ==="

    if [ -d "$MF_BLOCKS_DIR" ]; then
        log "$MF_BLOCKS_DIR ya existe."
    else
        mkdir -p "$MF_BLOCKS_DIR"
        log "Directorio creado: $MF_BLOCKS_DIR"
    fi

    # Crear drop-in de systemd para CADA instancia backend con MF_BLOCKS_DIR
    # --all incluye instancias detenidas, no solo las activas
    BACKEND_UNITS=$(systemd_user list-units --all --no-legend "plone-*-backend*" 2>/dev/null | awk '{print $1}')
    UNIT_COUNT=$(echo "$BACKEND_UNITS" | grep -c '\.' 2>/dev/null || echo 0)
    log "Instancias backend detectadas: $UNIT_COUNT"

    for svc in $BACKEND_UNITS; do
        SVC_NAME="${svc%.service}"
        DROPIN_DIR="$HOME/.config/systemd/user/${SVC_NAME}.d"
        mkdir -p "$DROPIN_DIR"
        cat > "$DROPIN_DIR/mf-blocks-env.conf" << EOF
[Service]
Environment=MF_BLOCKS_DIR=${MF_BLOCKS_DIR}
EOF
        log "  [$SVC_NAME] MF_BLOCKS_DIR=$MF_BLOCKS_DIR"
    done

    if [ -n "$BACKEND_UNITS" ]; then
        systemd_user daemon-reload
        log "Systemd recargado."
    else
        warn "No se encontraron instancias backend para configurar MF_BLOCKS_DIR."
        warn "Configura manualmente: Environment=MF_BLOCKS_DIR=${MF_BLOCKS_DIR}"
    fi
}

###############################################################################
# 10. Configurar Nginx
###############################################################################
setup_nginx() {
    log "=== Configurando Nginx ==="

    if [ -z "$NGINX_CONF" ]; then
        warn "No se detecto config de Nginx. Agrega manualmente:"
        echo ""
        echo "    location /mf-blocks/ {"
        echo "        alias ${MF_BLOCKS_DIR}/;"
        echo "        expires 1h;"
        echo "        add_header Access-Control-Allow-Origin *;"
        echo "    }"
        echo ""
        return
    fi

    if grep -q "mf-blocks" "$NGINX_CONF"; then
        log "location /mf-blocks/ ya existe en Nginx."
        return
    fi

    log "Agregando location /mf-blocks/ a $NGINX_CONF..."

    # Detectar SITE_ID desde el nombre del directorio del proyecto
    SITE_ID=$(basename "$PROJECT_DIR")

    # Insertar antes de "location /" usando python3 para manejar variables
    python3 -c "
import re

with open('$NGINX_CONF', 'r') as f:
    content = f.read()

block = (
    '    # Module Federation Blocks (bundles estaticos)\n'
    '    location /mf-blocks/ {\n'
    '        alias $MF_BLOCKS_DIR/;\n'
    '        expires 1h;\n'
    '        add_header Access-Control-Allow-Origin *;\n'
    '    }\n\n'
)

content = re.sub(r'(\s*location\s+/\s*\{)', block + r'\1', content, count=1)
with open('$NGINX_CONF', 'w') as f:
    f.write(content)
print('OK')
" || { error "Error al modificar $NGINX_CONF"; }

    # Crear zona de rate limiting para el admin endpoint
    RATELIMIT_FILE="/etc/nginx/conf.d/mfblocks-ratelimit.conf"
    if [ ! -f "$RATELIMIT_FILE" ]; then
        echo 'limit_req_zone $binary_remote_addr zone=mfblocks_admin:10m rate=5r/s;' \
            | sudo tee "$RATELIMIT_FILE" > /dev/null && \
            log "Rate limiting configurado en $RATELIMIT_FILE"
    fi

    # Permitir a nginx (www-data) atravesar los directorios del usuario
    sudo chmod o+x "$HOME"
    sudo chmod o+x "$PROJECT_DIR"
    sudo chmod o+x "$PROJECT_DIR/var"
    sudo chmod o+x "$MF_BLOCKS_DIR"
    log "Permisos de traversal configurados para nginx."

    # Recargar nginx con rutas absolutas (requiere NOPASSWD en sudoers para estos dos comandos)
    if sudo /usr/sbin/nginx -t 2>/dev/null; then
        if sudo /usr/bin/systemctl reload nginx 2>/dev/null; then
            log "Nginx configurado y recargado."
        else
            warn "Nginx validado pero no se pudo recargar automaticamente."
            warn "Ejecuta manualmente: sudo /usr/bin/systemctl reload nginx"
        fi
    else
        warn "Error en la validacion de Nginx. Revisa $NGINX_CONF"
        warn "Ejecuta manualmente: sudo /usr/sbin/nginx -t && sudo /usr/bin/systemctl reload nginx"
    fi
}

###############################################################################
# 11. Activar add-on via zconsole
###############################################################################
activate_addon() {
    log "=== Activando add-on en Plone ==="

    VENV_DIR="$PROJECT_DIR/backend/.venv"
    ZCONSOLE="$VENV_DIR/bin/zconsole"
    ZOPE_CONF=""

    for conf in "$PROJECT_DIR/backend/instance/etc/zope.conf" \
                "$PROJECT_DIR/backend/etc/zope.conf" \
                "$PROJECT_DIR/backend/parts/instance/etc/zope.conf"; do
        if [ -f "$conf" ]; then
            ZOPE_CONF="$conf"
            break
        fi
    done

    if [ ! -f "$ZCONSOLE" ]; then
        if command -v uv &>/dev/null; then
            warn "zconsole no encontrado en venv, usando: uv run zconsole"
            ZCONSOLE="uv run zconsole"
        else
            warn "zconsole no encontrado en $ZCONSOLE"
            warn "Activa el add-on manualmente: Site Setup → Add-ons → Install"
            return
        fi
    fi

    if [ -z "$ZOPE_CONF" ]; then
        warn "zope.conf no encontrado."
        warn "Activa el add-on manualmente: Site Setup → Add-ons → Install"
        return
    fi

    log "zconsole: $ZCONSOLE"
    log "zope.conf: $ZOPE_CONF"

    # Detener TODAS las instancias de backend para acceso exclusivo a ZODB
    # --all incluye instancias detenidas (por si alguna quedó en estado failed)
    BACKEND_SERVICES=$(systemd_user list-units --all --no-legend "plone-*-backend*" 2>/dev/null | awk '{print $1}')
    SVC_COUNT=$(echo "$BACKEND_SERVICES" | grep -c '\.' 2>/dev/null || echo 0)
    if [ -n "$BACKEND_SERVICES" ]; then
        log "Deteniendo $SVC_COUNT instancia(s) backend..."
        for svc in $BACKEND_SERVICES; do
            systemd_user stop "$svc" 2>/dev/null || true
            log "  Detenido: $svc"
        done
        sleep 2
    fi

    INSTALL_SCRIPT=$(mktemp /tmp/mf_install_XXXXXX.py)
    cat > "$INSTALL_SCRIPT" << 'PYEOF'
"""Install collective.mfblocks add-on and create registry folder."""
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
PYEOF

    log "Ejecutando instalacion via zconsole..."
    "$ZCONSOLE" run "$ZOPE_CONF" "$INSTALL_SCRIPT" 2>&1 | grep -E "^\[MF\]|Error|Traceback"

    rm -f "$INSTALL_SCRIPT"

    # Arrancar TODAS las instancias de backend
    if [ -n "$BACKEND_SERVICES" ]; then
        log "Arrancando $SVC_COUNT instancia(s) backend..."
        for svc in $BACKEND_SERVICES; do
            systemd_user start "$svc" 2>/dev/null || true
            log "  Arrancado: $svc"
        done
        sleep 3
        log "Backend reiniciado ($SVC_COUNT instancia(s))."
    fi
}

###############################################################################
# 12. Limpieza
###############################################################################
cleanup() {
    if [ -n "$TEMP_DIR" ] && [ -d "$TEMP_DIR" ]; then
        rm -rf "$TEMP_DIR"
    fi
}

###############################################################################
# MAIN
###############################################################################
main() {
    echo ""
    echo -e "${BLUE}╔══════════════════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║   Module Federation Blocks - Instalador v1.0.0      ║${NC}"
    echo -e "${BLUE}║   github.com/RenteriaMX/MF-Blocks-Manager           ║${NC}"
    echo -e "${BLUE}╚══════════════════════════════════════════════════════╝${NC}"
    echo ""

    # Asegurar que uv (y otros binarios del usuario) sean encontrados
    export PATH="$HOME/.local/bin:$PATH"

    # Verificar dependencias (nginx no es requerido — se maneja con sudo NOPASSWD)
    for cmd in git python3 pnpm; do
        if ! command -v "$cmd" &>/dev/null; then
            error "Se requiere '$cmd' pero no esta instalado."
        fi
    done

    detect_plone_project "$1"

    # Verificar acceso de escritura al proyecto
    if [ ! -w "${PROJECT_DIR:-$HOME}" ]; then
        error "No tienes acceso de escritura al directorio del proyecto: ${PROJECT_DIR:-$HOME}"
    fi

    # Directorio de bundles dentro del proyecto
    MF_BLOCKS_DIR="$PROJECT_DIR/var/mf-blocks"

    detect_plone_user
    detect_services
    detect_pip
    detect_nginx_config

    echo ""
    info "Resumen de la instalacion:"
    info "  Proyecto:  $PROJECT_DIR"
    info "  Usuario:   $PLONE_USER"
    info "  Backend:   $BACKEND_SERVICE"
    info "  Frontend:  $FRONTEND_SERVICE"
    info "  Nginx:     $NGINX_CONF"
    info "  Bundles:   $MF_BLOCKS_DIR"
    echo ""
    read -p "¿Continuar con la instalacion? [Y/n] " confirm </dev/tty || true
    confirm=${confirm:-Y}
    if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
        log "Instalacion cancelada."
        exit 0
    fi

    echo ""
    clone_repo
    install_backend
    install_frontend
    setup_bundles_dir
    setup_nginx
    activate_addon
    cleanup

    echo ""
    echo -e "${GREEN}╔══════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║   Instalacion completada exitosamente!               ║${NC}"
    echo -e "${GREEN}╚══════════════════════════════════════════════════════╝${NC}"
    echo ""
    log "MF Blocks Manager esta listo."
    log "Ve a Site Setup → Module Federation Blocks para subir bloques."
    echo ""
}

trap cleanup EXIT
main "$@"
