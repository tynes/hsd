/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

const assert = require('bsert');
const Window = require('./window');

async function sleep(time) {
  return new Promise(resolve => setTimeout(resolve, time));
}

describe('Window (Unit)', function() {

  // Sliding window for 100 requests/second
  const window = new Window({
      window: 1000,
      limit: 100
  });

  beforeEach(() => {
    window.reset();
  });

  it('should limit to 100 requests/second', async () => {
    for (let i=0; i < 100; i++)
      window.get();

    assert.throws(window.get, Error, 'over the limit');
  });

  it('should limit to 100 requests/second over a sliding window ', async () => {
    /*
     *  < 1s > < 1s >
     *  -------------
     *  | 50  | 50  |
     *  -------------
     */

    for (let i=0; i < 50; i++)
      window.get();

    await sleep(window.window); 

    for (let i=0; i < 50; i++)
      window.get();

    assert.throws(window.get, Error, 'over the limit');
  });
});
