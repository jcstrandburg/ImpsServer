FROM heroiclabs/nakama-pluginbuilder:3.16.0 AS builder

WORKDIR /backend

# COPY package*.json .
# RUN npm install

# COPY tsconfig.json .
# COPY src/*.ts src/
# RUN npm run build

# FROM heroiclabs/nakama:3.3.0

# COPY --from=node-builder /backend/build/*.js /nakama/data/modules/build/
# COPY local.yml /nakama/data/


WORKDIR /backend
COPY . .

# RUN npm run build

RUN go build --trimpath --mod=vendor --buildmode=plugin -o ./backend.so

FROM heroiclabs/nakama:3.16.0

COPY --from=builder /backend/backend.so /nakama/data/modules

# COPY --from=node-builder /backend/build/*.js /nakama/data/modules/build/
COPY --from=builder /backend/local.yml /nakama/data/
