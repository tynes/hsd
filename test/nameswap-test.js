/*!
 * nameswap-test.js - atomic name swaps for handshake
 * Copyright (c) 2017-2018, Mark Tyneway (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const FullNode = require('../lib/node/fullnode');
const {NodeClient, WalletClient} = require('hs-client');
const Network = require('../lib/protocol/network');
const Mnemonic = require('../lib/hd/mnemonic');
const testCommon = require('./util/common');
const Address = require('../lib/primitives/address');
const Script = require('../lib/script/script');
const Witness = require('../lib/script/witness');
const Opcode = require('../lib/script/opcode');
const MTX = require('../lib/primitives/mtx');
const Coin = require('../lib/primitives/coin');
const KeyRing = require('../lib/primitives/keyring');
const Output = require('../lib/primitives/output');
const Input = require('../lib/primitives/input');
const rules = require('../lib/covenants/rules');
const Covenant = require('../lib/primitives/covenant');
const consensus = require('../lib/protocol/consensus');
const HDPrivateKey = require('../lib/hd/private');
const random = require('bcrypto/lib/random');
const blake2b256 = require('bcrypto/lib/blake2b256');
const Outpoint = require('../lib/primitives/outpoint');

const common = require('../lib/script/common');
const SINGLEREVERSE = common.hashType.SINGLEREVERSE;
const ANYONECANPAY = common.hashType.ANYONECANPAY;

const network = Network.get('regtest');

const mnemonics = require('./data/mnemonic-english.json');
const bobPhrase = mnemonics[0][1];
const bobMnemonic = Mnemonic.fromPhrase(bobPhrase);
const alicePhrase = mnemonics[1][1];
const aliceMnemonic = Mnemonic.fromPhrase(alicePhrase);

const nclient = new NodeClient({
  port: network.rpcPort,
  apiKey: 'foo'
});

const wclient = new WalletClient({
  port: network.walletPort,
  apiKey: 'foo'
});

const node = new FullNode({
  network: 'regtest',
  apiKey: 'foo',
  walletAuth: true,
  memory: true,
  workers: true,
  requireStandard: true,
  plugins: [require('../lib/wallet/plugin')]
});

const {
  treeInterval,
  biddingPeriod,
  revealPeriod,
  transferLockup
} = network.names;

const alice = wclient.wallet('alice');
const bob = wclient.wallet('bob');
let name;

describe('Name Swaps', function() {
  this.timeout(15000);

  before(async () => {
    await node.open();
    await nclient.open();
    await wclient.open();

    name = await nclient.execute('grindname', [5]);
  });

  after(async () => {
    await nclient.close();
    await wclient.close();
    await node.close();
  });

  it('should create alice and bob wallets', async () => {
    const aliceInfo = await wclient.createWallet('alice', {
      mnemonic: aliceMnemonic.toString(),
    });
    assert.equal(aliceInfo.id, 'alice');
    const bobInfo = await wclient.createWallet('bob', {
      mnemonic: bobMnemonic.toString(),
    });
    assert.equal(bobInfo.id, 'bob');
  });

  it('should mine funds to each wallet', async () => {
    {
      const info = await alice.getAccount('default');
      await mineBlocks(5, info.receiveAddress)
    }

    {
      const info = await bob.getAccount('default');
      await mineBlocks(5, info.receiveAddress)
    }

    {
      const info = await alice.getAccount('default');
      assert.equal(info.balance.coin, 5);
    }

    {
      const info = await bob.getAccount('default');
      assert.equal(info.balance.coin, 5);
    }
  });

  it('alice should buy a name', async () => {
    const info = await alice.getAccount('default');
    const address = info.receiveAddress;

    await alice.client.post(`/wallet/${alice.id}/open`, {
      name: name,
    });

    await mineBlocks(treeInterval + 1, address);

    await alice.client.post(`/wallet/${alice.id}/bid`, {
      name: name,
      bid: 1000,
      lockup: 2000
    });

    await mineBlocks(biddingPeriod + 1, address);

    await alice.client.post(`/wallet/${alice.id}/reveal`, {
      name: name,
    });

    await mineBlocks(revealPeriod + 1, address);

    await alice.client.post(`/wallet/${alice.id}/update`, {
      name: name,
      data: {
        text: ['foobar']
      }
    });

    await mineBlocks(treeInterval + 1, address);

    const ns = await alice.client.get(`/wallet/${alice.id}/name/${name}`);
    const coin = await alice.getCoin(ns.owner.hash, ns.owner.index);
    const key = await alice.getKey(coin.address);

    assert(key);
  });

  // hold on to the address for the p2pkh path
  let p2pkhAddr;
  // hold on to preimage
  let preimage, hashlock;
  it('alice should prepare to participate', async () => {
    preimage = random.randomBytes(32);
    hashlock = blake2b256.digest(preimage.slice());

    const info = await alice.getAccount('default');
    p2pkhAddr = Address.fromString(info.receiveAddress);

    const swapscript = Address.fromScript(program(p2pkhAddr.hash, hashlock));

    await alice.client.post(`wallet/${alice.id}/transfer`, {
      name: name,
      address: swapscript.toString(network)
    });

    await mineBlocks(transferLockup, info.changeAddress);

    await alice.client.post(`wallet/${alice.id}/finalize`, {
      name: name
    });

    await mineBlocks(treeInterval, info.changeAddress);

    const ns = await nclient.execute('getnameinfo', [name]);
    const owner = ns.info.owner;

    const coin = await nclient.getCoin(owner.hash, owner.index);
    assert(coin);
    assert.equal(swapscript.toString(network), coin.address);
  });

  /**
   * nameswap tx 1
   *
   * 2 inputs, 2 outputs
   * input 0 - name TRANSFER, SINGLEREVERSE|ANYONECANPAY
   * input 1 - null input, not signed
   *
   * output 0 - null output
   * output 1 - null output (change for counterparty)
   * output 2 - output to self
   *
   * nameswap tx 2
   *
   * 1 input, 1 output
   * input 0 - hash lock
   *
   * output 0 - name FINALIZE
   *
   */

  const swapTXs = {
    transfer: null,
    finalize: null
  };
  it('should create the two swap transactions', async () => {
    // alice gets address to receive coin to
    const aliceInfo = await alice.getAccount('default');
    const receiveAddress = aliceInfo.receiveAddress;

    // need to build and sign manually
    const mtx = new MTX();

    const ns = await nclient.execute('getnameinfo', [name]);
    const owner = ns.info.owner;
    const coinInfo = await nclient.getCoin(owner.hash, owner.index);

    const coin = Coin.fromJSON(coinInfo);

    mtx.addCoin(coin);
    mtx.addCoin(new Coin());

    mtx.addOutput(new Output({
      covenant: {
        type: rules.types.TRANSFER,
        items: []
      }
    }));

    // change
    mtx.addOutput(new Output());

    const output = new Output({
      address: receiveAddress,
      value: 100 * consensus.COIN,
    });

    mtx.addOutput(output);

    const aliceKeyInfo = await alice.getKey(p2pkhAddr.toString(network));
    const pubkey = Buffer.from(aliceKeyInfo.publicKey, 'hex');

    const aliceKey = HDPrivateKey.fromMnemonic(aliceMnemonic)
      .derive(44, true)
      .derive(network.keyPrefix.coinType, true)
      .derive(aliceInfo.accountIndex, true)
      .derive(aliceKeyInfo.branch)
      .derive(aliceKeyInfo.index);

    const aliceKeyring = KeyRing.fromPrivate(aliceKey.privateKey);

    const prgm = program(p2pkhAddr.hash, hashlock);
    const flag = SINGLEREVERSE | ANYONECANPAY;

    const sig = mtx.signature(0, prgm, coin.value, aliceKeyring.privateKey, flag);

    mtx.inputs[0].witness = witness(sig, pubkey, p2pkhAddr.hash, hashlock);

    try {
      mtx.checkInput(0, coin);
    } catch (e) {
      assert(false);
    }

    swapTXs.transfer = mtx;

    // create finalize tx
    const finalize = new MTX();
    finalize.addCoin(new Coin());
    finalize.inputs[0].witness = finalizeWitness(preimage.slice(), p2pkhAddr.hash, hashlock);
    finalize.addOutput(new Output());

    swapTXs.finalize = finalize;
  });

  // hold on to bob's target address
  let bobFinalizeAddr;
  it('should allow bob to broadcast tx1', async () => {
    // fill in transfer
    const transfer = swapTXs.transfer;
    assert(transfer);

    const bobInfo = await bob.getAccount('default');
    const address = Address.fromString(bobInfo.receiveAddress);
    bobFinalizeAddr = address;

    // get the coin that corresponds to the name
    const ns = await nclient.execute('getnameinfo', [name]);
    const owner = ns.info.owner;
    const namecoin = await nclient.getCoin(owner.hash, owner.index);
    assert(namecoin);

    const output = new Output({
      address: namecoin.address,
      value: namecoin.value
    });

    const nameHash = rules.hashName(name);

    const covenant = new Covenant();
    covenant.type = rules.types.TRANSFER;
    covenant.pushHash(nameHash);
    covenant.pushU32(ns.info.height);
    covenant.pushU8(address.version);
    covenant.push(address.hash);

    output.covenant = covenant;

    transfer.outputs[0] = output;

    // assuming bob has coins.
    const bobCoins = await bob.getCoins();
    const coin = Coin.fromJSON(bobCoins[0]);
    const coinjson = coin.toJSON();

    // fee estimation sucks
    const fee = 9e5;
    // change, need to subtract the amount in the final output
    transfer.outputs[1] = new Output({
      address: bobInfo.changeAddress,
      value: coin.value - fee - transfer.outputs[transfer.outputs.length - 1].value
    });

    const bobKeyInfo = await bob.getKey(coin.address.toString(network));

    const input = Input.fromCoin(coin);
    transfer.inputs[1] = input;
    transfer.view.addCoin(coin);

    // sign input at index 1
    const bobKey = HDPrivateKey.fromMnemonic(bobMnemonic)
      .derive(44, true)
      .derive(network.keyPrefix.coinType, true)
      .derive(bobInfo.accountIndex, true)
      .derive(bobKeyInfo.branch)
      .derive(bobKeyInfo.index);

    const bobKeyring = KeyRing.fromPrivate(bobKey.privateKey);

    const prev = Script.fromPubkeyhash(bobKeyring.getHash());
    const sig = transfer.signature(1, prev, coin.value, bobKeyring.privateKey);

    transfer.inputs[1].witness = new Witness([
      sig,
      bobKeyring.publicKey
    ]);

    const valid = transfer.verify();
    assert(valid);

    const txn = transfer.toTX();
    const txid = txn.txid();

    await node.sendTX(transfer.toTX());

    await sleep(100);

    const mempool = await nclient.getMempool()
    assert(mempool.length > 0);
    assert(mempool.includes(txid));

    await mineBlocks(1, bobInfo.receiveAddress);

    const tip = node.chain.tip.height;
    const block = await node.chain.getBlock(tip);

    const txids = [];
    for (const tx of block.txs)
      txids.push(tx.txid());

    // tx is in block
    assert(txids.includes(txid));
  });

  it('should mine through the transfer lockup', async () => {
    const bobInfo = await bob.getAccount('default');
    await mineBlocks(transferLockup, bobInfo.receiveAddress);
    // TODO: assert based on namestate
  });

  it('should allow bob to send the finalize', async () => {
    const finalize = swapTXs.finalize;
    assert(finalize);

    const ns = await nclient.execute('getnameinfo', [name]);
    const owner = ns.info.owner;
    const namecoin = await nclient.getCoin(owner.hash, owner.index);
    assert(namecoin);
    const coin = Coin.fromJSON(namecoin);

    // create input to spend
    const input = Input.fromCoin(coin);
    finalize.view.addCoin(coin);
    input.witness = finalize.inputs[0].witness;

    finalize.inputs[0] = input;

    const info = ns.info;

    // TODO: return bitstring flags in NameState

    const nameHash = Buffer.from(info.nameHash, 'hex');
    const rawName = Buffer.from(info.name, 'ascii');

    const {wdb} = node.require('walletdb');
    // funding with the wallet doesn't work?
    // const wallet = await wdb.get('bob');
    // need to sign locally -_-
    // TODO: make wallet api more flexible
    // for doing interesting types of signing

    const bobInfo = await bob.getAccount('default');

    const renewalBlock = await wdb.getRenewalBlock();

    const covenant = new Covenant();
    covenant.type = rules.types.FINALIZE;
    covenant.pushHash(nameHash);
    covenant.pushU32(info.height);
    covenant.push(rawName);
    covenant.pushU8(0);
    covenant.pushU32(info.claimed);
    covenant.pushU32(info.renewals);
    covenant.pushHash(renewalBlock);

    // set the output, the finalize
    finalize.outputs[0] = new Output({
      address: bobFinalizeAddr,
      value: coin.value,
      covenant: covenant
    });

    // now add fees
    const coins = await bob.getCoins();
    assert(coins.length > 0);
    const change = Coin.fromJSON(coins[0]);
    finalize.addCoin(change);

    finalize.addOutput(new Output({
      // dont actually do fees this way
      value: change.value * 0.9999,
      address: bobInfo.receiveAddress
    }));

    const bobKeyInfo = await bob.getKey(change.address.toString(network));

    // sign input at index 1
    const bobKey = HDPrivateKey.fromMnemonic(bobMnemonic)
      .derive(44, true)
      .derive(network.keyPrefix.coinType, true)
      .derive(bobInfo.accountIndex, true)
      .derive(bobKeyInfo.branch)
      .derive(bobKeyInfo.index);

    const bobKeyring = KeyRing.fromPrivate(bobKey.privateKey);

    const prev = Script.fromPubkeyhash(bobKeyring.getHash());
    const sig = finalize.signature(1, prev, change.value, bobKeyring.privateKey);

    finalize.inputs[1].witness = new Witness([
      sig,
      bobKeyring.publicKey
    ]);

    const valid = finalize.verify();
    assert(valid);

    const txn = finalize.toTX();
    const txid = txn.txid();

    await node.sendTX(txn);

    const mempool = await nclient.getMempool();
    assert(mempool.length > 0);
    assert(mempool.includes(txid));

    const preinfo = await nclient.getInfo();

    await mineBlocks(1, bobInfo.receiveAddress);

    const postinfo = await nclient.getInfo();
    const postmempool = await nclient.getMempool();

    const tip = node.chain.tip.height;
    const block = await node.chain.getBlock(tip);

    const txids = [];
    for (const tx of block.txs)
      txids.push(tx.txid());

    // tx is in block
    assert(txids.includes(txid));
  });

  it('should belong to bob', async () => {
    const ns = await nclient.execute('getnameinfo', [name]);
    const owner = ns.info.owner;
    const namecoin = await nclient.getCoin(owner.hash, owner.index);
    assert(namecoin);
    const coin = Coin.fromJSON(namecoin);

    const keyInfo = await bob.getKey(coin.address.toString(network.type));
    assert(keyInfo);

    const fail = await alice.getKey(coin.address.toString(network.type));

    assert.strictEqual(fail, null);
  });
});

// take into account race conditions
async function mineBlocks(count, address) {
  for (let i = 0; i < count; i++) {
    const obj = { complete: false };
    node.once('block', () => {
      obj.complete = true;
    });
    await nclient.execute('generatetoaddress', [1, address]);
    await testCommon.forValue(obj, 'complete', true);
  }
}

/**
 * Build the program
 *
 */
function program(pubkeyhash, hashlock) {
  assert(Buffer.isBuffer(pubkeyhash));
  assert(Buffer.isBuffer(hashlock));

  const script = new Script([
    Opcode.fromSymbol('type'),
    Opcode.fromInt(rules.types.TRANSFER),
    Opcode.fromSymbol('equal'),
    Opcode.fromSymbol('if'),
    Opcode.fromSymbol('dup'),
    Opcode.fromSymbol('blake160'),
    Opcode.fromPush(pubkeyhash),
    Opcode.fromSymbol('equalverify'),
    Opcode.fromSymbol('checksigverify'),
    Opcode.fromSymbol('endif'),

    Opcode.fromSymbol('type'),
    Opcode.fromInt(rules.types.UPDATE),
    Opcode.fromSymbol('equal'),
    Opcode.fromSymbol('if'),
    Opcode.fromSymbol('return'),
    Opcode.fromSymbol('endif'),

    Opcode.fromSymbol('type'),
    Opcode.fromInt(rules.types.REVOKE),
    Opcode.fromSymbol('equal'),
    Opcode.fromSymbol('if'),
    Opcode.fromSymbol('return'),
    Opcode.fromSymbol('endif'),

    Opcode.fromSymbol('type'),
    Opcode.fromInt(rules.types.FINALIZE),
    Opcode.fromSymbol('equal'),
    Opcode.fromSymbol('if'),
    Opcode.fromSymbol('blake256'),
    Opcode.fromPush(hashlock),
    Opcode.fromSymbol('equalverify'),
    Opcode.fromSymbol('endif'),

    // allow the script to pass if
    // execution makes it this far
    Opcode.fromInt(1)
  ]);

  script.compile();
  return script;
}

/**
 * Witness shape as a stack:
 *   - script
 *   - pubkey
 *   - signature
 */
function witness(signature, pubkey, pubkeyhash, hashlock) {
  assert(Buffer.isBuffer(signature));
  assert(Buffer.isBuffer(pubkey));
  assert(Buffer.isBuffer(pubkeyhash));
  assert(Buffer.isBuffer(hashlock));

  const witness = new Witness([
    signature,
    pubkey,
    program(pubkeyhash, hashlock).encode()
  ]);

  witness.compile();
  return witness;
}

/**
 * Generate the witness for the finalize path
 */

function finalizeWitness(preimage, pubkeyhash, hashlock) {
  assert(Buffer.isBuffer(preimage));

  const witness = new Witness([
    preimage,
    program(pubkeyhash, hashlock).encode()
  ]);

  witness.compile();
  return witness;
}

/**
 * convert hex string to buffer
 */

function b(buf, enc) {
  if (!enc)
    enc = 'hex';
  return Buffer.from(buf, enc);
}

async function sleep(time) {
  return new Promise(resolve => setTimeout(resolve, time));
}
