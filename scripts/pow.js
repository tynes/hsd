/**
 *
 */

'use strict';

const consensus = require('../lib/protocol/consensus');
const networks = require('../lib/protocol/networks');
const {main, testnet, regtest, simnet} = networks;

// Calculate the total number of possibilities
// for numbers in a 32 byte range. 2^(32*8) ?

const argv = process.argv.slice('2');
const bits = parseInt(argv[0], 16);

if (!bits)
  process.exit();

//const buf = consensus.fromCompact(bits);

networks.custom = {
  pow: {
    bits: bits
  },
  type: 'custom'
}

//const pow = new BN()

//process.exit();

console.log();
for (const network of Object.values(networks)) {
  const {type, pow} = network;
  if (type === 'simnet')
    continue;
  if (!pow)
    continue;

  const bits = pow.bits;

  const buf = consensus.fromCompact(bits);
  const decimal = buf.toString(10);
  let target = buf.toString(16);
  while (target.length != (64))
    target = 0 + target;

  console.log(type + ' bits: ' + (bits).toString(16) + ' ' + bits);
  console.log('target:')
  console.log(target);
  console.log('decimal: ' + decimal.slice(0, 10) + '...');
  console.log();
}

