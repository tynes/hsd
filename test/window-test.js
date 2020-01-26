/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

const assert = require('bsert');
const SlidingWindow = require('../lib/net/window');
const FullNode = require('../lib/node/fullnode');
const NetAddress = require('../lib/net/netaddress');
const rules = require('../lib/covenants/rules');
const base32 = require('bs32');
const common = require('./util/common');

async function sleep(time) {
  return new Promise(resolve => setTimeout(resolve, time));
}

describe('SlidingWindow (Unit)', function() {
  this.skip();

  const window = new SlidingWindow({
    window: 10,
    limit: 100
  });

  beforeEach(() => {
    window.start();
  });

  afterEach(() => {
    window.stop();
  });

  it('should process max requests in window', async () => {
    for (let i=0; i < window.limit-1; i++)
      window.increase(1);

    assert.ok(window.allow());
  });

  it('should reject after max requests in window', async () => {
    window.increase(1);
    assert.ok(!window.allow());
  });

  it('should reset after window timeout', async () => {
    let reset = false;

    window.once('reset', () => {
      reset = true;
    });

    await sleep(window.window);
    assert.ok(reset === true);
  });
});

describe('SlidingWindow (Functional)', function() {
  it('should connect and ban', async () => {
    const one = new FullNode({
      memory: true,
      network: 'regtest',
      'max-proof-rps': 5,
      listen: true,
      host: '127.0.1.1',
      'http-host': '127.0.1.1',
      'rs-host': '127.0.1.1',
      'ns-host': '127.0.1.1',
      seeds: []
    });

    //assert.equal(one.pool.options.proofRPS, 20);

    const key = base32.encode(one.pool.hosts.address.key);

    const two = new FullNode({
      memory: true,
      network: 'regtest',
      host: '127.0.0.2',
      'http-host': '127.0.0.2',
      'rs-host': '127.0.0.2',
      'ns-host': '127.0.0.2',
      seeds: [],
      only: [`${key}@127.0.1.1`]
    });

    await one.open();
    await one.connect();

    await two.open();
    await two.connect();

    await common.event(one.pool, 'peer open');

    assert.equal(one.pool.peers.size(), 1);
    assert.equal(one.pool.peers.inbound, 1);
    assert.equal(two.pool.peers.size(), 1);
    assert.equal(two.pool.peers.outbound, 1);

    const root = await one.chain.getSafeRoot();
    const hash = rules.hashString('google');

    let seen = false;
    two.pool.on('ban', (peer) => {
      seen = true;
    });

    const peer = two.pool.peers.head();

    let packets = 0;
    one.pool.on('packet', (packet) => {
      if (packet.type === 26)
        packets++;
    });

    let count = 0;
    while (!seen) {
      await peer.sendGetProof(root, hash);
      // Wait until the response was sent back.
      await common.event(two.pool, 'packet');
      //await sleep(1000);
      count++;
    }

    console.log(`Sent: ${count}, Seen: ${packets}`);
    assert(two.pool.hosts.banned.has('127.0.1.1'));

    await one.close();
    await two.close();
  });
});
