/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */
/* eslint no-return-assign: "off" */

'use strict';

const {NodeClient, WalletClient} = require('hs-client');
const AuctionRunner = require('./util/auctionrunner');
const Network = require('../lib/protocol/network');
const FullNode = require('../lib/node/fullnode');

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
const walletTwo = 'foobar';

// instead try to create a completely different wallet
describe('Auction Runner', function() {
  this.timeout(15000);

  before(async () => {
    await node.open();
    await nclient.open();
    await wclient.open();

    cbAddress = (await wallet.createAddress('default')).address;
    await wclient.createWallet(walletTwo);
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

  it('should open an auction', async () => {
    const runner = new AuctionRunner(nclient, wclient, {
      coinbase: cbAddress,
      name: name,
      node: nclient,
      wallet: wclient,
      network: network,
      id: 'primary'
    });

    await runner.doOpen();
    await runner.nextEpoch();

    await sleep(100);
  });

  it('should bid', async () => {
    const runner = new AuctionRunner(nclient, wclient, {
      coinbase: cbAddress,
      name: name,
      node: nclient,
      wallet: wclient,
      network: network,
      id: 'primary'
    });

    await runner.doOpen();
    await runner.nextEpoch();
    await runner.doBid({ bid: 1000, lockup: 2000 });

    const {info} = await nclient.execute('getnameinfo', [name]);
    assert.equal(info.state, 'BIDDING');
  });

  it('should reveal', async () => {
    const runner = new AuctionRunner(nclient, wclient, {
      coinbase: cbAddress,
      name: name,
      node: nclient,
      wallet: wclient,
      network: network,
      id: 'primary'
    });

    await runner.doOpen();
    await runner.nextEpoch();
    await runner.doBid({ bid: 1000, lockup: 2000 });
    await runner.nextPeriod();
    await runner.doReveal();

    await sleep(100);

    const {info} = await nclient.execute('getnameinfo', [name]);
    assert.equal(info.state, 'REVEAL');
  });

  it('should update', async () => {
    const runner = new AuctionRunner(nclient, wclient, {
      coinbase: cbAddress,
      name: name,
      node: nclient,
      wallet: wclient,
      network: network,
      id: 'primary'
    });

    await runner.doOpen();
    await runner.nextEpoch();
    await runner.doBid({ bid: 1000, lockup: 2000 });
    await runner.nextPeriod();
    await runner.doReveal();
    await runner.nextPeriod();
    await runner.doUpdate({ text: ['foobar'] });

    const {info} = await nclient.execute('getnameinfo', [name]);
    assert.equal(info.state, 'CLOSED');
  });

  // potential bug when templating inputs from
  // same wallet but different accounts
  it('should redeem', async () => {
    const r1 = new AuctionRunner(nclient, wclient, {
      coinbase: cbAddress,
      name: name,
      node: nclient,
      wallet: wclient,
      network: network,
      id: 'primary'
    });

    const r2 = new AuctionRunner(nclient, wclient, {
      name: name,
      node: nclient,
      wallet: wclient,
      network: network,
      id: walletTwo
    });
    await r2.setCoinbase();

    await r2.nextEpoch();
    await sleep(100);

    await r1.doOpen();
    await r2.nextEpoch();

    await sleep(100);

    await r1.doBid({ bid: 1000, lockup: 2000 });
    await r2.doBid({ bid: 2000, lockup: 3000 });

    await sleep(100);

    await r2.nextPeriod();
    await sleep(100);

    await r1.doReveal();
    //await r2.doReveal();
    await r2.nextPeriod();

    await sleep(100);
    //await r1.doRedeem();
    await r1.doUpdate({data: {}});

    let coins = await wclient.getCoins('primary', 'default');
    coins = coins.filter(c => c.covenant.action !== 'NONE');
    console.log(coins)

  });

  it('should do renew', async () => {
    this.skip();

    const runner = new AuctionRunner(nclient, wclient, {
      coinbase: cbAddress,
      name: name,
      node: nclient,
      wallet: wclient,
      network: network,
      id: 'primary'
    });

    await runner.doOpen();
    await runner.nextEpoch();

    await runner.doBid({ bid: 1000, lockup: 2000 });
    await runner.nextPeriod();
    await runner.doReveal();
    await runner.nextPeriod();
    await runner.doUpdate({ text: ['foobar'] });
    await runner.nextPeriod();

    await runner.doRenew();
  });
});

async function sleep(time) {
  return new Promise(resolve => setTimeout(resolve, time));
}

