FROM node:14.16.0
 
WORKDIR /app
 
COPY package.json package.json
COPY package-lock.json package-lock.json
 
RUN npm config set strict-ssl false
RUN npm install
 
COPY . .

ENV MAP_SIZE=3500
ENV MULTICORE=1
ENV CORE_COUNT=3
CMD [ "node", "index.js" ]