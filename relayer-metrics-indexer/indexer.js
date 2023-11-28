// using most of the code from https://github.com/cryptocrew-validators/relayer-metrics-exporter
// needs to be extended for gas fee related information
// save to db, prom exporter can read from there

import axios from 'axios';
import sqlite3 from 'sqlite3';


import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { Tx } = require('cosmjs-types/cosmos/tx/v1beta1/tx');
const { PubKey } = require('cosmjs-types/cosmos/crypto/secp256k1/keys');
const { pubkeyToAddress } = require('@cosmjs/amino');

import config from './config.js';

const sqlite = sqlite3.verbose();
const db = new sqlite.Database('./relayerMetrics.db', (err) => {
  if (err) {
    console.error(err.message);
  }
  console.log('Connected to the relayer metrics SQLite database.');
});

let latestBlockHeight = 0;
let latestBlockTime = "";
let isCatchingUp = true;
let totalGasWanted = 0;
let totalGasUsed = 0;
let totalFee = 0;
let transactionCount = 0;

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS relayer_transactions (
    block_height INTEGER,
    block_time TEXT,
    relayer_address TEXT,
    msg_array TXT,
    gas_wanted INTEGER,
    gas_used INTEGER,
    fee_amount INTEGER,
    gas_price REAL
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS total_metrics (
    block_height INTEGER,
    block_time TEXT,
    total_gas_wanted INTEGER,
    total_gas_used INTEGER,
    total_fee INTEGER,
    transaction_count INTEGER
  )`);
});

async function saveTransactionData(blockHeight, blockTime, relayerAddress, msgArray, gasWanted, gasUsed, feeAmount, gasPrice) {
  db.run(`INSERT INTO relayer_transactions (
    block_height, 
    block_time, 
    relayer_address, 
    msg_array, 
    gas_wanted, 
    gas_used, 
    fee_amount, 
    gas_price
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, 
    [
      blockHeight, 
      blockTime, 
      relayerAddress, 
      msgArray, 
      gasWanted, 
      gasUsed, 
      feeAmount, 
      gasPrice
    ], (err) => {
      if (err) {
        console.error(err.message);
      }
  });
  let statementString = `INSERT INTO relayer_transactions (
    block_height, 
    block_time, 
    relayer_address, 
    msg_array, 
    gas_wanted, 
    gas_used, 
    fee_amount, 
    gas_price
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ` + JSON.stringify( 
    [
      blockHeight, 
      blockTime, 
      relayerAddress, 
      msgArray, 
      gasWanted, 
      gasUsed, 
      feeAmount, 
      gasPrice
    ]);
  console.log(`saved total_metrics:`);
  console.log(statementString);
  return;
}

async function saveTotalMetricsData(blockHeight, blockTime, totalGasWanted, totalGasUsed, totalFee, transactionCount) {
  db.run(`INSERT INTO total_metrics (
    block_height, 
    block_time, 
    total_gas_wanted, 
    total_gas_used, 
    total_fee, 
    transaction_count
    ) VALUES (?, ?, ?, ?, ?, ?)`, 
    [
      blockHeight, 
      blockTime, 
      totalGasWanted, 
      totalGasUsed, 
      totalFee, 
      transactionCount
    ], (err) => {
      if (err) {
        console.error(err.message);
      }
  });
  let statementString = `INSERT INTO total_metrics (
    block_height, 
    block_time, 
    total_gas_wanted, 
    total_gas_used, 
    total_fee, 
    transaction_count
    ) VALUES (?, ?, ?, ?, ?, ?) ` + JSON.stringify( 
    [
      blockHeight, 
      blockTime, 
      totalGasWanted, 
      totalGasUsed, 
      totalFee, 
      transactionCount
    ]);
  console.log(`saved total_metrics:`);
  console.log(statementString);
  return;
}

async function getBlock(height) {
  try {
    const response = await axios.get(`${config.rpc_url}/block?height=${height}`);
    return response.data.result.block;
  } catch (error) {
    console.error(`Error fetching block at height ${height}:`, error);
    return null;
  }
}

function deriveAddressFromPubkey(pubkeyValue) {
  let key = PubKey.toJSON(PubKey.decode(pubkeyValue)).key.toString();
  let pubkey = {
      "type": "tendermint/PubKeySecp256k1",
      "value": key
  }
  return pubkeyToAddress(pubkey, config.addr_prefix);
}

async function processTransaction(tx) {
  try {
    let buff = Buffer.from(tx, 'base64');
    let txDecoded = Tx.decode(buff);
    let isRelayerTx = false;
    let typeArray = [];

    txDecoded.body.messages.forEach((msg) => {
      typeArray.push(msg.typeUrl)
      if (msg.typeUrl.includes('/ibc') && msg.typeUrl != "/ibc.applications.transfer.v1.MsgTransfer") {
        isRelayerTx = true;
      }
    });

    if (isRelayerTx) {
//      if (txDecoded.authInfo.fee.granter == config.granter_address) {
        const gasWanted = parseInt(txDecoded.authInfo.fee.gasLimit || '0', 10);
        const gasUsed = parseInt(txDecoded.authInfo.fee.gasUsed || '0', 10); // this doesn't work: how do we correctly get the gas used for the tx?
        const feeAmount = parseInt(txDecoded.authInfo.fee.amount?.[0]?.amount || '0');
        const gasPrice = feeAmount / gasWanted;

        const relayerAdress = deriveAddressFromPubkey(txDecoded.authInfo.signerInfos[0].publicKey.value);

        await saveTransactionData(
          parseInt(latestBlockHeight), 
          latestBlockTime,
          relayerAdress,
          typeArray,
          gasWanted,
          gasUsed,
          feeAmount,
          gasPrice
        );

        // TODO: create sqlite db and save the gas & fee information of every tx for every relayer. 
        // we need to also save the block height (and time) for later reference

        // Update total metrics
        totalGasWanted += gasWanted;
        totalGasUsed += gasUsed;
        totalFee += parseInt(feeAmount, 10);
        transactionCount++;
        return true;
      }
//    }

  } catch (error) {
    console.error('Error processing transaction:', error);
  }
  return false;
}

async function processBlock(blockData) {
  let txs = blockData.txs;
  let blockHasRelayerTx = false;
  let isRelayerTx = false;
  if (txs) {
    txs.forEach(async (tx) => {
      isRelayerTx = await processTransaction(tx);
      if (isRelayerTx) {
        blockHasRelayerTx = true;
      }
    });
  }
  if (blockHasRelayerTx) {
    await saveTotalMetricsData(
      parseInt(latestBlockHeight),
      latestBlockTime,
      totalGasWanted,
      totalGasUsed,
      totalFee,
      transactionCount
    )
  }
}

async function updateLatestBlockHeight() {
  try {
    const response = await axios.get(`${config.rpc_url}/block`);
    latestBlockHeight = response.data.result.block.header.height;
    latestBlockTime = response.data.result.block.header.time;
  } catch (error) {
    console.error('Error fetching latest block height:', error);
  }
}

async function indexer() {
  let currentHeight = config.start_block_height;

  while (isCatchingUp) {
    await updateLatestBlockHeight();
    while (currentHeight <= latestBlockHeight) {
      const block = await getBlock(currentHeight);
      if (block) {
        await processBlock(block.data);
      }
      console.log('processed block: ' + currentHeight)
      currentHeight++;
    }

    if (currentHeight > latestBlockHeight) {
      isCatchingUp = false;
    }
  }

  // Polling for new blocks
  setInterval(async () => {
    await updateLatestBlockHeight();
    if (currentHeight <= latestBlockHeight) {
      const block = await getBlock(currentHeight);
      if (block) {
        await processBlock(block.data);
      }
      currentHeight++;
    }
  }, config.poll_frequency); 
}

process.on('exit', () => {
  db.close((err) => {
    if (err) {
      console.error(err.message);
    }
    console.log('Close the database connection.');
  });
});

indexer();