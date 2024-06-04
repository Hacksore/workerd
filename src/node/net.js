import { Duplex } from 'node-internal:streams_duplex';

import inner from 'cloudflare-internal:sockets';

import {
  ERR_INVALID_ARG_VALUE,
  ERR_INVALID_ARG_TYPE,
  ERR_MISSING_ARGS,
  ERR_OUT_OF_RANGE,
  ERR_OPTION_NOT_IMPLEMENTED,
  ERR_SOCKET_CLOSED,
  ERR_SOCKET_CLOSED_BEFORE_CONNECTION,
  EPIPE,
} from 'node-internal:internal_errors';

import {
  validateAbortSignal,
  validateFunction,
  validateInt32,
  validateNumber,
  validatePort,
} from 'node-internal:validators';

import {
  isUint8Array,
  isArrayBufferView,
} from 'node-internal:internal_types';

import { Buffer } from 'node-internal:internal_buffer';

const kHandle = Symbol('kHandle');
const kLastWriteQueueSize = Symbol('kLastWriteQueueSize');
const kTimeout = Symbol('kTimeout');
const kBuffer = Symbol('kBuffer');
const kBufferCb = Symbol('kBufferCb');
const kBufferGen = Symbol('kBufferGen');
const kBytesRead = Symbol('kBytesRead');
const kBytesWritten = Symbol('kBytesWritten');
const kUpdateTimer = Symbol('kUpdateTimer');
const normalizedArgsSymbol = Symbol('normalizedArgs');

// Once the socket has been opened, the socket info provided by the
// socket.opened promise will be stored here.
const kSocketInfo = Symbol('kSocketInfo');

// IPv4 Segment
const v4Seg = '(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])';
const v4Str = `(?:${v4Seg}\\.){3}${v4Seg}`;
const IPv4Reg = new RegExp(`^${v4Str}$`);

// IPv6 Segment
const v6Seg = '(?:[0-9a-fA-F]{1,4})';
const IPv6Reg = new RegExp('^(?:' +
  `(?:${v6Seg}:){7}(?:${v6Seg}|:)|` +
  `(?:${v6Seg}:){6}(?:${v4Str}|:${v6Seg}|:)|` +
  `(?:${v6Seg}:){5}(?::${v4Str}|(?::${v6Seg}){1,2}|:)|` +
  `(?:${v6Seg}:){4}(?:(?::${v6Seg}){0,1}:${v4Str}|(?::${v6Seg}){1,3}|:)|` +
  `(?:${v6Seg}:){3}(?:(?::${v6Seg}){0,2}:${v4Str}|(?::${v6Seg}){1,4}|:)|` +
  `(?:${v6Seg}:){2}(?:(?::${v6Seg}){0,3}:${v4Str}|(?::${v6Seg}){1,5}|:)|` +
  `(?:${v6Seg}:){1}(?:(?::${v6Seg}){0,4}:${v4Str}|(?::${v6Seg}){1,6}|:)|` +
  `(?::(?:(?::${v6Seg}){0,5}:${v4Str}|(?::${v6Seg}){1,7}|:))` +
')(?:%[0-9a-zA-Z-.:]{1,})?$');

const TIMEOUT_MAX = 2 ** 31 - 1;

// ======================================================================================

export function Socket(options) {
  // TODO(now): Since we're not supporting async_hooks, we need to determine the
  // best way to support async context for the Socket. Likely we should capture
  // the AsyncLocalStorage snapshot here and use it for the various async
  // operations that are performed... Need to investigate the correct behavior
  // with Node.js and approximate it here as closely as possible.
  if (!(this instanceof Socket)) return new Socket(options);

  if (options?.objectMode) {
    throw new ERR_INVALID_ARG_VALUE(
      'options.objectMode',
      options.objectMode,
      'is not supported');
  } else if (options?.readableObjectMode || options?.writableObjectMode) {
    throw new ERR_INVALID_ARG_VALUE(
      `options.${
        options.readableObjectMode ? 'readableObjectMode' : 'writableObjectMode'
      }`,
      options.readableObjectMode || options.writableObjectMode,
      'is not supported',
    );
  }
  if (typeof options?.keepAliveInitialDelay !== 'undefined') {
    validateNumber(options?.keepAliveInitialDelay, 'options.keepAliveInitialDelay');

    if (options.keepAliveInitialDelay < 0) {
      options.keepAliveInitialDelay = 0;
    }
  }

  if (typeof options === 'number') {
    options = { fd: options };
  } else {
    options = { ...options };
  }

  if (options.handle) {
    // We are not supporting the options.handle option for now. This is the
    // option that allows users to pass in a handle to an existing socket.
    throw new ERR_OPTION_NOT_IMPLEMENTED('options.handle');
  } else if (options.fd !== undefined) {
    // We are not supporting the options.fd option for now. This is the option
    // that allows users to pass in a file descriptor to an existing socket.
    // Workers doesn't have file descriptors and does not use them in any way.
    throw new ERR_OPTION_NOT_IMPLEMENTED('options.fd');
  }

  if (Boolean(options.noDelay)) {
    throw new ERR_OPTION_NOT_IMPLEMENTED('truthy options.noDelay');
  }
  if (Boolean(options.keepAlive)) {
    throw new ERR_OPTION_NOT_IMPLEMENTED('truthy options.keepAlive');
  }

  options.allowHalfOpen = Boolean(options.allowHalfOpen);
  // TODO(now): Match behavior with Node.js
  options.emitClose = true;
  options.autoDestroy = true;
  options.decodeStrings = false;

  // In Node.js, these are meaningful when the options.fd is used.
  // We do not support options.fd so we just ignore whatever value
  // is given and always pass true.
  options.readable = true;
  options.writable = true;

  this.connecting = false;
  this._hadError = false;
  this[kHandle] = null;
  this._parent = null;
  this._host = null;
  this[kLastWriteQueueSize] = 0;
  this[kTimeout] = null;
  this[kBuffer] = null;
  this[kBufferCb] = null;
  this[kBufferGen] = null;
  this[kSocketInfo] = null;
  this[kBytesRead] = 0;
  this[kBytesWritten] = 0;
  this._closeAfterHandlingError = false;

  Duplex.call(this, options);

  this.on('end', onReadableStreamEnd);

  if (options.signal) {
    // TODO(now): Tests to make sure adding the AbortSignal works as expected
    addClientAbortSignalOption(this, options);
  }

  // TODO(now): Property support the user-provided onread buffer. This allows
  // the user to specify the buffer that the socket will read into. If not
  // provided, we allocate our own buffer.
  const onread = options.onread;
  if (onread !== null && typeof onread === 'object' &&
      (isUint8Array(onread.buffer) || typeof onread.buffer === 'function') &&
      typeof onread.callback === 'function') {
    if (typeof onread.buffer === 'function') {
      this[kBuffer] = true;
      this[kBufferGen] = onread.buffer;
    } else {
      this[kBuffer] = onread.buffer;
    }
    this[kBufferCb] = onread.callback;
  } else {
    this[kBuffer] = new Uint8Array(4096);
  }
};
Object.setPrototypeOf(Socket.prototype, Duplex.prototype);
Object.setPrototypeOf(Socket, Duplex);

Socket.prototype._unrefTimer = function _unrefTimer() {
  for (let s = this; s != null; s = s._parent) {
    if (s[kTimeout] != null) {
      clearTimeout(s[kTimeout]);
      s[kTimeout] = this.setTimeout(s.timeout, s._onTimeout.bind(s));
    }
  }
};

Socket.prototype.setTimeout = function(msecs, callback) {
  if (this.destroyed) return this;

  this.timeout = msecs;

  msecs = getTimerDuration(msecs, 'msecs');

  clearTimeout(this[kTimeout]);

  if (msecs === 0) {
    if (callback !== undefined) {
      validateFunction(callback, 'callback');
      this.removeListener('timeout', callback);
    }
  } else {
    this[kTimeout] = setTimeout(this._onTimeout.bind(this), msecs);
    if (callback !== undefined) {
      validateFunction(callback, 'callback');
      this.once('timeout', callback);
    }
  }
  return this;
};

Socket.prototype._onTimeout = function () {
  const handle = this._handle;
  const lastWriteQueueSize = this[kLastWriteQueueSize];
  if (lastWriteQueueSize > 0 && handle) {
    // `lastWriteQueueSize !== writeQueueSize` means there is
    // an active write in progress, so we suppress the timeout.
    const { writeQueueSize } = handle;
    if (lastWriteQueueSize !== writeQueueSize) {
      this[kLastWriteQueueSize] = writeQueueSize;
      this._unrefTimer();
      return;
    }
  }
  this.emit('timeout');
};

Socket.prototype._getpeername = function() {
  if (this?.[kSocketInfo].remoteAddress == null) {
    return {};
  } else if (!this._peername) {
    // The this[kSocketInfo].remoteAddress is a string in the format "ip:port"
    const addr = this[kSocketInfo].remoteAddress;
    const pos = addr.lastIndexOf(':');
    const address = addr.slice(0, pos);
    this._peername = {
      address,
      port: Number(addr.slice(pos + 1)),
      family: isIPv4(address) ? 'IPv4' : (isIPv6(address) ? 'IPv6' : undefined),
    };
  }
  return this._peername;
};

Socket.prototype._getsockname = function() {
  if (this[kSocketInfo] == null) {
    return {};
  } else if (!this._sockname) {
    // TODO(now): The socket info has a local address property, should we use it?
    this._sockname = {
      address: '0.0.0.0',
      port: 0,
      family: 'IPv4',
    };
  }
  return this._sockname;
};

Socket.prototype.address = function() {
  return this._getsockname();
};

// ======================================================================================
// Writable side ...

Socket.prototype._writeGeneric = function(writev, data, encoding, cb) {
  // If we are still connecting, buffer this for later.
  // The writable logic will buffer up any more writes while
  // waiting for this one to be done.
  try {
    if (this.connecting) {
      function onClose() {
        cb(new ERR_SOCKET_CLOSED_BEFORE_CONNECTION());
      }
      this.once('connect', function () {
        this.off('close', onClose);
        this._writeGeneric(writev, data, encoding, cb);
      });
      this.once('close', onClose);
      return;
    }

    if (this._handle?.writer === undefined) {
      cb(new ERR_SOCKET_CLOSED());
      return false;
    }

    this._unrefTimer();

    let lastWriteSize = 0;
    if (writev) {
      // data is an array of objects.
      const promises = [];
      for (const d of data) {
        if (typeof d.chunk === 'string') {
          d.chunk = Buffer.from(d.chunk, d.encoding);
        }
        promises.push(this._handle.writer.write(d.chunk));
        lastWriteSize += d.chunk.byteLength;
      }
      // TODO(maybe): We could concat the buffers and write them all at once.
      Promise.all(promises).then(
        () => cb(),
        (err) => cb(err)
      ).finally(() => {
        this[kLastWriteQueueSize] = 0;
        this._unrefTimer();
      });
    } else {
      if (typeof data === 'string') {
        data = Buffer.from(data, encoding);
      }
      this._handle.writer.write(data).then(
        () => cb(),
        (err) => cb(err)
      ).finally(() => {
        this[kLastWriteQueueSize] = 0;
        this._unrefTimer();
      });
      lastWriteSize = data.byteLength;
    }
    this[kLastWriteQueueSize] = lastWriteSize;
  } catch (err) {
    this.destroy(err);
  }
};

Socket.prototype._writev = function(chunks, cb) {
  this._writeGeneric(true, chunks, '', cb);
};

Socket.prototype._write = function(data, encoding, cb) {
  this._writeGeneric(false, data, encoding, cb);
};

Socket.prototype._final = function(cb) {
  if (this.connecting) {
    this.once('connect', () => this._final(cb));
    return;
  }

  // If there is no writer, then there's really nothing left to do here.
  if (this._handle?.writer === undefined) {
    cb();
    return;
  }

  // TODO(now): When the close is complete, should the handle.writer be cleared?
  this._handle.writer.close().then(() => cb(), (err) => cb(err));
};

Socket.prototype.end = function(data, encoding, cb) {
  Duplex.prototype.end.call(this, data, encoding, cb);
  return this;
};

// ======================================================================================
// Readable side

Socket.prototype.pause = function() {
  // If the read loop is already running, setting reading to false
  // will interrupt it after the current read completes (if any)
  if (this._handle) this._handle.reading = false;
  return Duplex.prototype.pause.call(this);
};

Socket.prototype.resume = function() {
  maybeStartReading(this);
  return Duplex.prototype.resume.call(this);
};

Socket.prototype.read = function(n) {
  maybeStartReading(this);
  return Duplex.prototype.read.call(this, n);
};

Socket.prototype._read = function(n) {
  if (this.connecting || !this._handle) {
    this.once('connect', () => this._read(n));
  } else if (!this._handle.reading) {
    maybeStartReading(this);
  }
};

// ======================================================================================
// Destroy and reset

Socket.prototype._reset = function() {
  this.resetAndClosing = true;
  return this.destroy();
};

Socket.prototype.resetAndDestroy = function() {
  if (this._handle) {
    if (this.connecting) {
      this.once('connect', () => this._reset());
    } else {
      this._reset();
    }
  } else {
    this.destroy(new ERR_SOCKET_CLOSED());
  }
  return this;
};

Socket.prototype.destroySoon = function() {
  if (this.writable) {
    this.end();
  }

  if (this.writableFinished) {
    this.destroy();
  } else {
    this.once('finish', this.destroy);
  }
};

Socket.prototype._destroy = function(exception, cb) {
  if (this[kTimeout]) clearTimeout(this[kTimeout]);
  if (this._handle) {
    this._handle.socket.close().then(
        () => cleanupAfterDestroy(this, cb, exception),
        (err) => cleanupAfterDestroy(this, cb, err || exception));
  } else {
    cleanupAfterDestroy(this, cb, exception);
  }
};

// ======================================================================================
// Connection

Socket.prototype.connect = function(...args) {
  let normalized;
  if (Array.isArray(args[0]) && args[0][normalizedArgsSymbol]) {
    normalized = args[0];
  } else {
    normalized = normalizeArgs(args);
  }
  const options = normalized[0];
  const cb = normalized[1];

  if (cb !== null) {
    this.once('connect', cb);
  }

  if (this._parent && this._parent.connecting) {
    return this;
  }

  if (options.port === undefined && options.path == null) {
    return new ERR_MISSING_ARGS(['options', 'port', 'path']);
  }

  if (this.write !== Socket.prototype.write) {
    this.write = Socket.prototype.write;
  }

  if (this.destroyed) {
    this._handle = null;
    this._peername = null;
    this._sockname = null;
  }

  const { path } = options;
  if (!!path) {
    throw new ERR_INVALID_ARG_VALUE('path', path, 'is not supported');
  }

  initializeConnection(this, options);

  return this;
};

// ======================================================================================
// Socket methods that are not no-ops or nominal impls

Socket.prototype.setNoDelay = function(enable) {
  if (!enable) return;
  throw new ERR_INVALID_ARG_VALUE('enable', enable, 'is not supported');
};

Socket.prototype.setKeepAlive = function(enable, initialDelay) {
  if (!enable) return;
  throw new ERR_INVALID_ARG_VALUE('enable', enable, 'is not supported');
};

Socket.prototype.ref = function() {
  // Intentional no-op
};

Socket.prototype.unref = function() {
  // Intentional no-op
};

Object.defineProperties(Socket.prototype, {
  _connecting: {
    __proto__: null,
    get() { return this.connecting; },
  },
  pending: {
    __proto__: null,
    get() { return !this._handle || this.connecting; },
    configurable: true,
  },
  readyState: {
    __proto__: null,
    get() {
      if (this.connecting) {
        return 'opening';
      } else if (this.readable && this.writable) {
        return 'open';
      } else if (this.readable && !this.writable) {
        return 'readOnly';
      } else if (!this.readable && this.writable) {
        return 'writeOnly';
      }
      return 'closed';
    },
  },
  writableLength: {
    __proto__: null,
    configurable: false,
    enumerable: true,
    get() { return this._writableState.length; }
  },
  bufferSize: {
    __proto__: null,
    get() {
      if (this._handle) {
        return this.writableLength;
      }
    },
  },
  [kUpdateTimer]: {
    __proto__: null,
    get() {
      return this._unrefTimer;
    },
  },
  bytesRead: {
    __proto__: null,
    configurable: false,
    enumerable: true,
    get() {
      return this._handle ? this._handle.bytesRead : this[kBytesRead];
    }
  },
  remoteAddress: {
    __proto__: null,
    configurable: false,
    enumerable: true,
    get() {
      return this._getpeername().address;
    }
  },
  remoteFamily: {
    __proto__: null,
    configurable: false,
    enumerable: true,
    get() {
      return this._getpeername().family;
    }
  },
  remotePort: {
    __proto__: null,
    configurable: false,
    enumerable: true,
    get() {
      return this._getpeername().port;
    }
  },
  localAddress: {
    __proto__: null,
    configurable: false,
    enumerable: true,
    get() { return '0.0.0.0'; }
  },
  localPort: {
    __proto__: null,
    configurable: false,
    enumerable: true,
    get() { return 0; }
  },
  localFamily: {
    __proto__: null,
    configurable: false,
    enumerable: true,
    get() { return 'IPv4'; }
  },
});

// ======================================================================================
// Helper/utility methods

function cleanupAfterDestroy(socket, cb, error) {
  socket._handle = null;
  socket[kBuffer] = null;
  socket[kBufferCb] = null;
  socket[kBufferGen] = null;
  socket[kSocketInfo] = null;
  cb(error);
}

function initializeConnection(socket, options) {

  // options.localAddress and options.localPort are ignored.
  let {
    host,
    port,
    autoSelectFamily,
    lookup,
  } = options;

  if (!!autoSelectFamily) {
    // We don't support this option. If the value is falsy, we can safely ignore it.
    // If the value is truthy, we'll throw an error.
    throw new ERR_INVALID_ARG_VALUE('options.autoSelectFamily',
                                    autoSelectFamily,
                                    'is not supported');
  }

  if (typeof port !== 'undefined') {
    if (typeof port !== 'number' && typeof port !== 'string') {
      throw new ERR_INVALID_ARG_TYPE('options.port', ['number', 'string'], port);
    }
    port = validatePort(port);
  }

  const addressType = isIP(host);
  if (addressType === 0) {
    // The host is not an IP address. That's allowed, but let's see if the user
    // provided a lookup function. If not, we'll skip.
    if (typeof lookup !== 'undefined') {
      validateFunction(lookup, 'options.lookup');
      // TODO(now): Implement support for using the lookup function.
      // for now, error, because we don't implement it yet.
      throw new ERR_INVALID_ARG_VALUE('options.lookup', lookup, 'is not supported');
    }
  }

  socket._unrefTimer();
  socket.connecting = true;

  socket.emit('connectionAttempt', options.host, options.port, addressType);

  const handle = inner.connect(`${options.host}:${options.port}`, {
    allowHalfOpen: socket.allowHalfOpen,
    // We are not going to pass the high water mark here. The outer Node.js
    // stream will implement the appropriate backpressure for us.
    // TODO(now): Support secureTransport?
  });

  socket._handle = {
    socket: handle,
    writer: handle.writable.getWriter(),
    // TODO(now): Mode byob
    reader: handle.readable.getReader(),
  };

  handle.opened.then(
    onConnectionOpened.bind(socket),
    (err) => {
      socket.emit('connectionAttemptFailed', host, port, addressType, err);
      socket.destroy(err);
  });

  handle.closed.then(
    onConnectionClosed.bind(socket),
    socket.destroy.bind(socket));
}

function onConnectionOpened(info) {
  try {
    this[kSocketInfo] = info;
    this.connecting = false;

    // TODO(now): Node.js includes checks here to determine if the readable or
    // writable side of the socket should be closed immediately.
    // if (this.readable && !readable) {
    //   this.push(null);
    //   this.read();
    // }
    // if (this.writable && !writable) {
    //   this.end();
    // }

    this._unrefTimer();

    this.emit('connect');
    this.emit('ready');

    if (!this.isPaused()) {
      maybeStartReading(this);
    }
  } catch (err) {
    this.destroy(err);
  }
}

function onConnectionClosed() {
  // TODO(now): What should we do here? Anything?
}

async function startRead(socket) {
  // TODO(now): If onread is used, make use of the buffer for byob reads.
  const reader = socket._handle.reader;
  while (socket._handle.reading === true) {
    const { value, done } = await reader.read();
    if (done) {
      // All done!
      socket.push(null);
      break;
    }
    // TODO(now): The push method will signal if the stream has hit a
    // backpressure limit. If it does, we need to stop reading until the
    // drain event is emitted, then we can continue reading.
    socket.push(value);
  }
}

function maybeStartReading(socket) {
  if (socket[kBuffer] && !socket.connecting && socket._handle && !socket._handle.reading) {
    socket._handle.reading = true;
    startRead(socket).then(
      () => socket._handle.reading = false,
      (err) => socket.destroy(err));
  }
}

function writeAfterFIN(chunk, encoding, cb) {
  if (!this.writableEnded) {
    return Duplex.prototype.write.call(this, chunk, encoding, cb);
  }

  if (typeof encoding === 'function') {
    cb = encoding;
    encoding = null;
  }

  const er = new EPIPE();

  // TODO(now): Invoke the callback in the captured async context scope
  // if (typeof cb === 'function') {
  //   defaultTriggerAsyncIdScope(this[async_id_symbol], process.nextTick, cb, er);
  // }
  queueMicrotask(() => cb(er));
  this.destroy(er);

  return false;
}

function onReadableStreamEnd() {
  if (!this.allowHalfOpen) {
    this.write = writeAfterFIN;
  }
}

function getTimerDuration(msecs, name) {
  validateNumber(msecs, name);
  if (msecs < 0 || !Number.isFinite(msecs)) {
    throw new ERR_OUT_OF_RANGE(name, 'a non-negative finite number', msecs);
  }

  // Ensure that msecs fits into signed int32
  if (msecs > TIMEOUT_MAX) {
    return TIMEOUT_MAX;
  }

  return msecs;
}

function toNumber(x) { return (x = Number(x)) >= 0 ? x : false; }

function isPipeName(s) {
  return typeof s === 'string' && toNumber(s) === false;
}

function normalizeArgs(args) {
  let arr;

  if (args.length === 0) {
    arr = [{}, null];
    arr[normalizedArgsSymbol] = true;
    return arr;
  }

  const arg0 = args[0];
  let options = {};
  if (typeof arg0 === 'object' && arg0 !== null) {
    // (options[...][, cb])
    options = arg0;
  } else if (isPipeName(arg0)) {
    // (path[...][, cb])
    options.path = arg0;
  } else {
    // ([port][, host][...][, cb])
    options.port = arg0;
    if (args.length > 1 && typeof args[1] === 'string') {
      options.host = args[1];
    }
  }

  const cb = args[args.length - 1];
  if (typeof cb !== 'function')
    arr = [options, null];
  else
    arr = [options, cb];

  arr[normalizedArgsSymbol] = true;
  return arr;
}

function addClientAbortSignalOption(self, options) {
  validateAbortSignal(options.signal, 'options.signal');
  const { signal } = options;
  let disposable;

  function onAbort() {
    disposable?.[Symbol.dispose]();
    self._aborted = true;
    // TODO(now): What else should be do here? Anything?
  }

  if (signal.aborted) {
    queueMicrotask(onAbort);
  } else {
    queueMicrotask(() => {
      disposable = addAbortListener(signal, onAbort);
    });
  }
}

function addAbortListener(signal, listener) {
  if (signal === undefined) {
    throw new ERR_INVALID_ARG_TYPE('signal', 'AbortSignal', signal);
  }
  validateAbortSignal(signal, 'signal');
  validateFunction(listener, 'listener');

  let removeEventListener;
  if (signal.aborted) {
    queueMicrotask(() => listener());
  } else {
    signal.addEventListener('abort', listener, { once: true });
    removeEventListener = () => {
      signal.removeEventListener('abort', listener);
    };
  }
  return {
    __proto__: null,
    [Symbol.dispose]() {
      removeEventListener?.();
    },
  };
}

// ======================================================================================
// The rest of the exports

export function connect(...args) {
  const normalized = normalizeArgs(args);
  const options = normalized[0];
  const socket = new Socket(options);
  if (options.timeout) {
    socket.setTimeout(options.timeout);
  }
  return socket.connect(normalized);
}

export const createConnection = connect;

export function getDefaultAutoSelectFamily() {
  // This is the only value we support.
  return false;
};

export function setDefaultAutoSelectFamily(val) {
  if (!val) return;
  throw new ERR_INVALID_ARG_VALUE('val', val);
};

// We don't actually make use of this. It's here only for compatibility.
// The value is not used anywhere.
let autoSelectFamilyAttemptTimeout = 10;

export function getDefaultAutoSelectFamilyAttemptTimeout() {
  return autoSelectFamilyAttemptTimeout;
}

export function setDefaultAutoSelectFamilyAttemptTimeout(val) {
  validateInt32(val, 'val', 1);
  if (val < 10) val = 10;
  autoSelectFamilyAttemptTimeout = value;
}

export function isIP(input) {
  input = `${input}`;
  if (isIPv4(input)) return 4;
  if (isIPv6(input)) return 6;
  return 0;
}

export function isIPv4(input) {
  input = typeof input !== 'string' ? `${input}` : input;
  return IPv4Reg.test(input);
}

export function isIPv6(input) {
  input = typeof input !== 'string' ? `${input}` : input;
  return IPv6Reg.test(input);
}
