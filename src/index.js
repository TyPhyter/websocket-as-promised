/**
 * WebSocket with promise api
 */

/**
 * @external Channel
 */

const Channel = require('chnl');
const ControlledPromise = require('controlled-promise');
const promiseFinally = require('promise.prototype.finally');
const utils = require('./utils');

const DEFAULT_OPTIONS = {
  /**
   * WebSocket creation function
   *
   * @param {String} url
   * @returns {WebSocket}
   */
  createWebSocket: url => new WebSocket(url),
  /**
   * Packs message to send by WebSocket.
   *
   * @param {String} requestId
   * @param {*} data
   * @returns {String|ArrayBuffer|Blob}
   */
  packMessage: (requestId, data) => {
    const message = Object.assign({requestId}, data);
    return JSON.stringify(message);
  },
  /**
   * Unpacks message received by WebSocket.
   * Returned value should be object with {requestId, data} fields.
   *
   * @param {String|ArrayBuffer|Blob} message
   * @returns {Object<{requestId, data}>}
   */
  unpackMessage: message => {
    const data = JSON.parse(message);
    return {requestId: data.requestId, data};
  },
  timeout: 0,
};

// see: https://developer.mozilla.org/en-US/docs/Web/API/WebSocket#Ready_state_constants
const STATE = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
};

/**
 * @typicalname wsp
 */
class WebSocketAsPromised {
  /**
   * Constructor. Unlike original WebSocket it does not immediately open connection.
   * Please call `open()` method manually to connect.
   *
   * @param {String} url WebSocket URL
   * @param {Object} [options]
   * @param {Function} [options.createWebSocket=url => new Websocket(url)] custom WebSocket creation method
   * @param {String} [options.idProp="id"] id property name attached to each message
   * @param {Number} [options.timeout=0] default timeout for requests
   */
  constructor(url, options) {
    this._url = url;
    this._options = utils.mergeDefaults(options, DEFAULT_OPTIONS);
    this._opening = new ControlledPromise();
    this._closing = new ControlledPromise();
    this._pendingRequests = new Map();
    this._onMessage = new Channel();
    this._onClose = new Channel();
    this._ws = null;
  }

  /**
   * Returns original WebSocket instance created by `options.createWebSocket`.
   *
   * @returns {WebSocket}
   */
  get ws() {
    return this._ws;
  }

  /**
   * Is WebSocket connection in opening state.
   *
   * @returns {Boolean}
   */
  get isOpening() {
    return Boolean(this._ws && this._ws.readyState === STATE.CONNECTING);
  }

  /**
   * Is WebSocket connection opened.
   *
   * @returns {Boolean}
   */
  get isOpened() {
    return Boolean(this._ws && this._ws.readyState === STATE.OPEN);
  }

  /**
   * Is WebSocket connection in closing state.
   *
   * @returns {Boolean}
   */
  get isClosing() {
    return Boolean(this._ws && this._ws.readyState === STATE.CLOSING);
  }

  /**
   * Is WebSocket connection closed.
   *
   * @returns {Boolean}
   */
  get isClosed() {
    return Boolean(!this._ws || this._ws.readyState === STATE.CLOSED);
  }

  /**
   * Event channel triggered every time when message from server arrives.
   * Listener accepts two arguments:
   * 1. `jsonData` if JSON parse succeeded
   * 2. original `event.data`
   *
   * @see https://vitalets.github.io/chnl/#channel
   * @example
   * wsp.onMessage.addListener((data, jsonData) => console.log(data, jsonData));
   *
   * @returns {Channel}
   */
  get onMessage() {
    return this._onMessage;
  }

  /**
   * Event channel triggered when connection closed.
   * Listener accepts single argument `{code, reason}`.
   *
   * @see https://vitalets.github.io/chnl/#channel
   *
   * @returns {Channel}
   */
  get onClose() {
    return this._onClose;
  }

  /**
   * Opens WebSocket connection.
   *
   * @returns {Promise}
   */
  open() {
    if (this.isClosing) {
      return Promise.reject(new Error(`Can not open closing WebSocket connection`));
    }
    if (this.isOpened) {
      return this._opening.promise;
    }
    return this._opening.call(() => {
      const {timeout, createWebSocket} = this._options;
      this._opening.timeout(timeout, `Can't open WebSocket connection within allowed timeout: ${timeout} ms`);
      this._ws = createWebSocket(this._url);
      this._addWsListeners();
    });
  }

  /**
   * Performs request and waits for response.
   *
   * @param {Object} data
   * @param {Object} [options]
   * @param {String} [options.requestId]
   * @param {String} [options.requestIdPrefix]
   * @param {Number} [options.timeout]
   * @returns {Promise}
   */
  request(data, options = {}) {
    if (!data || typeof data !== 'object') {
      return Promise.reject(new Error(`WebSocket request data should be a plain object, got ${data}`));
    }
    const requestId = options.requestId || utils.generateId(options.requestIdPrefix);
    const message = this._options.packMessage(requestId, data);
    const timeout = options.timeout !== undefined ? options.timeout : this._options.timeout;
    const request = this._addRequest(requestId, message, timeout);
    return request.promise;
  }

  /**
   * Sends any data by WebSocket.
   *
   * @param {String|ArrayBuffer|Blob} data
   */
  send(data) {
    if (this.isOpened) {
      this._ws.send(data);
    } else {
      throw new Error('Can not send data because WebSocket is not opened.');
    }
  }

  /**
   * Closes WebSocket connection.
   *
   * @returns {Promise}
   */
  close() {
    if (this.isClosed) {
      return Promise.resolve(this._closing.value);
    }
    return this._closing.call(() => {
      const {timeout} = this._options;
      this._closing.timeout(timeout, `Can't close WebSocket connection within allowed timeout: ${timeout} ms`);
      this._ws.close();
    });
  }

  _addWsListeners() {
    this._ws.addEventListener('open', event => this._handleOpen(event));
    this._ws.addEventListener('message', event => this._handleMessage(event));
    this._ws.addEventListener('error', event => this._handleError(event));
    this._ws.addEventListener('close', event => this._handleClose(event));
  }

  _handleOpen(event) {
    this._opening.resolve(event);
  }

  _handleMessage(event) {
    const message = event.data;
    let requestId, data;
    try {
      const result = this._options.unpackMessage(message);
      requestId = result.requestId;
      data = result.data;
    } catch(e) {
      // do nothing if can not unpack message
    }
    this._onMessage.dispatchAsync(message, data);
    this._tryResolveRequest(requestId, data);
  }

  _handleError() {
    // todo: when this event comes?
  }

  _handleClose(event) {
    // todo: removeWsListeners, use Channel.Subscription
    this._ws = null;
    this._closing.resolve(event);
    const error = new Error(`WebSocket connection closed with reason: ${event.reason} (${event.code})`);
    if (this._opening.isPending) {
      this._opening.reject(error);
    }
    this._pendingRequests.forEach(request => request.isPending ? request.reject(error) : null);
    this._onClose.dispatchAsync(event);
  }

  _addRequest(requestId, message, timeout) {
    // todo: if request with the same id still pending?
    const request = new ControlledPromise();
    request.timeout(timeout, `WebSocket request was rejected by timeout (${timeout} ms). RequestId: ${requestId}`);
    request.call(() => this.send(message));
    this._pendingRequests.set(requestId, request);
    promiseFinally(request.promise, () => this._pendingRequests.delete(requestId)).catch(() => {});
    return request;
  }

  _tryResolveRequest(requestId, data) {
    if (requestId && this._pendingRequests.has(requestId)) {
      this._pendingRequests.get(requestId).resolve(data);
    }
  }
}

module.exports = WebSocketAsPromised;
