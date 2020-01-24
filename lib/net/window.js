'use strict';

const assert = require('bsert');
const AsyncEmitter = require('bevent');

class SlidingWindow extends AsyncEmitter {
  /**
   * Create a sliding window counter
   * e.g:
   * ```
   * new SlidingWindow({
   *   maxrps: 100
   * })
   * ```
   * creates a sliding window which allows 100 requests per second
   * @property {Number} maxrps - max requests per second allowed
   * @property {Timeout} timeout - sliding window timeout
   * @property {Number} current - current window counter
   * @property {Number} previous - previous window counter
   * @property {Number} timestamp - current window start time in milliseconds
   */

  constructor(options) {
    super();

    this.maxrps = options.maxrps || 100;

    this.timeout = null;
    this.current = 0;
    this.previous = 0;
    this.timestamp = 0;
    this.window = 1000;
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
    if (this.score() >= this.maxrps)
      return false;
    return true;
  }
}

module.exports = SlidingWindow;
