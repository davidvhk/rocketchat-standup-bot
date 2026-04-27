FROM node:20-alpine AS builder

WORKDIR /usr/src/app

RUN apk add --no-cache git

COPY package*.json ./

RUN npm install

COPY . .

FROM node:20-alpine

WORKDIR /usr/src/app

COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY --from=builder /usr/src/app/package.json ./
COPY --from=builder /usr/src/app/src/index.js ./src/

# The .env file should be mounted as a volume at runtime.

CMD [ "node", "src/index.js" ]
