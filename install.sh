#!/bin/bash
# OBSOLETO: el instalador ahora es install.py (Python). Este archivo solo conserva la compatibilidad con instrucciones y versiones
# anteriores de HEOC que descargan install.sh. Acepta los mismos argumentos que install.py (ruta del proyecto, --yes, --dry-run).
D="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"
if [ -f "$D/install.py" ]; then exec python3 "$D/install.py" "$@"; fi
exec python3 -c "$(curl -fsSL https://raw.githubusercontent.com/RenteriaMX/MF-Blocks-Manager/main/install.py)" "$@"
