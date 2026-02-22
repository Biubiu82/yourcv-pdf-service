FROM node:20-bullseye-slim

# Install Chromium, required fonts, and utilities
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    fonts-liberation \
    fonts-dejavu-core \
    curl unzip fontconfig \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

# Install Inter font (primary CV font with excellent Vietnamese support)
RUN mkdir -p /usr/share/fonts/inter && \
    curl -sL "https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip" -o /tmp/inter.zip && \
    unzip -j /tmp/inter.zip "Inter-4.1/InterVariable.ttf" "Inter-4.1/InterVariable-Italic.ttf" -d /usr/share/fonts/inter/ && \
    rm /tmp/inter.zip && \
    fc-cache -f

# Set Puppeteer to use system Chromium
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3001

CMD ["node", "server.js"]
