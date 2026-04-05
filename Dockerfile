FROM node:22-slim

RUN apt-get update && \
    apt-get install -y ffmpeg python3 python3-pip fonts-dejavu-core && \
    ln -sf /usr/local/bin/node /usr/local/bin/nodejs && \
    pip3 install -U yt-dlp --break-system-packages && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

EXPOSE 3333
CMD ["node", "server.js"]
