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
    window.reset();
    window.stop();
  });

  it('should process max requests in window', async () => {
    for (let i=0; i < window.max; i++)
      assert.doesNotThrow(() => window.increase(1));
  });

  it('should reject after max requests in window', async () => {
    for (let i=0; i < window.max; i++)
      window.increase(1);

    window.increase(1);
    assert.ok(!window.allow());
  });

  it('should reset after window timeout', async () => {
    let reset = false;

    for (let i=0; i < window.max; i++)
      window.increase(1);

    window.once('reset', () => {
      reset = true;
    });

    await sleep(window.window);

    assert.ok(reset === true);
  });

  it('should process max requests in sliding window', async () => {
    let window1 = 50;
    for (let i=0; i < window1; i++)
      window.increase(1);

    await sleep(window.window);

    let window2 = 50;
    for (let i=0; i < window2; i++)
      window.increase(1);

    let score = window.score();
    assert.strictEqual(score, window1 + window2);
  });

  it('should reject after max requests in sliding window', async () => {
    let window1 = 50;
    for (let i=0; i < window1; i++)
      window.increase(1);

    await sleep(window.window);

    let window2 = 50;
    for (let i=0; i < window2; i++)
      window.increase(1);

    window.increase(1);
    assert.ok(!window.allow());
  });

  it('should process weighted max requests in sliding window', async () => {
    let window1 = 50;
    for (let i=0; i < window1; i++)
      window.increase(1);

    await sleep(1.5 * window.window);

    let window2 = 50;
    for (let i=0; i < window2; i++)
      window.increase(1);

    // We sleep for 50%  of the second window (1.5x window)
    // so score = 50 * (1-0.5) + 50 = 75
    let score = window.score();
    assert.strictEqual(score, 75);
  });

  it('should reject after max weighted requests in sliding window', async () => {
    let window1 = 50;
    for (let i=0; i < window1; i++)
      window.increase(1);

    await sleep(1.5 * window.window);

    let window2 = 50;
    for (let i=0; i < window2; i++)
      window.increase(1);

    for (let i=0; i < 25; i++)
      window.increase(1);

    window.increase(1);
    assert.ok(!window.allow());
  });
});
