FROM node:20-bullseye-slim

# Install Chromium, required fonts, and utilities
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    fonts-liberation \
    fonts-dejavu-core \
    ca-certificates curl fontconfig \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

# Install Inter variable font (excellent Vietnamese support)
RUN mkdir -p /usr/share/fonts/inter && \
    curl -sLo /usr/share/fonts/inter/Inter.ttf \
      "https://github.com/google/fonts/raw/main/ofl/inter/Inter%5Bopsz%2Cwght%5D.ttf" && \
    curl -sLo /usr/share/fonts/inter/Inter-Italic.ttf \
      "https://github.com/google/fonts/raw/main/ofl/inter/Inter-Italic%5Bopsz%2Cwght%5D.ttf" && \
    fc-cache -fv

# Set Puppeteer to use system Chromium
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3001

CMD ["node", "server.js"]
