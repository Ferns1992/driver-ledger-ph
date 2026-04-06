FROM node:18-alpine

WORKDIR /app

COPY package.json ./
RUN npm install

COPY index.html manifest.json server.js ./

RUN mkdir -p /data

EXPOSE 4090

CMD ["node", "server.js"]
