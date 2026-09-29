# Utilise l'image officielle Node.js 24 pour éviter les problèmes de compatibilité
FROM mcr.microsoft.com/devcontainers/javascript-node:24-bullseye

# Installe les dépendances système nécessaires
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    git \
    curl \
    sudo \
    build-essential \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Installe pnpm (comme spécifié dans ton package.json)
RUN npm install -g pnpm@11.7.0

# Configure le workspace pour éviter les problèmes de permissions
RUN mkdir -p /workspaces && \
    chown codespace:codespace /workspaces

# Configure le shell par défaut
SHELL ["/bin/bash", "-c"]

# Utilise l'utilisateur codespace (déjà créé dans l'image de base)
USER codespace

WORKDIR /workspaces/soryos-code
