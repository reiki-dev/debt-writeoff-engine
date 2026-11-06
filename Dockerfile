FROM node:20-bookworm-slim

ARG WITH_BROWSER=false

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

RUN if [ "$WITH_BROWSER" = "true" ]; then npx playwright install --with-deps chromium; fi

COPY server.js access.js writeoff-bridge.js ./
COPY mock-crm.js ./mock-crm.js
COPY users.demo.json ./users.demo.json
COPY public ./public
COPY scripts ./scripts
COPY writeoff ./writeoff
COPY pipeline ./pipeline

RUN mkdir -p /app/audit /app/data && chown node:node /app /app/audit /app/data
VOLUME ["/app/audit"]

USER node

EXPOSE 3000

CMD ["node", "server.js"]
