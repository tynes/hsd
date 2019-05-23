/*!
 * test/wallet-http.js - test for wallet http endoints
 * Copyright (c) 2019, Mark Tyneway (MIT License).
 * https://github.com/handshake-org/hsd
 */

/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */
/* eslint no-return-assign: "off" */

'use strict';

const {NodeClient, WalletClient} = require('hs-client');
const Network = require('../lib/protocol/network');
const FullNode = require('../lib/node/fullnode');
const MTX = require('../lib/primitives/mtx');
const {isSignatureEncoding, isKeyEncoding} = require('../lib/script/common');
const Resource = require('../lib/dns/resource');
const Address = require('../lib/primitives/address');
const Output = require('../lib/primitives/output');
const rules = require('../lib/covenants/rules');
const {types} = rules;
const secp256k1 = require('bcrypto/lib/secp256k1');
const network = Network.get('regtest');
const assert = require('bsert');

const node = new FullNode({
  network: 'regtest',
  apiKey: 'foo',
  walletAuth: true,
  memory: true,
  workers: true,
  plugins: [require('../lib/wallet/plugin')]
});

const nclient = new NodeClient({
  port: network.rpcPort,
  apiKey: 'foo'
});

const wclient = new WalletClient({
  port: network.walletPort,
  apiKey: 'foo'
});

const wallet = wclient.wallet('primary');
const wallet2 = wclient.wallet('secondary');

let name, cbAddress;
const accountTwo = 'foobar';

describe('Wallet HTTP', function() {
  this.timeout(15000);

  before(async () => {
    await node.open();
    await nclient.open();
    await wclient.open();

    await wclient.createWallet('secondary');
    cbAddress = (await wallet.createAddress('default')).address;
    await wallet.createAccount(accountTwo);
  });

  after(async () => {
    await nclient.close();
    await wclient.close();
    await node.close();
  });

  beforeEach(async () => {
    name = await nclient.execute('grindname', [5]);
  });

  afterEach(async () => {
    await node.mempool.reset();
  });

  it('should mine to the primary/default wallet', async () => {
    const height = 20;

    for (let i = 0; i < height; i++)
      await nclient.execute('generatetoaddress', [1, cbAddress]);

    const info = await nclient.getInfo();
    assert.equal(info.chain.height, height);

    const accountInfo = await wallet.getAccount('default');
    // each coinbase output was indexed
    assert.equal(accountInfo.balance.coin, height);
  });

  it('should create a transaction', async () => {
    const tx = await wallet.createTX({
      outputs: [{ address: cbAddress, value: 1e4 }]
    });

    assert.ok(tx);
    assert.equal(tx.outputs.length, 1 + 1); // send + change
    assert.equal(tx.locktime, 0);
  });

  it('should create a transaction with a locktime', async () => {
    const locktime = 8e6;

    const tx = await wallet.createTX({
      locktime: locktime,
      outputs: [{ address: cbAddress, value: 1e4 }]
    });

    assert.equal(tx.locktime, locktime);
  });

  it('should create a transaction that is not bip 69 sorted', async () => {
    // create a list of outputs that descend in value
    // bip 69 sorts in ascending order based on the value
    const outputs = [];
    for (let i = 0; i < 5; i++) {
      const addr = await wallet.createAddress('default');
      outputs.push({ address: addr.address, value: (5 - i) * 1e5 });
    }

    const tx = await wallet.createTX({
      outputs: outputs,
      sort: false
    });

    // assert outputs in the same order that they were sent from the client
    for (const [i, output] of outputs.entries()) {
      assert.equal(tx.outputs[i].value, output.value);
      assert.equal(tx.outputs[i].address.toString(network), output.address);
    }

    const mtx = MTX.fromJSON(tx);
    mtx.sortMembers();

    // the order changes after sorting
    assert.ok(tx.outputs[0].value !== mtx.outputs[0].value);
  });

  it('should create a transaction that is bip 69 sorted', async () => {
    const outputs = [];
    for (let i = 0; i < 5; i++) {
      const addr = await wallet.createAddress('default');
      outputs.push({ address: addr.address, value: (5 - i) * 1e5 });
    }

    const tx = await wallet.createTX({
      outputs: outputs
    });

    const mtx = MTX.fromJSON(tx);
    mtx.sortMembers();

    // assert the ordering of the outputs is the
    // same after sorting the response client side
    for (const [i, output] of tx.outputs.entries()) {
      assert.equal(output.value, mtx.outputs[i].value);
      assert.equal(output.address, mtx.outputs[i].address.toString(network));
    }
  }

  it('should mine to the secondary/default wallet', async () => {
    const height = 5;

    const {address} = await wallet2.createAddress('default');
    for (let i = 0; i < height; i++)
      await nclient.execute('generatetoaddress', [1, address]);

    await sleep(100);

    const accountInfo = await wallet2.getAccount('default');
    assert.equal(accountInfo.balance.coin, height);
  });

  it('should have no name state indexed', async () => {
    const names = await wallet.getNames();

    assert.strictEqual(names.length, 0);
  });

  it('should allow covenants with create tx', async () => {
    const {address} = await wallet.createChange('default');

    const nameHash = rules.hashName(name);
    const rawName = Buffer.from(name, 'ascii');

    const output = new Output();
    output.address = Address.fromString(address);
    output.value = 0;
    output.covenant.type = types.OPEN;
    output.covenant.pushHash(nameHash);
    output.covenant.pushU32(0);
    output.covenant.push(rawName);

    const mtx = new MTX();
    mtx.outputs.push(output);

    const tx = await wallet.createTX(mtx);
    assert.equal(tx.outputs[0].covenant.type, types.OPEN);
  });

  it('should allow covenants with send tx', async () => {
    const {address} = await wallet.createChange('default');

    const nameHash = rules.hashName(name);
    const rawName = Buffer.from(name, 'ascii');

    const output = new Output();
    output.address = Address.fromString(address);
    output.value = 0;
    output.covenant.type = types.OPEN;
    output.covenant.pushHash(nameHash);
    output.covenant.pushU32(0);
    output.covenant.push(rawName);

    const mtx = new MTX();
    mtx.outputs.push(output);

    const tx = await wallet.send(mtx);
    assert.equal(tx.outputs[0].covenant.type, types.OPEN);
  });

  it('should create an open and broadcast the tx', async () => {
    const json = await wallet.createOpen({
      name: name
    });

    let entered = false;
    node.mempool.on('tx', () => entered = true);

    await sleep(100);

    assert.equal(entered, true);
    const mempool = await nclient.getMempool();

    assert.ok(mempool.includes(json.hash));

    const opens = json.outputs.filter(output => output.covenant.type === types.OPEN);
    assert.equal(opens.length, 1);
  });

  it('should create an open and not broadcast the transaction', async () => {
    const json = await wallet.createOpen({
      name: name,
      broadcast: false
    });

    let entered = false;
    node.mempool.on('tx', () => entered = true);

    await sleep(100);

    // tx is not in the mempool
    assert.equal(entered, false);

    const mtx = MTX.fromJSON(json);
    assert.ok(mtx.hasWitness());

    const sig = mtx.inputs[0].witness.get(0);
    assert.ok(isSignatureEncoding(sig));
    const pubkey = mtx.inputs[0].witness.get(1);
    assert.ok(isKeyEncoding(pubkey));
    assert.ok(secp256k1.publicKeyVerify(pubkey));

    // transaction is valid
    assert.ok(mtx.verify());

    const opens = mtx.outputs.filter(output => output.covenant.type === types.OPEN);
    assert.equal(opens.length, 1);
  });

  it('should create an open and not sign the transaction', async () => {
    const json = await wallet.createOpen({
      name: name,
      broadcast: false,
      sign: false
    });

    let entered = false;
    node.mempool.on('tx', () => entered = true);

    await sleep(100);

    assert.equal(entered, false);

    const mtx = MTX.fromJSON(json);
    const sig = mtx.inputs[0].witness.get(0);
    assert.bufferEqual(Buffer.from(''), sig);
    assert.ok(!isSignatureEncoding(sig));

    const pubkey = mtx.inputs[0].witness.get(1);
    assert.ok(isKeyEncoding(pubkey));
    assert.ok(secp256k1.publicKeyVerify(pubkey));

    assert.equal(mtx.verify(), false);
  });

  it('should throw error with incompatible broadcast and sign options', async () => {
    const fn = async () => await (wallet.createOpen({
      name: name,
      broadcast: true,
      sign: false
    }));

    assert.rejects(fn, 'Must sign when broadcasting.');
  });

  it('should fail to create open for account with no monies', async () => {
    const info = await wallet.getAccount(accountTwo);
    assert.equal(info.balance.tx, 0);
    assert.equal(info.balance.coin, 0);

    const fn = async () => (await wallet.createOpen({
      name: name,
      account: accountTwo
    }));

    assert.rejects(fn, 'Not enough funds.');
  });

  it('should mine to the account with no monies', async () => {
    const height = 5;

    const {receiveAddress} = await wallet.getAccount(accountTwo);

    for (let i = 0; i < height; i++)
      await nclient.execute('generatetoaddress', [1, receiveAddress]);

    await sleep(100);

    const info = await wallet.getAccount(accountTwo);
    assert.equal(info.balance.tx, height);
    assert.equal(info.balance.coin, height);
  });

  it('should create open for specific account', async () => {
    const json = await wallet.createOpen({
      name: name,
      account: accountTwo
    });

    const info = await wallet.getAccount(accountTwo);

    // assert that each of the inputs belongs to the account
    for (const {address} of json.inputs) {
      const keyInfo = await wallet.getKey(address);
      assert.equal(keyInfo.name, info.name);
    }
  });

  it('should open a bid', async () => {
    await wallet.createOpen({
      name: name
    });

    // save chain height for later comparison
    const info = await nclient.getInfo();

    const {treeInterval} = network.names;
    for (let i = 0; i < treeInterval + 1; i++)
      await nclient.execute('generatetoaddress', [1, cbAddress]);

    await sleep(100);

    const json = await wallet.createBid({
      name: name,
      bid: 1000,
      lockup: 2000
    });

    const bids = json.outputs.filter(output => output.covenant.type === types.BID);
    assert.equal(bids.length, 1);

    const [bid] = bids;
    assert.equal(bid.covenant.items.length, 4);

    const [nameHash, start, rawName, blind] = bid.covenant.items;
    assert.equal(nameHash, rules.hashName(name).toString('hex'));

    // initially opened in the first block mined, so chain.height + 1
    const hex = Buffer.from(start, 'hex').reverse().toString('hex');
    assert.equal(parseInt(hex, 16), info.chain.height + 1);

    assert.equal(rawName, Buffer.from(name, 'ascii').toString('hex'));

    // blind is type string, so 32 * 2
    assert.equal(blind.length, 32 * 2);
  });

  it('should be able to get nonce', async () => {
    const bid = 100;

    const response = await wallet.getNonce(name, {
      address: cbAddress,
      bid: bid
    });

    const address = Address.fromString(cbAddress, this.network);
    const nameHash = rules.hashName(name);

    const primary = node.plugins.walletdb.wdb.primary;
    const nonce = await primary.generateNonce(nameHash, address, bid);
    const blind = rules.blind(bid, nonce);

    assert.deepStrictEqual(response, {
      blind: blind.toString('hex'),
      nonce: nonce.toString('hex'),
      bid: bid,
      name: name,
      nameHash: nameHash.toString('hex')
    });
  });

  it('should get name info', async () => {
    const names = await wallet.getNames();

    assert(names.length > 0);
    const [ns] = names;

    const nameInfo = await wallet.getName(ns.name);

    assert.deepEqual(ns, nameInfo);
  });

  it('should fail to open a bid without a bid value', async () => {
    const fn = async () => (await wallet.createBid({
      name: name
    }));

    assert.rejects(fn, 'Bid is required.');
  });

  it('should fail to open a bid without a lockup value', async () => {
    const fn = async () => (await wallet.createBid({
      name: name,
      bid: 1000
    }));

    assert.rejects(fn, 'Lockup is required.');
  });

  it('should create a reveal', async () => {
    await wallet.createOpen({
      name: name
    });

    const {treeInterval} = network.names;
    for (let i = 0; i < treeInterval + 1; i++)
      await nclient.execute('generatetoaddress', [1, cbAddress]);

    await sleep(100);

    await wallet.createBid({
      name: name,
      bid: 1000,
      lockup: 2000
    });

    const {biddingPeriod} = network.names;
    for (let i = 0; i < biddingPeriod + 1; i++)
      await nclient.execute('generatetoaddress', [1, cbAddress]);

    await sleep(100);

    const {info} = await nclient.execute('getnameinfo', [name]);
    assert.equal(info.name, name);
    assert.equal(info.state, 'REVEAL');

    const json = await wallet.createReveal({
      name: name
    });

    const reveals = json.outputs.filter(output => output.covenant.type === types.REVEAL);
    assert.equal(reveals.length, 1);
  });

  it('should get auction info', async () => {
    const names = await wallet.getNames();

    await sleep(100);

    assert(names.length > 0);
    const [,ns] = names;

    const auction = await wallet.getAuction(ns.name);

    // auction info returns a list of bids
    // and a list of reveals for the name
    assert.ok(auction.bids);
    assert.ok(auction.reveals);
  });

  it('should create a redeem', async () => {
    await wallet.createOpen({
      name: name
    });

    const {treeInterval} = network.names;
    for (let i = 0; i < treeInterval + 1; i++)
      await nclient.execute('generatetoaddress', [1, cbAddress]);

    await sleep(100);

    // wallet2 wins the auction, wallet can submit redeem
    await wallet.createBid({
      name: name,
      bid: 1000,
      lockup: 2000
    });

    await wallet2.createBid({
      name: name,
      bid: 2000,
      lockup: 3000
    });

    await sleep(100);

    const {biddingPeriod} = network.names;
    for (let i = 0; i < biddingPeriod + 1; i++)
      await nclient.execute('generatetoaddress', [1, cbAddress]);

    await sleep(100);

    await wallet.createReveal({
      name: name
    });

    await wallet2.createReveal({
      name: name
    });

    const {revealPeriod} = network.names;
    for (let i = 0; i < revealPeriod + 1; i++)
      await nclient.execute('generatetoaddress', [1, cbAddress]);

    await sleep(100);

    // wallet2 is the winner, therefore cannot redeem
    const fn = async () => (await wallet2.createRedeem({
      name: name
    }));

    assert.rejects(fn, 'No reveals to redeem.');

    const json = await wallet.createRedeem({
      name: name
    });

    const redeem = json.outputs.filter(({covenant}) => covenant.type === types.REDEEM);
    assert.ok(redeem.length > 0);
  });

  it('should create an update', async () => {
    await wallet.createOpen({
      name: name
    });

    const {treeInterval} = network.names;
    for (let i = 0; i < treeInterval + 1; i++)
      await nclient.execute('generatetoaddress', [1, cbAddress]);

    await sleep(100);

    await wallet.createBid({
      name: name,
      bid: 1000,
      lockup: 2000
    });

    const {biddingPeriod} = network.names;
    for (let i = 0; i < biddingPeriod + 1; i++)
      await nclient.execute('generatetoaddress', [1, cbAddress]);

    await sleep(100);

    await wallet.createReveal({
      name: name
    });

    const {revealPeriod} = network.names;
    for (let i = 0; i < revealPeriod + 1; i++)
      await nclient.execute('generatetoaddress', [1, cbAddress]);

    await sleep(100);

    {
      const json = await wallet.createUpdate({
        name: name,
        data: {
          text: ['foobar']
        }
      });

      // register directly after reveal
      const registers = json.outputs.filter(({covenant}) => covenant.type === types.REGISTER);
      assert.equal(registers.length, 1);
    }

    // mine a block
    await nclient.execute('generatetoaddress', [1, cbAddress]);

    await sleep(100);

    {
      const json = await wallet.createUpdate({
        name: name,
        data: {
          text: ['barfoo']
        }
      });

      // update after register or update
      const updates = json.outputs.filter(({covenant}) => covenant.type === types.UPDATE);
      assert.equal(updates.length, 1);
    }
  });

  it('should get name resource', async () => {
    const names = await wallet.getNames();
    // filter out names that have data
    // this test depends on the previous test
    const [ns] = names.filter(n => n.data.length > 0);
    assert(ns);

    const state = Resource.decode(Buffer.from(ns.data, 'hex'));

    const resource = await wallet.getResource(ns.name);
    const res = Resource.fromJSON(resource);

    assert.deepEqual(state, res);
  });

  it('should fail to get name resource for non existent name', async () => {
    const name = await nclient.execute('grindname', [10]);

    const resource = await wallet.getResource(name);
    assert.equal(resource, null);
  });

  it('should create a renewal', async () => {
    await wallet.createOpen({
      name: name
    });

    const {treeInterval} = network.names;
    for (let i = 0; i < treeInterval + 1; i++)
      await nclient.execute('generatetoaddress', [1, cbAddress]);

    await sleep(100);

    await wallet.createBid({
      name: name,
      bid: 1000,
      lockup: 2000
    });

    const {biddingPeriod} = network.names;
    for (let i = 0; i < biddingPeriod + 1; i++)
      await nclient.execute('generatetoaddress', [1, cbAddress]);

    await sleep(100);

    await wallet.createReveal({
      name: name
    });

    const {revealPeriod} = network.names;
    for (let i = 0; i < revealPeriod + 1; i++)
      await nclient.execute('generatetoaddress', [1, cbAddress]);

    await sleep(100);

    await wallet.createUpdate({
      name: name,
      data: {
        text: ['foobar']
      }
    });

    // mine up to the earliest point in which a renewal
    // can be submitted, a treeInterval into the future
    for (let i = 0; i < treeInterval + 1; i++)
      await nclient.execute('generatetoaddress', [1, cbAddress]);

    await sleep(100);

    const json = await wallet.createRenewal({
      name
    });

    const updates = json.outputs.filter(({covenant}) => covenant.type === types.RENEW);
    assert.equal(updates.length, 1);
  });

  it('should create a transfer', async () => {
    await wallet.createOpen({
      name: name
    });

    const {treeInterval} = network.names;
    for (let i = 0; i < treeInterval + 1; i++)
      await nclient.execute('generatetoaddress', [1, cbAddress]);

    await sleep(100);

    await wallet.createBid({
      name: name,
      bid: 1000,
      lockup: 2000
    });

    const {biddingPeriod} = network.names;
    for (let i = 0; i < biddingPeriod + 1; i++)
      await nclient.execute('generatetoaddress', [1, cbAddress]);

    await sleep(100);

    await wallet.createReveal({
      name: name
    });

    const {revealPeriod} = network.names;
    for (let i = 0; i < revealPeriod + 1; i++)
      await nclient.execute('generatetoaddress', [1, cbAddress]);

    await sleep(100);

    await wallet.createUpdate({
      name: name,
      data: {
        text: ['foobar']
      }
    });

    for (let i = 0; i < treeInterval + 1; i++)
      await nclient.execute('generatetoaddress', [1, cbAddress]);

    await sleep(100);

    const {receiveAddress} = await wallet.getAccount(accountTwo);

    const json = await wallet.createTransfer({
      name,
      address: receiveAddress
    });

    const xfer = json.outputs.filter(({covenant}) => covenant.type === types.TRANSFER);
    assert.equal(xfer.length, 1);
  });

  it('should create a finalize', async () => {
    await wallet.createOpen({
      name: name
    });

    const {treeInterval} = network.names;
    for (let i = 0; i < treeInterval + 1; i++)
      await nclient.execute('generatetoaddress', [1, cbAddress]);

    await sleep(100);

    await wallet.createBid({
      name: name,
      bid: 1000,
      lockup: 2000
    });

    const {biddingPeriod} = network.names;
    for (let i = 0; i < biddingPeriod + 1; i++)
      await nclient.execute('generatetoaddress', [1, cbAddress]);

    await sleep(100);

    await wallet.createReveal({
      name: name
    });

    const {revealPeriod} = network.names;
    for (let i = 0; i < revealPeriod + 1; i++)
      await nclient.execute('generatetoaddress', [1, cbAddress]);

    await sleep(100);

    await wallet.createUpdate({
      name: name,
      data: {
        text: ['foobar']
      }
    });

    for (let i = 0; i < treeInterval + 1; i++)
      await nclient.execute('generatetoaddress', [1, cbAddress]);

    await sleep(100);

    const {receiveAddress} = await wallet.getAccount(accountTwo);

    await wallet.createTransfer({
      name,
      address: receiveAddress
    });

    const {transferLockup} = network.names;
    for (let i = 0; i < transferLockup + 1; i++)
      await nclient.execute('generatetoaddress', [1, cbAddress]);

    const json = await wallet.createFinalize({
      name
    });

    const final = json.outputs.filter(({covenant}) => covenant.type === types.FINALIZE);
    assert.equal(final.length, 1);

    await nclient.execute('generatetoaddress', [1, cbAddress]);

    const ns = await nclient.execute('getnameinfo', [name]);
    const coin = await nclient.getCoin(ns.info.owner.hash, ns.info.owner.index);

    assert.equal(coin.address, receiveAddress);
  });
});

async function sleep(time) {
  return new Promise(resolve => setTimeout(resolve, time));
}

