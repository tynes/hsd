/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

const assert = require('bsert');
const SlidingWindow = require('../lib/net/window');

async function sleep(time) {
  return new Promise(resolve => setTimeout(resolve, time));
}

describe('SlidingWindow (Unit)', function() {
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
