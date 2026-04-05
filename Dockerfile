FROM node:20-bookworm

WORKDIR /app

# Install Google Chrome for Playwright-core executable path.
RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates \
  wget \
  gnupg \
  fontconfig \
  fonts-noto-cjk \
  && wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-linux.gpg \
  && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-linux.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends google-chrome-stable \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV PORT=3000
ENV ENABLE_LOCALTUNNEL=false
ENV BROWSER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

EXPOSE 3000

CMD ["npm", "run", "start"]
