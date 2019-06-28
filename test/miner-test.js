/*!
 * test/miner-test.js - test for hsd miner
 * Copyright (c) 2019, Mark Tyneway (MIT License).
 * https://github.com/handshake-org/hsd
 */

/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

const assert = require('bsert');
const Network = require('../lib/protocol/network');
const Chain = require('../lib/blockchain/chain');
const Miner = require('../lib/mining/miner');
const Mempool = require('../lib/mempool/mempool');
const WalletDB = require('../lib/wallet/walletdb');
const rules = require('../lib/covenants/rules');
const FullNode = require('../lib/node/fullnode');

const network = Network.get('regtest');
const {treeInterval} = network.names;

/*
 * create a miner outside of the node
 * share the fullnode's chain with the miner
 *
 * create another miner
 * mine from height in previous epoch
 * create valid blocks through the next tree commit
 *
 */

const node = new FullNode({
  memory: true,
  apiKey: 'foo',
  network: 'regtest',
  plugins: [require('../lib/wallet/plugin')]
});

const {wdb} = node.require('walletdb');
const chain = node.chain;
const mempool = node.mempool;
const miner = node.miner;

let wallet, keyring;

describe('Miner Test', function() {
  before(async () => {
    await node.open();
    wallet = await wdb.create({network});

    // set controlled address on miner
    const walletkey = await wallet.createReceive();
    keyring = walletkey.getJSON(network);
    miner.addresses = [keyring.address];
  });

  after(async () => {
    await node.close();
  });

  it('should start with chain at height 0', () => {
    assert.equal(chain.height, 0);
  });

  it('should create block the miner stored address', async () => {
    const block = await miner.cpu.mineBlock();

    const addresses = [];
    for (const tx of block.txs)
      for (const output of tx.outputs)
        addresses.push(output.address.toString(network));

    assert.equal(addresses.length, 1);
    assert.equal(addresses[0], keyring.address)
  });

  it('should add blocks to the chain', async () => {
    const height = 6;
    for (let i = 0; i < height; i++) {
      const block = await miner.cpu.mineBlock();
      assert.ok(await chain.add(block));
      await sleep(100);
    }
    assert.equal(chain.height, height);
  });

  it('should mine a tx that alters the treeRoot', async () => {
    const root = node.chain.tip.treeRoot;
    const name = rules.grindName(5, chain.height - 1, network);
    const mtx = await wallet.sendOpen(name, true);

    await sleep(100);

    const txid = Buffer.from(mtx.txid(), 'hex');
    assert(mempool.getTX(txid));

    for (let i = 0; i < treeInterval; i++) {
      const block = await miner.cpu.mineBlock();
      assert.ok(await chain.add(block));
      await sleep(100);
    }

    assert.ok(!root.equals(node.chain.tip.treeRoot));
  });

  it('should mine on alternative chain', async () => {
    this.skip();

    const height = chain.height;
    // get block entry
    // const block = await miner.cpu.mineBlock(entry);
    // assert.ok(await chain.add(block))
    // assert.equal(height, chain.height);
    // assert that its not in the main chain

  });

  it('should mine on alt chain (different interval)', async () => {
    this.skip();

  });
});

// need mineBlocks

function sleep(time) {
  return new Promise(resolve => setTimeout(resolve, time));
}
