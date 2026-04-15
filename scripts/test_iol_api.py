"""
Test de conexión a la API de IOL (InvertirOnLine).
Lee las credenciales del archivo `secrets` en la raíz del proyecto.

Ejecutar desde la raíz del proyecto:
    python scripts/test_iol_api.py
"""

import requests
import json
import os
import sys

# Forzar UTF-8 en la salida (necesario en terminales Windows)
sys.stdout.reconfigure(encoding="utf-8")

# -- Credenciales --------------------------------------------------------------

def load_secrets(path="secrets.env"):
    """Lee el archivo de credenciales (formato KEY="valor")."""
    # Busca el archivo relativo a la raíz del proyecto (un nivel arriba de /scripts)
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    full_path = os.path.join(root, path)
    secrets = {}
    with open(full_path) as f:
        for line in f:
            line = line.strip()
            if "=" in line and not line.startswith("#"):
                key, _, value = line.partition("=")
                secrets[key.strip()] = value.strip().strip('"')
    return secrets

# -- Autenticación ------------------------------------------------------------─

def get_token(username, password):
    """Obtiene el bearer token y el refresh token de IOL."""
    response = requests.post(
        "https://api.invertironline.com/token",
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        data={
            "username": username,
            "password": password,
            "grant_type": "password",
        },
    )
    response.raise_for_status()
    return response.json()

# -- Llamadas a la API --------------------------------------------------------─

def get(endpoint, token):
    """GET autenticado a la API de IOL."""
    response = requests.get(
        f"https://api.invertironline.com{endpoint}",
        headers={"Authorization": f"Bearer {token}"},
    )
    response.raise_for_status()
    return response.json()

# -- Main ----------------------------------------------------------------------

def main():
    # 1. Cargar credenciales
    secrets = load_secrets()
    username = secrets["User_IOL"]
    password = secrets["Pass_IOL"]
    print(f"Usuario: {username}")

    # 2. Autenticar
    print("\n-- Autenticando... ------------------------------")
    tokens = get_token(username, password)
    access_token = tokens["access_token"]
    print("OK Token obtenido.")
    print(f"  Expira en: {tokens.get('expires_in')} segundos")

    # 3. Portafolio Argentina
    print("\n-- Portafolio (Argentina) ----------------------─")
    portfolio = get("/api/v2/portafolio/argentina", access_token)
    print(json.dumps(portfolio, indent=2, ensure_ascii=False))

if __name__ == "__main__":
    main()
