FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
ENV HOST=0.0.0.0 PORT=3100 KEEPCRAWL_DATA_DIR=/data NODE_ENV=production
VOLUME /data
EXPOSE 3100
USER node
CMD ["node", "--no-warnings=ExperimentalWarning", "src/index.js"]
