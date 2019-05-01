/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */
/* eslint no-return-assign: "off" */

'use strict';

const {NodeClient, WalletClient} = require('hs-client');
const Network = require('../lib/protocol/network');
const FullNode = require('../lib/node/fullnode');
const MTX = require('../lib/primitives/mtx');
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

let name, cbAddress;
const accountTwo = 'foobar';

describe('Wallet HTTP', function() {
  this.timeout(15000);

  before(async () => {
    await node.open();
    await nclient.open();
    await wclient.open();

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

  it('should create an open with multiple outputs', async () => {
    const json = await wclient.post(`/wallet/${wallet.id}/open`, {
      name: name,
      broadcast: false,
      outputs: [
        { address: cbAddress, value: 1e4 },
        { address: cbAddress, value: 1e4 },
        { address: cbAddress, value: 1e4 }
      ]
    });

    const mtx = MTX.fromJSON(json);
    const opens = mtx.outputs.filter(output => output.covenant.type === types.OPEN);
    assert.equal(opens.length, 1);

    const sends = mtx.outputs.filter(output => output.address.toString(network) === cbAddress);
    assert.equal(sends.length, 3);

    // sends + open + change
    assert.equal(mtx.outputs.length, 3 + 1 + 1);

    assert.equal(mtx.verify(), true);
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
});

async function sleep(time) {
  return new Promise(resolve => setTimeout(resolve, time));
}
