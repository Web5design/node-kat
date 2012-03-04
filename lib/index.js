var Stream = require('stream').Stream
  , util = require('util')
  , fs = require('fs')
  , path = require('path')
  , Queue = require('./queue')

//
// ### Creates an instance of a Kat to concatenate files
//
// @constructor
// @extends (Stream)
// @param file... (string|Stream) List of files that will be added
// @param options
//     { flags: 'r'
//     , encoding: null
//     , start: null
//     , end: null
//     }
//
var Kat = module.exports = function() {
  Stream.call(this);

  this.started = false;
  this.readable = true;
  this.paused = false;
  this.bytesRead = 0;
  this.pos = 0;
  this.start = 0;
  this.end = Infinity;
  this.concurrency = 250;
  this.allowFiles = true;
  this.allowDirs = true;
  this.allowStreams = true;
  this.continueOnErr = false;
  this._sized = 0;

  // check for options
  var args = Array.prototype.slice.call(arguments);
  var last = args.pop();
  if (typeof last !== 'string' && !isStream(last)) {
    for (var key in last) {
      if (!last.hasOwnProperty(key)) continue;
      this[key] = last[key];
    }

    if (typeof this.start !== 'number') {
      throw new Error('start must be a number');
    }
    if (typeof this.end !== 'number') {
      throw new Error('end must be a number');
    }
    if (this.start > this.end) {
      throw new Error('start and end must be start <= end');
    }
    if (typeof this.concurrency !== 'number' || this.concurrency <= 0) {
      throw new Error('concurrency must be a number and over 0');
    }

  } else {
    args.push(last);
  }

  // a queue for opening and reading a file's stats
  var self = this;
  this._openQueue = new Queue(function(file, callback) {
    var indir = this.injected;

    if (typeof file === 'string') {
      fs.open(file, self.flags || 'r', self.mode || 438, function(err, fd) {
        if (err) return callback(err);

        fs.fstat(fd, function(err, stat) {
          if (err) return callback(err);

          if (stat.isFile()) {
            if (!indir && !self.allowFiles) {
              return callback(new Error('Cannot add files'));
            }

            self.emit('fd', fd, file);
            callback(function(callback) {
              self._addFile(file, fd, stat.size, callback);
            });

          } else if (stat.isDirectory()) {
            if (!self.allowDirs) {
              return callback(new Error('Cannot add directories'));
            }

            var noerr = true;
            function readdir(err, files) {
              if (noerr && err) {
                noerr = false;
                return callback(err);
              }

              if (!files || !files.length) return;

              files = files.sort().map(function(f) {
                return path.join(file, f);
              });
              callback(files);
            }

            fs.readdir(file, readdir);
            fs.close(fd, readdir);
          }
        });
      });

    } else if (isStream(file)) {
      process.nextTick(function() {
        if (!self.allowStreams) {
          return callback(new Error('Cannot add streams'));
        }
        callback(function(callback) {
          self._addStream(file, false, callback);
        });
      });

    } else {
      callback(new Error('Invalid argument given: ' + file));
    }
  }, this.concurrency);

  this._openQueue.on('error', function(err) {
    self.emit('error', err);
    if (!self.continueOnErr) self._openQueue.die();
  });

  this._queue = [];
  this._clean = [];
  this._files = [];
  this._totalFiles = 0;

  // call add with possible given files to read
  if (args.length > 0) {
    this.add.apply(this, args);
  }
}

util.inherits(Kat, Stream);


//
// Adds a file, folder, or readable stream
// @param file... (string|Stream)
//
Kat.prototype.add = function() {
  if (!this.readable) throw new Error('Cannot add any more files');
  var self = this;

  for (var i = 0, len = arguments.length; i < len; i++) {
    var file = arguments[i];
    if (isStream(file)) file.pause();
    self._openQueue.push(file);
  }
};


//
// Adds a file from a path
// @param file (string)
//
Kat.prototype._addFile = function(file, fd, size, callback) {
  if (this._skip) return callback();
  var start = 0, end = Infinity;

  // calculate start and end positions for this file
  // uncertain means that a stream was added before this file
  // and the size of it is unknown
  if (!this._uncertain) {
    if (this.start > this._sized) start = this.start - this._sized;

    // if the end position is reached, make note of it
    var newSize = this._sized + size;
    if (this.end <= newSize) {
      this._skip = true;
      end = this.end - this._sized;
    }

    this.pos += Math.min(start, size);

    // add size to total
    this._sized = newSize;

    // if no data will be read from this file, skip it
    if (start >= size || end && start >= end) return callback();
  }

  var options = { fd: fd, start: start, end: end };
  var rs = fs.createReadStream(file, options);
  this._addStream(rs, true, callback);
};


//
// Adds a readable stream
// @param stream (Stream)
//
Kat.prototype._addStream = function(stream, sized, callback) {
  // take note if the size of this stream is not known
  if (!sized) this._uncertain = true;

  // add to list of files
  var path = stream.path || this._totalFiles++;
  var bytesRead = 0;

  // set the encoding
  if (this.encoding) stream.setEncoding(this.encoding);

  // pause if another stream is reading
  // and add it to queue
  if (this._currentStream) {
    stream.pause();
    this._queue.push(stream);
  } else {
    this._currentStream = stream;
    this.started = true;
    if (this.paused) {
      stream.pause();
    } else {
      stream.resume();
      this.emit('start', path);
    }
  }

  // add to queue of streams
  var self = this;

  // add to list of files if data was read from this file
  function addToFiles() {
    if (bytesRead > 0) {
      self._files.push({ path: path, size: bytesRead });
    }
  }

  // when an error occurs, stop
  function onerr(err) {
    if (!self.continueOnErr) {
      self._cleanUp();
      self.destroy();
    } else {
      onend();
    }

    self.emit('error', err);
  }
  stream.on('error', onerr);

  // proxy `fd` and `close` events to this instance
  function onfd(fd) {
    self.emit('fd', fd, path);
  }
  stream.on('fd', onfd);

  function onclose() {
    self.emit('close', path);
  }
  stream.on('close', onclose);

  // proxy `data` events as well
  function ondata(data) {
    // add data length to total bytes read
    self.bytesRead += data.length;
    var oldPos = self.pos;
    self.pos += data.length;

    // check if there is any uncertainty if this data should be emitted
    // in case `start` and `end` options were given
    if (oldPos >= self._sized) {

      if (self.start > oldPos) {
        // skip this data event if start is in a later file
        if (self.start > self.pos) return;

        var start = self.start - oldPos
        data = data.slice(start);
      }

      // check if end position is in this data event
      if (self.end < self.pos) {
        var end = self.end - oldPos + 1
        data = data.slice(0, end);
      }
    }

    // emit data to Kat instance
    bytesRead += data.length;
    self.emit('data', data);

    // end stream if end will be reached on this `data` event reached
    if (self.end < self.pos) {
      addToFiles();
      self._end();
    }
  }
  stream.on('data', ondata);

  // when the stream ends, check if there is another stream in the queue
  // if there isn't, finished
  function onend() {
    callback();
    self._clean.shift()();
    addToFiles();
    var stream = self._currentStream = self._queue.shift();

    if (stream) {
      stream.resume();
      self.emit('start', path);
    } else if (self._openQueue.workers === 0) {
      self._end();
    }
  }
  stream.on('end', onend);

  // clean up by removing all event listeners
  self._clean.push(function cleanUp() {
    stream.on('error', onerr);
    stream.on('fd', onfd);
    stream.on('close', onclose);
    stream.on('data', ondata);
    stream.on('end', onend);
  });
};


//
// @param encoding (string)
//
Kat.prototype.setEncoding = function(encoding) {
  this.encoding = encoding;
  this._currentStream.setEncoding(encoding);
  this._queue.forEach(function(stream) {
    stream.setEncoding(encoding);
  });
};


//
// Pauses this stream from emitting any more `data` events
//
Kat.prototype.pause = function() {
  if (!this.readable || this.paused) return;
  this.paused = true;
  if (this._currentStream) {
    this._currentStream.pause();
  }
};


//
// Resumes stream
//
Kat.prototype.resume = function() {
  if (!this.paused) return;
  this.paused = false;
  if (this._currentStream) {
    this._currentStream.resume();
  }
};


//
// Destroys all streams and stops emitting events
//
Kat.prototype.destroy = function() {
  if (!this.readable) return;

  if (this._currentStream) {
    this._currentStream.destroy();
  }
  this._cleanUp();
};


//
// Destroys all streams and stops after write queue is drained
//
Kat.prototype.destroySoon = function() {
  if (!this.readable) return;

  if (this._currentStream) {
    this._currentStream.destroySoon();
  }
  this._cleanUp();
};


//
// Gets rid of all streams in queue
//
Kat.prototype._cleanUp = function() {
  this.readable = false;
  this.currentStream = null;
  this._openQueue = null;

  this._clean.forEach(function(fn) {
    fn();
  });
  this._clean = [];

  this._queue.forEach(function(stream) {
    stream.destroy();
  });
  this._queue = [];
};


//
// Ends reading from stream and emits `end` event
//
Kat.prototype._end = function() {
  this.destroy();
  this.readable = false;
  this.emit('files', this._files);
  this.emit('end');
};


//
// Returns true if stream is a readable stream
//
function isStream(stream) {
  var isit = typeof stream === 'object' && stream instanceof Stream
  if (isit && !stream.readable) {
    throw new Error('Stream is not readable');
  }
  return isit;
}