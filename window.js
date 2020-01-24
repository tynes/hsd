'use strict';

const assert = require('bsert');
const AsyncEmitter = require('bevent');

class SlidingWindow extends AsyncEmitter {
  /**
   * Create a sliding window counter
   * @property {Number} window - window period in milliseconds
   * @property {Number} limit - max requests allowed
   * @property {Timeout} timeout - sliding window timeout
   * @property {Number} counter - current window counter
   * @property {Number} previous - previous window counter
   * @property {Number} current - current window start time in milliseconds
   */

  constructor(options) {
    super();

    this.window = options.window;
    this.limit = options.limit;

    this.timeout = null;
    this.counter = 0;
    this.previous = 0;
    this.current = 0;
  }

  start() {
    this.current = Date.now();
    this.timeout = setTimeout(() => this.reset(), this.window);
  }

  stop() {
    this.current = 0;
    clearTimeout(this.timeout);
  }

  async reset() {
    this.previous = this.counter;
    this.counter = 0;
    this.current = Date.now();
    this.emit('reset');
  }

  score() {
    const ms = Date.now() - this.current;
    const percent = 1 - (ms / this.window);
    assert(percent > 0, 'invalid previous window weight');

    return this.previous * percent + this.counter;
  }

  get() {
    if (this.score() >= this.limit)
      throw Error('over the limit');

    this.counter++;
    return;
  }
}

module.exports = SlidingWindow;
