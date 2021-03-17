FROM node:14.16.0
 
WORKDIR /app
 
COPY package.json package.json
COPY package-lock.json package-lock.json
 
RUN npm config set strict-ssl false
RUN npm install
 
COPY . .

ENV MAP_SIZE=3500
ENV MULTICORE=1
ENV CORE_COUNT=10
ENV USE_PAID_LICENSES=1
ENV COINS_PERCENTAGE_FOR_PAID_LICENSE=0.1
ENV WORKER_DIGGER_FREE_1=1
ENV WORKER_DIGGER_FREE_2=1
ENV WORKER_DIGGER_FREE_3=1
ENV WORKER_DIGGER_PAID_1=1
ENV WORKER_DIGGER_PAID_2=1
ENV WORKER_DIGGER_PAID_3=1
ENV WORKER_DIGGER_PAID_4=1
ENV WORKER_DIGGER_PAID_5=1
ENV WORKER_DIGGER_PAID_6=1
ENV WORKER_DIGGER_PAID_7=1
CMD [ "node", "index.js" ]