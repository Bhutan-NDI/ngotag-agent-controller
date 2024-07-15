# FROM ubuntu:20.04

# ENV DEBIAN_FRONTEND noninteractive

# RUN apt-get update -y && apt-get install -y \
#     software-properties-common \
#     apt-transport-https \
#     curl \
#     # Only needed to build indy-sdk
#     build-essential

# RUN curl -fsSL https://deb.nodesource.com/setup_18.x | bash -

# # yarn
# RUN curl -sS https://dl.yarnpkg.com/debian/pubkey.gpg | apt-key add - && \
#     echo "deb https://dl.yarnpkg.com/debian/ stable main" | tee /etc/apt/sources.list.d/yarn.list

# # install depdencies
# RUN apt-get update -y && apt-get install -y --allow-unauthenticated \
#     nodejs

# # install depdencies
# RUN apt-get update -y && apt-get install -y --allow-unauthenticated \
#     nodejs

# # Install yarn seperately due to `no-install-recommends` to skip nodejs install
# RUN apt-get install -y --no-install-recommends yarn

# RUN yarn global add patch-package
# # AFJ specifc setup
# WORKDIR /www

# COPY bin ./bin
# COPY package.json ./package.json
# COPY patches ./patches

# RUN yarn install --production

# COPY build ./build
# # COPY libindy_vdr.so /usr/lib/
# # COPY libindy_vdr.so /usr/local/lib/

# ENTRYPOINT [ "./bin/afj-rest.js", "start" ]


# Stage 1: Builder stage
FROM node:18.19.0 AS builder

WORKDIR /app

# Copy package.json and yarn.lock files
COPY package.json yarn.lock ./
#RUN yarn
# Install dependencies
RUN yarn install --frozen-lockfile

# Copy the rest of the application code
COPY . .

RUN yarn global add patch-package

# Build the application
RUN yarn build

# Stage 2: Production stage
FROM node:18.19.0-slim

WORKDIR /app

# Copy built files and node_modules from the builder stage
COPY --from=builder /app/build ./build
COPY --from=builder /app/bin ./bin
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/patches ./patches

# Set entry point
ENTRYPOINT ["node", "./bin/afj-rest.js", "start"]
