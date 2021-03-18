const fetch = require("node-fetch");
const process = require('process');
const cluster = require('cluster');
const numCPUs = require('os').cpus().length;
const util = require('util');
const { truncate } = require("fs");
const sleep = ms => new Promise((resolve, reject) => setTimeout(() => { resolve(); }, ms));

const API_ADDRESS = process.env.ADDRESS || "default";
const API_PORT = process.env.Port || 8000;
const API_SCHEMA = process.env.Schema || "http";

const API_BASE_URL = `${API_SCHEMA}://${API_ADDRESS}${API_PORT === 80 || API_PORT === 443 ? "" : ":".concat(API_PORT)}`;

const MAP_SIZE = Number(process.env.MAP_SIZE || 3500);
const MAP_CELL_COUNT = Number(process.env.MAP_CELL_COUNT || 3500);
const MAP_ROW_COUNT = Number(process.env.MAP_ROW_COUNT || 3500);
const MAP_OFFSET_X = Number(process.env.MAP_OFFSET_X || 0);
const MAP_OFFSET_Y = Number(process.env.MAP_OFFSET_Y || 0);
const MAX_DEPTH = Number(process.env.MAX_DEPTH_LEVEL || 10); //100
const MAX_LICENSES_FREE = 3;
const MAX_LICENSES_PAID = 7; //5
const MAX_LICENSES_ACTIVE = 10;

let _licenses = [];
let _coins = [];

let startTime = new Date();
let requestsCount = 0;

(async () => {
    try {
        //process.env.MULTICORE = 1;
        if (process.env.MULTICORE && cluster.isMaster) {

            let numCPUsForForks = process.env.CORE_COUNT || (numCPUs - 1);
            console.log("master: solution will start as multicore with %s cpus (1 CPU for master)", numCPUsForForks);
            let mapChunkSize = Math.floor(MAP_SIZE / numCPUsForForks);
            
            cluster.setupMaster({
                silent: true
            });

            let digWorkers = [];
            for (let i = 0; i < numCPUsForForks; i++) {
                let offsetX = i * mapChunkSize;
                let offsetY = 0;
                let digWorker = cluster.fork({ 
                    ADDRESS: API_ADDRESS, 
                    Port: API_PORT, 
                    Schema: API_SCHEMA, 
                    MAP_CELL_COUNT: i + 1 === numCPUsForForks ? (mapChunkSize + (MAP_SIZE - mapChunkSize * numCPUsForForks)) : mapChunkSize, 
                    MAP_ROW_COUNT: MAP_SIZE, 
                    MAP_OFFSET_X: offsetX, 
                    MAP_OFFSET_Y: offsetY,
                    DIGGER: 1
                });
                digWorkers.push(digWorker);
                digWorker.on("message", async (msg) => {
                    //console.log("Child worker %s message: %s", digWorker.id, JSON.stringify(msg));

                    if (msg.cmd === "treasures") {
                        let treasures = msg.treasures;
                        console.log("worker %s digged %s treasures at [%s, %s]: %s", digWorker.id, treasures.length, msg.x, msg.y, treasures);
                        console.log("exchanging treasures to earn money...");
                        let coins = await exchangeTreasuresForCoins(treasures);
                        console.log("earned %s coins: %s", coins.length, coins);
                        _coins.push(...coins);

                        console.log("total %s coins. getting actual balance...", _coins.length);
                        let balance = await getBalance();
                        console.log("balance is %s with coins (%s): %s", balance.balance, balance.wallet.length, balance.wallet);
                        //_coins = balance.wallet;
                    }
                });
            }
            
            let exploreWorker = cluster.fork({ EXPLORER: 1 });
            exploreWorker.on("message", async (msg) => {
                if (msg.cmd === "explore") {
                    let digWorkerIndex = Math.round(Math.random() * (numCPUsForForks - 1));
                    //console.log("explorer %s found cell with treasures (%s): [%s, %s], sending to %s digger", exploreWorker.id, msg.amount, msg.x, msg.y, digWorkerIndex);
                    digWorkers[digWorkerIndex].send({ cmd: "treasures", cell: { x: msg.x, y: msg.y, amount: msg.amount } });
                }
            });

            let licenseWorker = cluster.fork({ LICENSER: 1 });
            licenseWorker.on("message", async (msg) => {
                if (msg.cmd === "license") {
                    let license = msg.license;
                    let digWorkerIndex = Math.round(Math.random() * (numCPUsForForks - 1));
                    console.log("licenser %s got %s license %s with %s dig allowed, sending to %s digger", licenseWorker.id, license.paid ? "paid" : "free", license.id, license.digAllowed, digWorkerIndex);
                    digWorkers[digWorkerIndex].send({ cmd: "license", license });
                }
            });

            // If worker process is killed log it
            cluster.on('exit', (worker) => {
                console.log(`Worker ${worker.process.pid} died.`)
            });

            // Once a worker is connected output they are online
            cluster.on('online', (worker) => {
                console.log(`Worker ${worker.process.pid} is online.`)
            });

            process.on('SIGINT', () => {
                for(const id in cluster.workers) {
                    cluster.workers[id].kill('SIGINT')
                }
            });

            /*
            if (MAP_SIZE > mapChunkSize * numCPUsForForks) {
                console.log("available %s cols to process inplace in master", MAP_SIZE - mapChunkSize * numCPUsForForks);
                await workGoldRush(MAP_SIZE - mapChunkSize * numCPUsForForks, MAP_SIZE, mapChunkSize * numCPUsForForks, 0);
            }
            */

            console.log("keeping master process alive...");
            await sleep(900000);
            console.log("master process timeout");
        } else {
            console.log("%s: run gold rush work for chunk: x=%s, y=%s, cells=%s, rows=%s", 
                cluster.isMaster ? "single" : "fork", MAP_OFFSET_X, MAP_OFFSET_Y, MAP_CELL_COUNT, MAP_ROW_COUNT);
            if (process.send) {
                process.send({ cmd: "rungoldrush", chunkx: MAP_OFFSET_X, chunky: MAP_OFFSET_Y, chunksizex: MAP_CELL_COUNT, chunksizey: MAP_ROW_COUNT });
            }

            if (process.env.EXPLORER) {
                await workExplorer(MAP_CELL_COUNT, MAP_ROW_COUNT, MAP_OFFSET_X, MAP_OFFSET_Y);
            } else if (process.env.DIGGER) {
                await workDigger(MAP_CELL_COUNT, MAP_ROW_COUNT, MAP_OFFSET_X, MAP_OFFSET_Y);
            } else if (process.env.LICENSER) {
                await workLicenses(MAP_CELL_COUNT, MAP_ROW_COUNT, MAP_OFFSET_X, MAP_OFFSET_Y);
            } else {
                await workGoldRush(MAP_CELL_COUNT, MAP_ROW_COUNT, MAP_OFFSET_X, MAP_OFFSET_Y);
            }
            
            if (process.send) {
                process.send({ cmd: "goldrushcompleted", coinslen: _coins.length, coins: _coins });
            }
        }
    } catch (err) {
        console.log("App error: %s", err);
        if (process.send) {
            process.send({ cmd: "apperror", err });
        }
    } finally {
        let endTime = new Date();
        console.log("The app worked for %s ms and made %s requests.", endTime - startTime, requestsCount);
    }
})();

async function workLicenses() {
    while (true) {
        await sleep(50);
        let licenses = await getLicenses();
        if (licenses.code) {
            console.log("failed to get licenses due to error (%s): %s", licenses.code, licenses.message);
            continue;
        }
        let freeActive = 0;
        let paidActive = 0;
        licenses.forEach((l, i) => {
            console.log("licenses[%s] with %s id, %s dig allowed and %s dig used", i, l.id, l.digAllowed, l.digUsed);
            if (l.digAllowed === l.digUsed) return;
            let digCapacity = l.digAllowed;
            if (digCapacity === 3) {
                //free license
                if (l.digAllowed > l.digUsed) {
                    freeActive++;
                }
            }
            
            if (digCapacity > 3) {
                //paid license
                if (l.digAllowed > l.digUsed) {
                    paidActive++;
                }
            }
        });

        if (freeActive < MAX_LICENSES_FREE) {
            for (let i = freeActive; i < MAX_LICENSES_FREE; i++) {
                let freeLicense = await issueLicense();
                if (freeLicense.code) {
                    console.log("failed to issue free license due to error (%s): %s", freeLicense.code, freeLicense.message);
                    continue;
                }
                console.log("issued free license %s with %s digs allowed", freeLicense.id, freeLicense.digAllowed);
                freeLicense.free = true;
                if (process.send) {
                    process.send({ cmd: "license", free: true, license: freeLicense });
                }
            }
        }
        
        let balance = await getBalance();
        let coinsFromWallet = [...balance.wallet];
        coinsFromWallet.reverse();
        //console.log("balance wallet (%s): %s", balance.wallet.length, balance.wallet);
        if (process.env.USE_PAID_LICENSES && paidActive < MAX_LICENSES_PAID && balance.wallet.length > 0) {
            for (let i = paidActive; i < MAX_LICENSES_PAID; i++) {
                let coinsToPayLicense = coinsFromWallet.splice(0, Math.round(balance.wallet.length * (Number(process.env.COINS_PERCENTAGE_FOR_PAID_LICENSE) || 0.1)));
                console.log("pay %s coins to issue a paid license: %s", coinsToPayLicense.length, coinsToPayLicense);
                let paidLicense = await issueLicense(coinsToPayLicense);
                if (paidLicense.code) {
                    console.log("failed to issue paid license due to error (%s): %s", paidLicense.code, paidLicense.message);
                    continue;
                }
                console.log("issued paid license %s with %s digs allowed", paidLicense.id, paidLicense.digAllowed);
                paidLicense.paid = true;
                if (process.send) {
                    process.send({ cmd: "license", paid: true, license: paidLicense });
                }
            }
        }
    }
}

async function workGoldRush(cellCount, rowCount, offsetX, offsetY, exploreonly = false) {
    
    let mapCellCount = cellCount * rowCount;
    //getLicenses();
    for (let i = 0; i < mapCellCount; i++) {
        let xi = i % cellCount + offsetX;
        let yi = Math.floor(i / cellCount) + offsetY;
        let depthlevel = 1;

        console.log("exploring [%s, %s]...", xi, yi);
        let explored = await explore(xi, yi, 1, 1);
        if (!explored) {
            explored = { code: 0, message: "server didn't respond anything" };
        }
        if (explored.code) {
            console.log("exploration for [%s, %s] completed with error (%s): %s. getting next...", xi, yi, explored.code, explored.message);
            continue;
        }
        let amountAvailable = explored.amount;
        console.log("explored [%s, %s]: %s", xi, yi, amountAvailable);

        if (amountAvailable) {
            if (process.send) {
                process.send({ cmd: "explore", x: xi, y: yi, amount: amountAvailable });
            }
        }

        if (exploreonly) {
            continue;
        }

        if (!amountAvailable) {
            console.log("nothing to dig. getting next...");
            continue;
        }
        
        while (amountAvailable) {            
            console.log("getting licenses...");
            let licenses = await getLicenses();
            console.log("issued licenses: %s", licenses.length);
            let licenseToDig = licenses.find(x => x.digAllowed);
            if (!licenseToDig) {
                //issue free or paid license
                console.log("getting issue free or paid license...");
                /*
                let coinsForLicense = null;
                if (_coins.length >= 1000) {
                    coinsForLicense = _coins.splice(0, 100);
                    if (coinsForLicense.length) {
                        console.log("Purchase a paid license for %s coins", coinsForLicense);
                    }
                }
                licenseToDig = await issueLicense(coinsForLicense);
                */
                while (!licenseToDig) {
                    licenseToDig = await issueLicense();
                    if (licenseToDig.code === 409) {
                        licenseToDig = null;
                        console.log("no more active licenses to issue. awaiting...");
                        await sleep(50);
                    }
                }
                //_licenses.push(licenseToDig);
                console.log("issued license: id=%s, digAllowed=%s", licenseToDig.id, licenseToDig.digAllowed);
            }
            console.log("active license obtained with %s digs allowed.", licenseToDig.digAllowed);
            console.log("digging for [%s, %s] for %s depth and %s license id...", xi, yi, depthlevel, licenseToDig.id);
            let digAllowed = licenseToDig.digAllowed;
            let treasures = [];
            let shouldNextCell = false;
            while (digAllowed-- > 0) {
                let diggedTreasures = await dig(licenseToDig.id, xi, yi, depthlevel++);
                if (diggedTreasures.code) {
                    if (diggedTreasures.code === 404) {
                        continue;
                    } else {
                        console.log("dig completed with error (%s): %s", diggedTreasures.code, diggedTreasures.message);
                        digAllowed++;
                        if (depthlevel > 10 && diggedTreasures.code === 608) {
                            shouldNextCell = true;
                            break;
                        }
                    }
                }
                if (diggedTreasures.length) {
                    console.log("digged %s treasures at %s depth: %s", diggedTreasures.length, depthlevel, JSON.stringify(diggedTreasures));
                    //treasures = [...treasures];
                    
                    for (let i = 0; i < diggedTreasures.length; i++) {
                        treasures.push(diggedTreasures[i]);
                    }
                }
            }
            if (shouldNextCell) {
                if (amountAvailable) {
                    console.log("Failed to dig %s treasures at [%s, %s] cell. Breaking...", xi, yi);
                }
                break;
            }
            console.log("found %s treasures: %s", treasures.length, treasures);
                
            if (treasures.length) {
                if (process.send) {
                    process.send({ cmd: "treasures", treasures, x: xi, y: yi });
                }
            }

            amountAvailable -= treasures.length;
            if (amountAvailable) {
                console.log("left %s treasures at [%s, %s] pos", amountAvailable, xi, yi);
            } else {
                console.log("pos [%s, %s] contains no more treasures", xi, yi);
            }
        }
    }
}

async function workExplorer(cellCount, rowCount, offsetX, offsetY, exploreonly = false) {
    
    let mapCellCount = cellCount * rowCount;
    //getLicenses();
    for (let i = 0; i < mapCellCount; i++) {
        let xi = i % cellCount + offsetX;
        let yi = Math.floor(i / cellCount) + offsetY;
        let depthlevel = 1;

        console.log("exploring [%s, %s]...", xi, yi);
        let explored = await explore(xi, yi, 1, 1);
        if (!explored) {
            explored = { code: 0, message: "server didn't respond anything" };
        }
        if (explored.code) {
            console.log("exploration for [%s, %s] completed with error (%s): %s. getting next...", xi, yi, explored.code, explored.message);
            continue;
        }
        let amountAvailable = explored.amount;
        console.log("explored [%s, %s]: %s", xi, yi, amountAvailable);

        if (amountAvailable) {
            if (process.send) {
                process.send({ cmd: "explore", x: xi, y: yi, amount: amountAvailable });
            }
        }
    }
}


async function workDigger(cellCount, rowCount, offsetX, offsetY) {
    const cellsWithTreasures = [];
    const licenses = [];

    process.on("message", msg => {
        if (msg.cmd === "treasures") {
            cellsWithTreasures.push(msg.cell);
        }
        if (msg.cmd === "license") {
            let license = msg.license;
            if (license.free) {
                licenses.unshift(license)
            } else {
                licenses.push(license);
            }
        }
    });

 while (true) {
  let nextCell = cellsWithTreasures.shift();
  if (!nextCell) {
      console.log("no cells with treasures. awaiting...");
   await sleep(50);
   continue;
  }
  let xi = nextCell.x;
  let yi = nextCell.y;
  let amountAvailable = nextCell.amount;
  
  let depthlevel = 1;
  
  if (depthlevel > MAX_DEPTH && process.env.EXPLICIT_RESTRICT_MAX_DEPTH_LEVEL) {
      amountAvailable = 0;
  }

  while (amountAvailable) {   
      let licenseToDig = null;
      while (!(licenseToDig = licenses.pop())) {

        console.log("no license to dig. awaiting...");
        await sleep(50);
      }
      console.log("active license obtained with %s digs allowed and %s digs used.", licenseToDig.digAllowed, licenseToDig.digUsed);
      console.log("digging for [%s, %s] for %s depth and %s license id...", xi, yi, depthlevel, licenseToDig.id);
      let treasures = [];
      
      let diggedTreasures = await dig(licenseToDig.id, xi, yi, depthlevel++);
      licenseToDig.digUsed++;
      if (diggedTreasures.code) {
          if (diggedTreasures.code === 404) {
              // continue
          } else if (diggedTreasures.code === 403 && diggedTreasures.message === "no such license") {
              console.log("broken license %s to dig at [%s, %s], getting another...", licenseToDig.id, xi, yi);
              licenseToDig.digUsed = licenseToDig.digAllowed;
          } else {
              console.log("dig completed with error (%s): %s", diggedTreasures.code, diggedTreasures.message);
              licenseToDig.digUsed--;
              if (depthlevel > 10 && [608, 1000].includes(diggedTreasures.code)) {
                  amountAvailable = 0;
              }
          }
      }
      if (diggedTreasures.length) {
          console.log("digged %s treasures at %s depth: %s", diggedTreasures.length, depthlevel, JSON.stringify(diggedTreasures));
          //treasures = [...treasures];
          
          if (depthlevel >= (Number(process.env.MIN_DEPTH_TO_SELL_TREASURES) || 5)) {
            for (let i = 0; i < diggedTreasures.length; i++) {
                treasures.push(diggedTreasures[i]);
            }
          }
      }
      console.log("found %s treasures: %s", treasures.length, treasures);
          
      if (treasures.length) {
          if (process.send) {
              process.send({ cmd: "treasures", treasures, x: xi, y: yi });
          }
      }

      amountAvailable -= treasures.length;
      if (amountAvailable) {
          console.log("left %s treasures at [%s, %s] pos", amountAvailable, xi, yi);
      } else {
          console.log("pos [%s, %s] contains no more treasures", xi, yi);
      }

      
    if (licenseToDig.digAllowed - licenseToDig.digUsed > 0) {
        if (licenseToDig.free) {
            licenses.unshift(licenseToDig);
        } else {
            licenses.push(licenseToDig);
        }
    }
  }

 }

}

async function exchangeTreasuresForCoins(treasures) {
    treasures = treasures || [];
    
    let coins = [];
    treasures.forEach(async (treasure) => {
        let coinsForTreasure = await postApi("/cash", treasure);
        
        if (coinsForTreasure.code) {
            console.log("failed to exchange treasure %s for coins due to error (%s): %s", treasure, coinsForTreasure.code, coinsForTreasure.message);
        } else {
            for (let i = 0; i < coinsForTreasure.length; i++) {
                coins.push(coinsForTreasure[i]);
            }
        }
    });
    return coins;
}

async function getBalance() {
    return await getApi("/balance");
}

async function issueLicense(coins) {
    coins = coins || [];
    return await postApi("/licenses", coins);
}

async function getLicenses() {
    return await getApi("/licenses");
}

async function explore(posX, posY, sizeX, sizeY) {
    return await postApi("/explore", { posX, posY, sizeX, sizeY });
};

async function dig(licenseID, posX, posY, depth = 1) {
    return await postApi("/dig", { licenseID, posX, posY, depth });
};

async function postApi(method, payload) {
    method = method.indexOf('/') !== 0 ? "/".concat(method) : method;
    try {
        return await (await fetchApi(API_BASE_URL + method, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(payload)
        })).json();
    } catch (err) {
        return await (await fetchApi(API_BASE_URL + method, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(payload)
        })).json();
    }
}

async function getApi(method) {
    method = method.indexOf('/') !== 0 ? "/".concat(method) : method;
    try {
        return await (await fetchApi(API_BASE_URL + method)).json();
    } catch (err) {
        return await (await fetchApi(API_BASE_URL + method)).json();
    }
}

let lastRequestTime = null;

async function fetchApi(method, options) {
    options = options || { method: "GET" };
    let apiUrl = method.indexOf("http") === 0 ? method : (API_BASE_URL + method);
    let responseStatus = null;
    let retryLeft = 1000;
    let res = null;
    let requestTime = new Date();
    requestsCount++;
    /*
    if (lastRequestTime && requestTime - lastRequestTime < 50) {
        console.log("Too high request rate. Sleeping %s...", requestTime - lastRequestTime + 50);
        await sleep(requestTime - lastRequestTime + 50);
    }
    */
    lastRequestTime = requestTime;
    while ([null, 500, 502, 504].includes(responseStatus) || (responseStatus > 500 && responseStatus < 600)) {
        if (responseStatus !== null) {
            console.log("Server failed to process %s %s request and ended with %s error", options.method, method, responseStatus);
            
            try {
                let resHealthCheck = await fetch(API_BASE_URL + "/health-check");
                if (resHealthCheck.status !== 200) {
                    console.log("Server health check request ended with http error: %s. Sleeping for 100 ms...", resHealthCheck.status);
                    await sleep(100);
                }
            } catch (err) {
                console.log("Server health check request failed due to error: %s", err);
            }
        }
        try {
            res = await fetch(apiUrl, options);
        } catch (err) {
            console.log("Server failed to respond to %s %s request due to error: %s. Trying one more time...", options.method, method, err);
            await sleep(100);
            responseStatus = 500;
        }
        responseStatus = res !== null ? res.status : 500;
        if (responseStatus >= 500 && responseStatus < 600 && --retryLeft === 0) break;        
    }
    /*
    if (res.status !== 200) {
        console.log("fetch api %s method completed with error: %s", method, res.status);
        let error = await res.json();
        console.log("api error:");
        console.log(error);
        throw new Error(`Api error (${res.status}): ${JSON.stringify(error)}`);
    }
    */
    return res;
}

const exploreArgs = {
    "posX": 0,
    "posY": 0,
    "sizeX": 0,
    "sizeY": 0
  }

const licenseDummy = {
    "id": 0,
    "digAllowed": 0,
    "digUsed": 0
  };