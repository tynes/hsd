/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */
/* eslint no-return-assign: "off" */

'use strict';

const {NodeClient, WalletClient} = require('hs-client');
const Network = require('../lib/protocol/network');
const FullNode = require('../lib/node/fullnode');
const MTX = require('../lib/primitives/mtx');
const Resource = require('../lib/dns/resource');
const rules = require('../lib/covenants/rules');
const {types} = rules;

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
  });

  it('should mine to the secondary/default wallet', async () => {
    const {address} = await wallet2.createAddress('default');
    for (let i = 0; i < 5; i++)
      await nclient.execute('generatetoaddress', [1, address]);

    assert.ok(true);
  });

  it('should have no name state indexed', async () => {
    const names = await wclient.get(`/wallet/${wallet.id}/names`);

    assert.equal(names.length, 0);
  });

  it('should create an open and broadcast the transaction', async () => {
    const json = await wclient.post(`/wallet/${wallet.id}/open`, {
      name: name
    });

    let entered = false;
    node.mempool.on('tx', () => entered = true);

    await sleep(100);

    assert.equal(entered, true);
    const mempool = await nclient.getMempool();

    assert.ok(mempool.includes(json.hash));

    const mtx = MTX.fromJSON(json);

    const opens = mtx.outputs.filter(output => output.covenant.type === types.OPEN);
    assert.equal(opens.length, 1);
  });

  it('should create an open and not broadcast the transaction', async () => {
    const json = await wclient.post(`/wallet/${wallet.id}/open`, {
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

    const tx = mtx.toTX();

    // tx is valid
    assert.ok(tx.verify(mtx.view));

    const opens = tx.outputs.filter(output => output.covenant.type === types.OPEN);
    assert.equal(opens.length, 1);
  });

  it('should create an open and not sign the transaction', async () => {
    const json = await wclient.post(`/wallet/${wallet.id}/open`, {
      name: name,
      broadcast: false,
      sign: false
    });

    let entered = false;
    node.mempool.on('tx', () => entered = true);

    await sleep(100);

    assert.equal(entered, false);

    const mtx = MTX.fromJSON(json);

    assert.equal(mtx.verify(), false);
  });

  it('should throw error with incompatible broadcast and sign options', async () => {
    const fn = async () => await (wclient.post(`/wallet/${wallet.id}/open`, {
      name: name,
      broadcast: true,
      sign: false
    }));

    assert.rejects(fn, 'Must sign when broadcasting');
  });

  it('should fail to create open for empty account', async () => {
    const info = await wallet.getAccount(accountTwo);
    assert.equal(info.balance.tx, 0);
    assert.equal(info.balance.coin, 0);

    const fn = async () => (await wclient.post(`/wallet/${wallet.id}/open`, {
      name: name,
      account: accountTwo
    }));

    assert.rejects(fn);
  });

  it('should mine to the empty account', async () => {
    const height = 5;

    const {receiveAddress} = await wallet.getAccount(accountTwo);

    for (let i = 0; i < height; i++)
      await nclient.execute('generatetoaddress', [1, receiveAddress]);

    const info = await wallet.getAccount(accountTwo);
    assert.ok(info.balance.tx, height);
    assert.ok(info.balance.coin, height);
  });

  it('should create open for specific account', async () => {
    const json = await wclient.post(`/wallet/${wallet.id}/open`, {
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
    await wclient.post(`/wallet/${wallet.id}/open`, {
      name: name
    });

    // save chain height for later comparison
    const info = await nclient.getInfo();

    const {treeInterval} = network.names;
    for (let i = 0; i < treeInterval + 1; i++)
      await nclient.execute('generatetoaddress', [1, cbAddress]);

    await sleep(100);

    const json = await wclient.post(`/wallet/${wallet.id}/bid`, {
      name: name,
      bid: 1000,
      lockup: 2000,
      debug: true
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

  it('should get name info', async () => {
    const names = await wclient.get(`/wallet/${wallet.id}/names`);

    assert(names.length > 0);
    const [ns] = names;

    const nameInfo = await wclient.get(`/wallet/${wallet.id}/name`, { name: ns.name });

    assert.deepEqual(ns, nameInfo);
  });

  it('should fail to open a bid without a bid value', async () => {
    const fn = async () => (await wclient.post(`/wallet/${wallet.id}/bid`, {
      name: name
    }));

    assert.rejects(fn);
  });

  it('should fail to open a bid without a lockup value', async () => {
    const fn = async () => (await wclient.post(`/wallet/${wallet.id}/bid`, {
      name: name,
      bid: 1000
    }));

    assert.rejects(fn);
  });

  it('should create a reveal', async () => {
    await wclient.post(`/wallet/${wallet.id}/open`, {
      name: name
    });

    const {treeInterval} = network.names;
    for (let i = 0; i < treeInterval + 1; i++)
      await nclient.execute('generatetoaddress', [1, cbAddress]);

    await sleep(100);

    await wclient.post(`/wallet/${wallet.id}/bid`, {
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

    const json = await wclient.post(`/wallet/${wallet.id}/reveal`, {
      name: name
    });

    const reveals = json.outputs.filter(output => output.covenant.type === types.REVEAL);
    assert.equal(reveals.length, 1);
  });

  it('should get auction info', async () => {
    const names = await wclient.get(`/wallet/${wallet.id}/names`);

    assert(names.length > 0);
    const [,ns] = names;

    const auction = await wclient.get(`/wallet/${wallet.id}/auction`, { name: ns.name });

    // auction info returns a list of bids
    // and a list of reveals for the name
    assert.ok(auction.bids);
    assert.ok(auction.reveals);
  });

  it('should create a redeem', async () => {
    await wclient.post(`/wallet/${wallet.id}/open`, {
      name: name
    });

    const {treeInterval} = network.names;
    for (let i = 0; i < treeInterval + 1; i++)
      await nclient.execute('generatetoaddress', [1, cbAddress]);

    await sleep(100);

    await wclient.post(`/wallet/${wallet.id}/bid`, {
      name: name,
      bid: 1000,
      lockup: 2000
    });

    // wallet2 wins the auction, wallet can submit redeem
    await wclient.post(`/wallet/${wallet.id}/bid`, {
      name: name,
      bid: 1000,
      lockup: 2000
    });

    await wclient.post(`/wallet/${wallet2.id}/bid`, {
      name: name,
      bid: 2000,
      lockup: 3000
    });

    const {biddingPeriod} = network.names;
    for (let i = 0; i < biddingPeriod + 1; i++)
      await nclient.execute('generatetoaddress', [1, cbAddress]);

    await sleep(100);

    await wclient.post(`/wallet/${wallet.id}/reveal`, {
      name: name
    });

    await wclient.post(`/wallet/${wallet2.id}/reveal`, {
      name: name
    });

    const {revealPeriod} = network.names;
    for (let i = 0; i < revealPeriod + 1; i++)
      await nclient.execute('generatetoaddress', [1, cbAddress]);

    const json = await wclient.post(`/wallet/${wallet.id}/redeem`, {
      name: name
    });

    const redeem = json.outputs.filter(({covenant}) => covenant.type === types.REDEEM);
    assert.ok(redeem.length > 0);
  });

  it('should create an update', async () => {
    await wclient.post(`/wallet/${wallet.id}/open`, {
      name: name
    });

    const {treeInterval} = network.names;
    for (let i = 0; i < treeInterval + 1; i++)
      await nclient.execute('generatetoaddress', [1, cbAddress]);

    await sleep(100);

    await wclient.post(`/wallet/${wallet.id}/bid`, {
      name: name,
      bid: 1000,
      lockup: 2000
    });

    const {biddingPeriod} = network.names;
    for (let i = 0; i < biddingPeriod + 1; i++)
      await nclient.execute('generatetoaddress', [1, cbAddress]);

    await sleep(100);

    await wclient.post(`/wallet/${wallet.id}/reveal`, {
      name: name
    });

    const {revealPeriod} = network.names;
    for (let i = 0; i < revealPeriod + 1; i++)
      await nclient.execute('generatetoaddress', [1, cbAddress]);

    await sleep(100);

    {
      const json = await wclient.post(`/wallet/${wallet.id}/update`, {
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
      const json = await wclient.post(`/wallet/${wallet.id}/update`, {
        name: name,
        data: {
          text: ['foobar']
        }
      });

      // update after register or update
      const updates = json.outputs.filter(({covenant}) => covenant.type === types.UPDATE);
      assert.equal(updates.length, 1);
    }
  });

  it('should get name resource', async () => {
    const names = await wclient.get(`/wallet/${wallet.id}/names`);
    // filter out to names that have data
    // this test depends on the previous test
    const [ns] = names.filter(n => n.data.length > 0);
    assert(ns);

    const state = Resource.decode(Buffer.from(ns.data, 'hex'));

    const resource = await wclient.get(`/wallet/${wallet.id}/resource`, { name: ns.name });
    const res = Resource.fromJSON(resource);

    assert.deepEqual(state, res);
  });

  it('should create a renewal', async () => {
    await wclient.post(`/wallet/${wallet.id}/open`, {
      name: name
    });

    const {treeInterval} = network.names;
    for (let i = 0; i < treeInterval + 1; i++)
      await nclient.execute('generatetoaddress', [1, cbAddress]);

    await sleep(100);

    await wclient.post(`/wallet/${wallet.id}/bid`, {
      name: name,
      bid: 1000,
      lockup: 2000
    });

    const {biddingPeriod} = network.names;
    for (let i = 0; i < biddingPeriod + 1; i++)
      await nclient.execute('generatetoaddress', [1, cbAddress]);

    await sleep(100);

    await wclient.post(`/wallet/${wallet.id}/reveal`, {
      name: name
    });

    const {revealPeriod} = network.names;
    for (let i = 0; i < revealPeriod + 1; i++)
      await nclient.execute('generatetoaddress', [1, cbAddress]);

    await sleep(100);

    await wclient.post(`/wallet/${wallet.id}/update`, {
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

    const json = await wclient.post(`/wallet/${wallet.id}/renewal`, {
      name
    });

    const updates = json.outputs.filter(({covenant}) => covenant.type === types.RENEW);
    assert.equal(updates.length, 1);
  });

  it('should create a transfer', async () => {
    await wclient.post(`/wallet/${wallet.id}/open`, {
      name: name
    });

    const {treeInterval} = network.names;
    for (let i = 0; i < treeInterval + 1; i++)
      await nclient.execute('generatetoaddress', [1, cbAddress]);

    await sleep(100);

    await wclient.post(`/wallet/${wallet.id}/bid`, {
      name: name,
      bid: 1000,
      lockup: 2000
    });

    const {biddingPeriod} = network.names;
    for (let i = 0; i < biddingPeriod + 1; i++)
      await nclient.execute('generatetoaddress', [1, cbAddress]);

    await sleep(100);

    await wclient.post(`/wallet/${wallet.id}/reveal`, {
      name: name
    });

    const {revealPeriod} = network.names;
    for (let i = 0; i < revealPeriod + 1; i++)
      await nclient.execute('generatetoaddress', [1, cbAddress]);

    await sleep(100);

    await wclient.post(`/wallet/${wallet.id}/update`, {
      name: name,
      data: {
        text: ['foobar']
      }
    });

    for (let i = 0; i < treeInterval + 1; i++)
      await nclient.execute('generatetoaddress', [1, cbAddress]);
    await sleep(100);

    const {receiveAddress} = await wallet.getAccount(accountTwo);

    const json = await wclient.post(`/wallet/${wallet.id}/transfer`, {
      name,
      address: receiveAddress
    });

    const xfer = json.outputs.filter(({covenant}) => covenant.type === types.TRANSFER);
    assert.equal(xfer.length, 1);
  });
});

async function sleep(time) {
  return new Promise(resolve => setTimeout(resolve, time));
}

