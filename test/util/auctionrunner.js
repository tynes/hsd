/*
 *
 */

'use strict';

const assert = require('bsert');
const rules = require('../../lib/covenants/rules');
const {types} = rules;

class AuctionRunner {
  constructor(node, wallet, options) {
    this.node = node;       // NodeClient
    this.wclient = wallet;  // WalletClient

    this.id = options.id || 'primary';
    this.coinbase = options.coinbase;
    this.name = options.name;
    this.network = options.network;
    this.account = options.account || 'default';
    this.mine = true; // auto mine the tx

    this.wallet = this.wclient.wallet(this.id);   // WalletClient.wallet
  }

  // TODO: set up listners
  // create account if it doesn't exist
  async open() {
    ;
  }

  async setCoinbase() {
    const addr = await this.wallet.createAddress(this.account);
    this.coinbase = addr.address;
  }

  // mine enough blocks until the next time the tree is committed
  async nextEpoch() {
    const {treeInterval} = this.network.names;
    const {coinbase} = this;
    assert(coinbase);

    for (let i = 0; i < treeInterval + 1; i++)
      await this.node.execute('generatetoaddress', [1, coinbase]);
    await sleep(100);
  }

  // mine enough blocks to get to the next auction period
  async nextPeriod() {
    const {name, node, coinbase} = this;
    assert(coinbase);

    const {info} = await this.node.execute('getnameinfo', [name]);
    if (!info)
      throw new Error('need name state.');

    switch (info.state) {
      case 'BIDDING': {
        const {biddingPeriod} = this.network.names;
        for (let i = 0; i < biddingPeriod + 1; i++)
          await this.node.execute('generatetoaddress', [1, coinbase]);
        await sleep(100);
        break;
      }
      case 'REVEAL': {
        const {revealPeriod} = this.network.names;
        for (let i = 0; i < revealPeriod + 1; i++)
          await node.execute('generatetoaddress', [1, coinbase]);
        await sleep(100);
      }
      case 'CLOSED': {
        const {info} = await this.node.execute('getnameinfo', [name]);
        const distance = Math.max(0, info.renewal - info.height);
        for (let i = 0; i < distance; i++)
          await this.node.execute('generatetoaddress', [1, coinbase]);
        await sleep(1000);
      }
      default:
        break;
    }
  }

  async doOpen(name) {
    if (!name)
      name = this.name;

    const {node, wallet, id, account, mine, coinbase} = this;
    assert(name, 'Must pass name.');

    {
      // there is no name state for the name yet
      const nameInfo = await node.execute('getnameinfo', [name]);
      assert.equal(nameInfo.info, null);
    }

    const open = await wallet.client.post(`/wallet/${id}/open`, {
      name: name,
      account: account
    });

    assert.equal(open.outputs[0].covenant.type, types.OPEN);

    if (mine) {
      await node.execute('generatetoaddress', [1, coinbase]);
      await sleep(100);
    }

    {
      // after mining one block, there is an OPENING namestate now
      const nameInfo = await node.execute('getnameinfo', [name]);
      assert.equal(nameInfo.info.state, 'OPENING');
      assert.equal(nameInfo.info.name, name);
    }
  }

  async doBid(options) {
    const {bid, lockup} = options;
    assert(bid, 'Must pass bid.');
    assert(lockup, 'Must pass lockup.');

    const {node, wallet, id, account, name, mine, coinbase} = this;

    {
      const nameInfo = await node.execute('getnameinfo', [name]);
      assert.equal(nameInfo.info.state, 'BIDDING');
      assert.equal(nameInfo.info.name, name);
    }

    await wallet.client.post(`/wallet/${id}/bid`, {
      name: name,
      bid: bid,
      lockup: lockup,
      account: account
    });

    if (mine) {
      await node.execute('generatetoaddress', [1, coinbase]);
      await sleep(100);
    }

    {
      const nameInfo = await node.execute('getnameinfo', [name]);
      assert.equal(nameInfo.info.state, 'BIDDING');
    }
  }

  async doReveal() {
    const {node, wallet, id, account, name, mine, coinbase} = this;

    await wallet.client.post(`/wallet/${id}/reveal`, {
      name: name,
      account: account
    });

    if (mine) {
      await this.node.execute('generatetoaddress', [1, coinbase]);
      await sleep(100);
    }

    {
      const nameInfo = await node.execute('getnameinfo', [name]);
      assert.equal(nameInfo.info.state, 'REVEAL');
    }
  }

  async doUpdate(data) {
    assert(data, 'Must pass data.');
    const {id, wallet, name, account, mine, coinbase} = this;

    await wallet.client.post(`/wallet/${id}/update`, {
      name: name,
      data: data,
      account: account
    });

    if (mine) {
      await this.node.execute('generatetoaddress', [1, coinbase]);
      await sleep(100);
    }
  }

  // TODO: test
  async doRenew() {
    const {name, id, wallet} = this;

    const response = await wallet.client.post(`/wallet/${id}/renew`, {
      name: name
    });

    console.log(response)
  }

  // TODO: test
  async doRedeem() {
    const {name, id, wallet, coinbase, mine} = this;

    const response = await wallet.client.post(`/wallet/${id}/redeem`, {
      name: name
    });

    //console.log(response)
    //console.log(JSON.stringify(response, null, 2))

    if (mine) {
      await this.node.execute('generatetoaddress', [1, coinbase]);
      await sleep(100);
    }
  }
}

async function sleep(time) {
  return new Promise(resolve => setTimeout(resolve, time));
}

module.exports = AuctionRunner;
