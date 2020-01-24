'use strict';

const assert = require('bsert');
const AsyncEmitter = require('bevent');

class SlidingWindow extends AsyncEmitter {
  /**
   * Create a sliding window counter
   * e.g:
   * ```
   * new SlidingWindow({
   *   window: 1000,
   *   max: 100
   * })
   * ```
   * creates a sliding window which allows 100 requests per second
   * @property {Number} window - window period in milliseconds
   * @property {Number} max - max requests allowed
   * @property {Timeout} timeout - sliding window timeout
   * @property {Number} current - current window counter
   * @property {Number} previous - previous window counter
   * @property {Number} timestamp - current window start time in milliseconds
   */

  constructor(options) {
    super();

    this.window = options.window || 1000;
    this.max = options.max || 100;

    this.timeout = null;
    this.current = 0;
    this.previous = 0;
    this.timestamp = 0;
  }

  start() {
    this.timestamp = Date.now();
    this.timeout = setTimeout(() => this.reset(), this.window);
  }

  stop() {
    this.timestamp = 0;
    clearTimeout(this.timeout);
  }

  async reset() {
    this.previous = this.current;
    this.current = 0;
    this.timestamp = Date.now();
    this.emit('reset');
  }

  score() {
    const ms = Date.now() - this.timestamp;
    const weight = 1 - (ms / this.window);
    assert(weight > 0, 'invalid previous window weight');

    return this.previous * weight + this.current;
  }

  increase(count) {
    assert((count >>> 0) === count);
    this.current += count;
  }

  allow() {
    if (this.score() >= this.max)
      return false;
    return true;
  }
}

module.exports = SlidingWindow;
