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
const ChainEntry = require('../lib/blockchain/chainentry');
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
  });

  beforeEach(async () => {
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

  it('should mine a fork of a single block', async () => {
    // mine on a lesser height
    const height = chain.height - 2;
    const forkPoint = await chain.getEntry(height);

    const block = await miner.cpu.mineBlock(forkPoint);
    assert.ok(await chain.add(block))

    const entry = ChainEntry.fromBlock(block, forkPoint);
    assert.ok(!await chain.isMainChain(entry));
  });

  it('should mine a reorg within the same interval', async () => {
    // be sure to be at the first block of a new interval
    // TODO: consider moving this to beforeEach
    while (chain.height % treeInterval !== 1) {
      const entry = await chain.getEntry(chain.height);
      const block = await miner.cpu.mineBlock(entry);
      assert.ok(await chain.add(block));
      await sleep(100);
    }

    // the tip is the first block with the new treeRoot
    assert(chain.height % treeInterval === 1);

    const forkHeight = chain.height;

    // set up reorg listener
    let reorged = false;
    node.chain.once('reorganize', () => {
      reorged = true;
    });

    for (let i = 0; i < 2; i++) {
      const entry = await chain.getEntry(forkHeight + i);
      const block = await miner.cpu.mineBlock(entry);

      assert.ok(await chain.add(block));
      await sleep(100);
    }

    // mine 3 blocks starting at the fork height
    let prevBlock;
    for (let i = 0; i < 3; i++) {
      // use forkHeight the first time
      const arg = prevBlock ? prevBlock : forkHeight;

      const entry = await chain.getEntry(arg);
      const block = await miner.cpu.mineBlock(entry);

      prevBlock = block.hash();

      assert.ok(await chain.add(block));
      await sleep(100);
    }

    assert.equal(reorged, true);
  });

  // no different tree state, the treeRoots shouldn't be different
  it('should mine a reorg between intervals', async () => {
    let reorged = false;
    node.chain.once('reorganize', () => {
      reorged = true;
    });

    while (chain.height % treeInterval !== 1) {
      const entry = await chain.getEntry(chain.height);
      const block = await miner.cpu.mineBlock(entry);
      assert.ok(await chain.add(block));
      await sleep(100);
    }

    assert(chain.height % treeInterval === 1);
    // start mining blocks from other side of tree interval
    const forkPoint = chain.height - 3;

    let prevBlock = await chain.getBlock(forkPoint);
    for (let i = 0; i < 4; i++) {
      const entry = await chain.getEntry(prevBlock.hash());
      prevBlock = await miner.cpu.mineBlock(entry);
      assert.ok(await chain.add(prevBlock));
      await sleep(100);
    }

    assert.equal(reorged, true);
  });

  it('should mine a reorg between intervals with a different treeRoot', async() => {
    let reorged = false;
    node.chain.once('reorganize', () => {
      reorged = true;
    });

    while (chain.height % treeInterval !== 1) {
      const entry = await chain.getEntry(chain.height);
      const block = await miner.cpu.mineBlock(entry);
      assert.ok(await chain.add(block));
      await sleep(100);
    }

    assert(chain.height % treeInterval === 1);
    // start mining blocks from other side of tree interval
    const forkPoint = chain.height - 3;

    let prevBlock = await chain.getBlock(forkPoint);
    for (let i = 0; i < 4; i++) {
      const entry = await chain.getEntry(prevBlock.hash());

      const name = rules.grindName(5, forkPoint, network);
      const mtx = await wallet.sendOpen(name, true, {
        selection: 'age'
      });

      await sleep(100);

      const txid = Buffer.from(mtx.txid(), 'hex');
      assert(mempool.getTX(txid));

      prevBlock = await miner.cpu.mineBlock(entry);

      if (i === 3)
        debugger;

      const res = await chain.add(prevBlock);
      assert(res);

      //assert.ok(await chain.add(prevBlock));
      await sleep(100);
    }

    assert.equal(reorged, true);
  });
});

// need mineBlocks

function sleep(time) {
  return new Promise(resolve => setTimeout(resolve, time));
}

function treeIntervals(height) {
  const pre = height - (height % treeInterval);
  const post = height + (treeInterval - (height % treeInterval));

  return [pre, post];
}
