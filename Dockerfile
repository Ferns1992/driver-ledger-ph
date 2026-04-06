FROM node:18-alpine

WORKDIR /app

COPY package.json ./
RUN npm install

COPY index.html manifest.json server.js ./

RUN mkdir -p /data && chmod 777 /data

ENV DB_PATH=/data/driverledger.db

EXPOSE 4090

CMD ["node", "server.js"]
