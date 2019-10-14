'use strict';

const assert = require('bsert');
const {NodeClient, WalletClient} = require('hs-client');
const StubResolver = require('bns/lib/resolver/stub');
const bcrypto = require('bcrypto');
const dnssec = require('bns/lib/dnssec');
const util = require('bns/lib/util');
const wire = require('bns/lib/wire');
const FullNode = require('../lib/node/fullnode');
const Resource = require('../lib/dns/resource');
const Network = require('../lib/protocol/network');
const rules = require('../lib/covenants/rules');
const common = require('./util/common');
const {types} = wire;

const json = require('./data/resources-v0.json');

const network = Network.get('regtest');

const node = new FullNode({
  network: 'regtest',
  apiKey: 'foo',
  walletAuth: true,
  rsNoUnbound: true,
  memory: true,
  workers: true,
  plugins: [require('../lib/wallet/plugin')]
});

const nstub = new StubResolver({
  rd: true,
  cd: true,
  edns: true,
  ednsSize: 4096,
  maxAttempts: 2,
  maxTimeout: 3000,
  dnssec: true,
  servers: [`127.0.0.1:${network.nsPort}`]
});

const rstub = new StubResolver({
  rd: true,
  cd: true,
  edns: true,
  ednsSize: 4096,
  maxAttempts: 2,
  maxTimeout: 3000,
  dnssec: true,
  servers: [`127.0.0.1:${network.rsPort}`]
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

const {
  treeInterval,
  biddingPeriod,
  revealPeriod
} = network.names;

// miner controlled address
let coinbase;

describe('DNS Servers', function() {
  this.timeout(15000);

  before(async () => {
    await node.open();
    await nclient.open();
    await wclient.open();
    await nstub.open();
    await rstub.open();

    // mine a bunch of blocks
    const info = await wallet.createAddress('default');
    coinbase = info.address;

    for (let i = 0; i < 15; i++)
      await nclient.execute('generatetoaddress', [2, coinbase]);
  });

  after(async () => {
    await nclient.close();
    await wclient.close();
    await node.close();
    await nstub.close();
    await rstub.close();
  });

  describe('Recursive Resolver', () => {
    it('should return an A record', async () => {
      const name = 'google.com.';

      const res = await rstub.lookup(name, types.A);

      const [question] = res.question;
      assert(typeof question === 'object');
      assert.equal(question.name, name);

      const [answer] = res.answer;
      assert(typeof answer === 'object');
      assert.equal(answer.name, name);
    });
  });

  describe('Authoritative Resolver', () => {
    it('should return no answer for an ICANN rooted name', async () => {
      const name = 'com.';

      const res = await nstub.lookup(name, types.A);

      assert.equal(res.question[0].name, name);
      assert.equal(res.answer.length, 0);

      // Handshake zone is not authoritative for ICANN based name
      assert.equal(res.aa, false);
    });

    it('should return no answer for HNS name pre-update', async () => {
      const name = 'foo.';

      const res = await nstub.lookup(name, types.A);
      assert.equal(res.answer.length, 0);
    });

    // record to save in the authenticated tree
    for (const [hstype, item] of Object.entries(json)) {
      const type = types[item.type];
      const resource = Resource.fromJSON(item.resource);

      // args: size, height, network
      const name = rules.grindName(5, 1, network);

      it(`should update ${name}`, async () => {
        await wallet.client.post(`/wallet/${wallet.id}/open`, {
          name: name
        });

        await mineBlocks(treeInterval + 1, coinbase);

        await wallet.client.post(`/wallet/${wallet.id}/bid`, {
          name: name,
          bid: 1000,
          lockup: 2000
        });

        await mineBlocks(biddingPeriod + 1, coinbase);

        await wallet.client.post(`/wallet/${wallet.id}/reveal`, {
          name: name
        });

        await mineBlocks(revealPeriod + 1, coinbase);

        await wallet.client.post(`/wallet/${wallet.id}/update`, {
          name: name,
          data: resource.toJSON()
        });

        // mine a block
        await mineBlocks(1, coinbase);

        const rinfo = await nclient.execute('getnameresource', [name]);

        const json = resource.getJSON(name);
        assert.deepEqual(rinfo, json);

        const info = await nclient.execute('getnameinfo', [name]);
        const data = Buffer.from(info.info.data, 'hex');

        const returned = Resource.decode(data);
        assert.deepEqual(returned.getJSON(name), json);

        // this commits the tree state to disk
        // updates served by the dns server
        await mineBlocks(treeInterval, coinbase);
      });

      it(`should return authenticated ${hstype} record`, async () => {
        // Certain types of queries require the
        // name to be formatted with additional data
        const query = buildQuery(name, resource, type);

        const response = await nstub.lookup(query, type);
        const res = response.toJSON();
        const dns = resource.toDNS(util.fqdn(name), type).toJSON();

        // query for the zone signing key
        const dnskey = await nstub.lookup('.', types.DNSKEY);

        // parse the zone signing key and
        // key signing key out of the response
        const {zsk, ksk} = getSigningKeys(dnskey);

        assert(zsk instanceof wire.Record);
        assert(ksk instanceof wire.Record);

        // validate the signature on the ZSK
        verifyDNSSEC(dnskey, ksk, types.DNSKEY, '.');
        // validate the signature over the rrsets
        verifyDNSSEC(response, zsk, type, query);

        // NOTE: the signatures are not canonical
        // when the native backend is being used
        // because it uses OpenSSL which does not
        // yet use RFC 6979, so nullify the
        // signatures before comparing them

        if (bcrypto.native === 2)
          assert.deepEqual(nullSig(res), nullSig(dns));
        else
          assert.deepEqual(res.name, dns.name);
      });
    }
  });
});

/**
 * Mine blocks and take into
 * account race conditions
 */

async function mineBlocks(count, address) {
  for (let i = 0; i < count; i++) {
    const obj = { complete: false };
    node.once('block', () => {
      obj.complete = true;
    });
    await nclient.execute('generatetoaddress', [1, address]);
    await common.forValue(obj, 'complete', true);
  }
}

/**
 * Verify DNSSEC for each name in the
 * response. Only check the answer and
 * authority sections. If all rrsets
 * are signed, the responses will be
 * too large and not fit into udp packets
 */

function verifyDNSSEC(resource, pubkey, qtype, name) {
  // rr types that are not committed to in DNSSEC
  const skip = new Set([
    types.RRSIG
  ]);

  name = util.fqdn(name);

  const {answer, authority} = resource;
  const targets = [answer, authority];

  const records = [];

  for (const target of targets) {
    const toVerify = new Set();
    for (const record of target) {
      records.push(record);

      if (!skip.has(record.type))
        toVerify.add(record.type);
    }

    for (const type of toVerify) {
      const rrsig = target.find((rr) => {
        return rr.type === types.RRSIG
          && rr.data.typeCovered === type;
      });

      if (name !== rrsig.name) {
        const record = records.find((rr) => {
          return rr.name === util.fqdn(name)
            && (rr.type === types.CNAME
            || rr.type === types.DNAME
            || rr.type === types.SRV
            || rr.type === types.NS);
        });

        assert(record);

        switch (qtype) {
          case types.CNAME:
          case types.DNAME:
          case types.SRV:
            name = record.data.target;
            break;
          case types.NS:
            name = record.data.ns;
            break;
          default:
            assert(false, 'rrsig name does not match');
        }
      }

      const rrs = util.extractSet(target, name, type);

      const valid = dnssec.verify(rrsig, pubkey, rrs);
      assert(valid);
    }
  }
}

/**
 * Nullify out any signatures in
 * a DNS response.
 */

function nullSig(resource) {
  for (const answer of resource.answer) {
    if (answer.data.signature)
      answer.data.signature = null;
  }

  for (const authority of resource.authority) {
    if (authority.data.signature)
      authority.data.signature = null;
  }

  for (const additional of resource.additional) {
    if (additional.data.signature)
      additional.data.signature = null;
  }
}

/**
 * Parse the ZSK and KSK from
 * a record.
 */

function getSigningKeys(record) {
  let ksk, zsk;
  for (const rr of record.answer) {
    if (rr.type === types.DNSKEY) {
      const {data} = rr.toJSON();
      if (data.keyType === 'ZSK')
        zsk = rr;
      else if (data.keyType === 'KSK')
        ksk = rr;
    }
  }

  return {
    zsk: zsk,
    ksk: ksk
  };
}

/**
 * Build a name to query for the types
 * that require additional labels.
 */

function buildQuery(name, resource, type) {
  switch (type) {
    case types.SRV: {
      const service = resource.service[0];
      return '_' + service.service
        + '_' + service.protocol
        + name;
    }
    case types.TLSA: {
      const tls = resource.tls[0];
      return '_'
        + tls.port
        + '._'
        + tls.protocol
        + name;
    }
    case types.SMIMEA: {
      const smime = resource.smime[0];
      return smime.hash.toString('hex')
        + '.'
        + '_smimecert.'
        + name;
    }
    case types.OPENPGPKEY: {
      const pgp = resource.pgp[0];
      return pgp.hash.toString('hex')
        + '.'
        + '_openpgpkey.'
        + name;
    }
    default:
      return name;
  }
}
