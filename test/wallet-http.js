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

describe('Wallet HTTP', function() {
  this.timeout(15000);

  before(async () => {
    await node.open();
    await nclient.open();
    await wclient.open();

    cbAddress = (await wallet.createAddress('default')).address;
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
});

async function sleep(time) {
  return new Promise(resolve => setTimeout(resolve, time));
}
