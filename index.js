const fetch = require("node-fetch");
const process = require('process');
const util = require('util');
const sleep = ms => new Promise((resolve, reject) => setTimeout(() => { resolve(); }, ms));

const API_ADDRESS = process.env.ADDRESS || "default";
const API_PORT = process.env.Port || 8000;
const API_SCHEMA = process.env.Schema || "http";

const API_BASE_URL = `${API_SCHEMA}://${API_ADDRESS}${API_PORT === 80 || API_PORT === 443 ? "" : ":".concat(API_PORT)}`;

const MAP_START_X = Number(process.env.STARTPOSX || 0);
const MAP_START_Y = Number(process.env.STARTPOSY || 0);
const MAP_AREA_SIZE_X = Number(process.env.AREASIZEX || 3500);
const MAP_AREA_SIZE_Y = Number(process.env.AREASIZEY || 3500);

const MAP_SIZE = 3500;
const MAP_CELL_COUNT = MAP_SIZE * MAP_SIZE;
const DEPTH = 10;
const MAX_LICENSES_FREE = 3;
const MAX_LICENSES_PAID = 5;
const MAX_LICENSES_ACTIVE = 10;

const licenses = [];

const diggedCoords = [];

(async () => {
    try {
        //getLicenses();
        for (let i = 0; i < MAP_CELL_COUNT; i++) {
            let xi = i % MAP_SIZE;
            let yi = Math.floor(i / MAP_SIZE);
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
                    licenseToDig = await issueLicense();
                    console.log("issued license: id=%s, digAllowed=%s", licenseToDig.id, licenseToDig.digAllowed);
                }
                console.log("active license obtained with %s digs allowed.", licenseToDig.digAllowed);
                console.log("digging for [%s, %s] for %s depth and %s license...", xi, yi, licenseToDig.digAllowed, licenseToDig.id);
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
    } catch (err) {
        console.log("App error: %s", err);
    }
})();

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
        let res = await fetchApi(API_BASE_URL + "/health-check");
        if (res.status !== 200) {
            throw err;
        }
        await sleep(200);
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
        let res = await fetchApi(API_BASE_URL + "/health-check");
        if (res.status !== 200) {
            throw err;
        }
        await sleep(200);
        return await (await fetchApi(API_BASE_URL + method)).json();
    }
}

async function fetchApi(method, options) {
    options = options || { method: "GET" };
    let apiUrl = method.indexOf("http") === 0 ? method : (API_BASE_URL + method);
    let responseStatus = null;
    let retryLeft = 1000;
    let res = null;
    while ([null, 502, 504].includes(responseStatus)) {
        res = await fetch(apiUrl, options);
        responseStatus = res.status;
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