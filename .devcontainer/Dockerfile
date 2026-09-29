# Utilise une image officielle Ubuntu comme base
FROM mcr.microsoft.com/devcontainers/base:0-bullseye

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

# Crée l'utilisateur codespace avec les bons UID/GID (compatible GitHub Codespaces)
ARG USERNAME=codespace
ARG USER_UID=1000
ARG USER_GID=1000

RUN groupadd --gid ${USER_GID} ${USERNAME} && \
    useradd --uid ${USER_UID} --gid ${USER_GID} -m -s /bin/bash ${USERNAME} && \
    echo "${USERNAME} ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

# Configure le workspace
RUN mkdir -p /workspaces/soryos-code && \
    chown ${USERNAME}:${USERNAME} /workspaces/soryos-code

# Installe Node.js 24 (LTS)
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && \
    apt-get install -y nodejs

# Installe pnpm (comme spécifié dans ton package.json)
RUN npm install -g pnpm@11.7.0

# Configure le shell par défaut
SHELL ["/bin/bash", "-c"]

# Utilise l'utilisateur codespace
USER ${USERNAME}

WORKDIR /workspaces/soryos-code
