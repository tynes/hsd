'use strict';

class Window extends Object {
  /**
   * Create a sliding window
   * @property {Number} window - window period in seconds
   * @property {Number} limit - max limit allowed
   */

  constructor(options) {
    super(options);

    this.window = options.window;
    this.limit = options.limit;
    this.counter = 0;
    this.timeout = setTimeout(this.reset, this.window);
  }

  async reset() {
    // TODO: lock?
    this.counter = 0;
  }

  get() {
    if (this.counter > this.limit)
      throw Error('over the limit');

    this.counter++;
    return;
  }
}

module.exports = Window;
