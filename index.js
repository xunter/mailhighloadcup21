const fetch = require("node-fetch");
const process = require('process');
const cluster = require('cluster');
const numCPUs = require('os').cpus().length;
const util = require('util');
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
const DEPTH = 10; //100
const MAX_LICENSES_FREE = 3;
const MAX_LICENSES_PAID = 5;
const MAX_LICENSES_ACTIVE = 10;

const _licenses = [];
const _coins = [];

let startTime = new Date();
let requestsCount = 0;

(async () => {
    try {
        process.env.MULTICORE = 1;
        if (process.env.MULTICORE && cluster.isMaster) {
            let numCPUsForForks = process.env.CORE_COUNT || (numCPUs - 1);
            console.log("master: solution will start as multicore with %s cpus (1 CPU for master)", numCPUsForForks);
            let mapChunkSize = Math.floor(MAP_SIZE / numCPUsForForks);
            for (let i = 0; i < numCPUsForForks; i++) {
                let offsetX = i * mapChunkSize;
                let offsetY = 0;
                cluster.fork({ MAP_CELL_COUNT: mapChunkSize, MAP_ROW_COUNT: MAP_SIZE, MAP_OFFSET_X: offsetX, MAP_OFFSET_Y: offsetY });
            }
            if (MAP_SIZE > mapChunkSize * numCPUsForForks) {
                console.log("available %s rows to process inplace in master", MAP_SIZE - mapChunkSize * numCPUsForForks);
                await workGoldRush(MAP_SIZE - mapChunkSize * numCPUsForForks, MAP_SIZE, mapChunkSize * numCPUsForForks, 0);
            }
        } else {
            console.log("%s: run gold rush work for chunk: x=%s, y=%s, cells=%s, rows=%s", 
                cluster.isMaster ? "single" : "fork", MAP_OFFSET_X, MAP_OFFSET_Y, MAP_CELL_COUNT, MAP_ROW_COUNT);
            await workGoldRush(MAP_CELL_COUNT, MAP_ROW_COUNT, MAP_OFFSET_X, MAP_OFFSET_Y);
        }
    } catch (err) {
        console.log("App error: %s", err);
    } finally {
        let endTime = new Date();
        console.log("The app worked for %s ms and made %s requests.", endTime - startTime, requestsCount);
    }
})();

async function workGoldRush(cellCount, rowCount, offsetX, offsetY) {
    
    let mapCellCount = cellCount * rowCount;
    //getLicenses();
    for (let i = 0; i < mapCellCount; i++) {
        let xi = i % cellCount + offsetX;
        let yi = Math.floor(i / cellCount) + offsetY;
        let depthlevel = 1;

        console.log("exploring [%s, %s]...", xi, yi);
        let amountAvailable = await explore(xi, yi, 1, 1);
        console.log("explored [%s, %s]: %s", xi, yi, amountAvailable);

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
                let coinsForLicense = _coins.splice(0, 100);
                if (coinsForLicense.length) {
                    console.log("Purchase a paid license for %s coins", coinsForLicense);
                }
                licenseToDig = await issueLicense(coinsForLicense);
                */
                licenseToDig = await issueLicense();
                //_licenses.push(licenseToDig);
                console.log("issued license: id=%s, digAllowed=%s", licenseToDig.id, licenseToDig.digAllowed);
            }
            console.log("active license obtained with %s digs allowed.", licenseToDig.digAllowed);
            console.log("digging for [%s, %s] for %s depth and %s license id...", xi, yi, depthlevel, licenseToDig.id);
            let digAllowed = licenseToDig.digAllowed;
            let treasures = [];
            while (digAllowed-- > 0) {
                let diggedTreasures = await dig(licenseToDig.id, xi, yi, depthlevel++);
                console.log("digged %s treasures: %s", depthlevel, JSON.stringify(diggedTreasures));
                //treasures = [...treasures];
                
                for (let i = 0; i < diggedTreasures.length; i++) {
                    treasures.push(diggedTreasures[i]);
                }
            }
            console.log("found %s treasures: %s", treasures.length, treasures);
                
            if (treasures.length) {
                console.log("exchanging treasures to earn money...");
                let coins = await exchangeTreasuresForCoins(treasures);
                console.log("earned %s coins", coins.length);
                _coins.push(...coins);

                console.log("getting balance...");
                let balance = await getBalance();
                console.log("balance is %s with coins (%s): %s", balance.balance, balance.wallet.length, balance.wallet);
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

async function exchangeTreasuresForCoins(treasures) {
    treasures = treasures || [];
    
    let coins = [];
    treasures.forEach(async (treasure) => {
        let coinsForTreasure = await postApi("/cash", treasure);
        for (let i = 0; i < coinsForTreasure.length; i++) {
            coins.push(coinsForTreasure[i]);
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
    let res = await postApi("/explore", { posX, posY, sizeX, sizeY });
    return res.amount;
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
            console.log("Server failed to process %s request and ended with %s error", method, responseStatus);
            
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
            console.log("Server failed to respond to %s request due to error: %s. Trying one more time...", method, err);
            await sleep(100);
            responseStatus = 500;
        }
        responseStatus = res !== null ? res.status : 500;
        if (--retryLeft === 0) break;        
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