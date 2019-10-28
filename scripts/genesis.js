/* eslint quotes: "off" */

'use strict';

const assert = require('bsert');
const Path = require('path');
const fs = require('bfile');
const {wire} = require('bns');
const blake2b = require('bcrypto/lib/blake2b');
const consensus = require('../lib/protocol/consensus');
const Network = require('../lib/protocol/network');
const TX = require('../lib/primitives/tx');
const AirdropProof = require('../lib/primitives/airdropproof');
const Block = require('../lib/primitives/block');
const Address = require('../lib/primitives/address');
const Witness = require('../lib/script/witness');
const util = require('../lib/utils/util');
const {KSK_2010, KSK_2017} = wire;

const networks = {
  main: Network.get('main'),
  testnet: Network.get('testnet'),
  regtest: Network.get('regtest'),
  simnet: Network.get('simnet')
};

const genesisCommitment = Buffer.from([
  AirdropProof.AIRDROP_ROOT,
  AirdropProof.FAUCET_ROOT,
  Buffer.from(KSK_2010, 'ascii'),
  Buffer.from(KSK_2017, 'ascii')
], 'hex');

function createGenesisBlock(options) {
  const genesis = Address.fromHash(consensus.GENESIS_KEY, 0);
  const nonce = options.nonce >>> 0;
  let flags = options.flags;
  let commitment = options.commitment;

  if (!flags) {
    flags = Buffer.from(
      `01/Nov/2017 EFF to ICANN: Don't Pick Up the Censor's Pen`,
      'ascii');
  }

  if (!commitment)
    commitment = genesisCommitment;

  assert(Buffer.isBuffer(commitment));
  const digest = blake2b.digest(commitment, 32);
  const addr = Address.fromNulldata(digest);

  const tx = new TX({
    version: 0,
    inputs: [{
      prevout: {
        hash: consensus.ZERO_HASH,
        index: 0xffffffff
      },
      witness: new Witness([flags]),
      sequence: 0xffffffff
    }],
    outputs: [
      {
        value: consensus.GENESIS_REWARD,
        address: genesis
      },
      {
        value: 0,
        address: addr
      }
    ],
    locktime: 0
  });

  tx.refresh();

  const block = new Block({
    version: 0,
    prevBlock: consensus.ZERO_HASH,
    merkleRoot: consensus.ZERO_HASH,
    witnessRoot: consensus.ZERO_HASH,
    treeRoot: consensus.ZERO_HASH,
    reservedRoot: consensus.ZERO_HASH,
    time: options.time,
    bits: options.bits,
    nonce: nonce,
    extraNonce: Buffer.alloc(consensus.NONCE_SIZE, 0x00),
    mask: consensus.ZERO_HASH
  });

  block.txs.push(tx);

  block.merkleRoot = block.createMerkleRoot();
  block.witnessRoot = block.createWitnessRoot();

  return block;
}

const blocks = {
  main: createGenesisBlock({
    time: 1554268735,
    bits: networks.main.pow.bits
  }),
  testnet: createGenesisBlock({
    time: 1554268735,
    bits: networks.testnet.pow.bits
  }),
  regtest: createGenesisBlock({
    time: 1554268735,
    bits: networks.regtest.pow.bits
  }),
  simnet: createGenesisBlock({
    time: 1554268735,
    bits: networks.simnet.pow.bits
  })
};

function formatJS(name, block) {
  let out = '';

  out += `genesis.${name} = {\n`;
  out += `  version: ${block.version},\n`;
  out += `  hash: Buffer.from(\n`;
  out += `    '${block.hash().toString('hex')}',\n`;
  out += `    'hex'),\n`;
  out += `  prevBlock: Buffer.from(\n`;
  out += `    '${block.prevBlock.toString('hex')}',\n`;
  out += `    'hex'),\n`;
  out += `  merkleRoot: Buffer.from(\n`;
  out += `    '${block.merkleRoot.toString('hex')}',\n`;
  out += `    'hex'),\n`;
  out += `  witnessRoot: Buffer.from(\n`;
  out += `    '${block.witnessRoot.toString('hex')}',\n`;
  out += `    'hex'),\n`;
  out += `  treeRoot: Buffer.from(\n`;
  out += `    '${block.treeRoot.toString('hex')}',\n`;
  out += `    'hex'),\n`;
  out += `  reservedRoot: Buffer.from(\n`;
  out += `    '${block.reservedRoot.toString('hex')}',\n`;
  out += `    'hex'),\n`;
  out += `  time: ${block.time},\n`;
  out += `  bits: 0x${util.hex32(block.bits)},\n`;
  out += `  nonce: 0x${util.hex32(block.nonce)},\n`;
  out += `  extraNonce: Buffer.from(\n`;
  out += `    '${block.extraNonce.toString('hex')}',\n`;
  out += `    'hex'),\n`;
  out += `  mask: Buffer.from(\n`;
  out += `    '${block.mask.toString('hex')}',\n`;
  out += `    'hex'),\n`;
  out += `  height: 0\n`;
  out += `};`;

  return out;
}

function formatC(name, block) {
  const hdr = block.toHead().toString('hex');
  const upper = name.toUpperCase();
  const chunks = [`static const uint8_t HSK_GENESIS_${upper}[] = ""`];

  for (let i = 0; i < hdr.length; i += 26)
    chunks.push(`  "${hdr.slice(i, i + 26)}"`);

  const hex = chunks.join('\n');
  const data = hex.replace(/([a-f0-9]{2})/g, '\\x$1');

  return `${data};`;
}

const code = [
  '// Autogenerated, do not edit.',
  '',
  `'use strict';`,
  '',
  `const data = require('./genesis-data.json');`,
  'const genesis = exports;',
  ''
];

for (const name of Object.keys(blocks)) {
  const upper = name[0].toUpperCase() + name.substring(1);
  const block = blocks[name];
  code.push('/*');
  code.push(` * ${upper}`);
  code.push(' */');
  code.push('');
  code.push(formatJS(name, block));
  code.push('');
  code.push(`genesis.${name}Data = Buffer.from(data.${name}, 'base64');`);
  code.push('');
}

const json = JSON.stringify({
  main: blocks.main.encode().toString('base64'),
  testnet: blocks.testnet.encode().toString('base64'),
  regtest: blocks.regtest.encode().toString('base64'),
  simnet: blocks.simnet.encode().toString('base64')
}, null, 2);

const ccode = [
  '#ifndef _HSK_GENESIS_H',
  '#define _HSK_GENESIS_H',
  '',
  '/* Autogenerated, do not edit. */',
  ''
];

for (const name of Object.keys(blocks)) {
  const upper = name[0].toUpperCase() + name.substring(1);
  const block = blocks[name];
  ccode.push('/*');
  ccode.push(` * ${upper}`);
  ccode.push(' */');
  ccode.push('');
  ccode.push(formatC(name, block));
  ccode.push('');
}

ccode.push('#endif');
ccode.push('');

const file = Path.resolve(
  __dirname,
  '..',
  'lib',
  'protocol',
  'genesis.js'
);

fs.writeFileSync(file, code.join('\n'));

const jfile = Path.resolve(
  __dirname,
  '..',
  'lib',
  'protocol',
  'genesis-data.json'
);

fs.writeFileSync(jfile, json + '\n');

const cfile = Path.resolve(
  __dirname,
  '..',
  'etc',
  'genesis.h'
);

fs.writeFileSync(cfile, ccode.join('\n'));
