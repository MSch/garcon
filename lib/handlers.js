/*globals __dirname*/

var self = this,
    l = {},
    File, Handlers, sharedHandlers;

require('./string');
File = require('./file').File;
l.fs = require('fs');
l.path = require('path');
l.util = require('util');
l.spawn = require('child_process').spawn;
l.jslint = require('./jslint').JSLINT;

l.uglify = {
  parser: require(l.path.join(__dirname, 'uglify', 'lib', 'parse-js')),
  processor: require(l.path.join(__dirname, 'uglify', 'lib', 'process'))
};

try {
  l.less = require('less');
} catch(e) {
  l.util.puts("WARNING: 'less' could not be required.");
  l.util.puts("         You won't be able to parse .less files.");
  l.util.puts("         Install it with `npm install less`.");
}

self.Handlers = function(options) {
  this.handlers = {};
};

Handlers = self.Handlers;

Handlers.prototype.add = function(name, handler) {
  this.handlers[name] = handler;
};

Handlers.prototype.build = function(handlers) {
  var len = handlers.length,
      i, name, args, first, current, next;
    
  for (i = 0; i < len; ++i) {
    args = handlers[i];
    
    if (args instanceof Array) {
      name = args.shift();
    } else {
      name = args;
      args = [];
    }
    
    next = this.handlers[name].apply(this, args);

    if (first === undefined) {
      first = next;
    } else {
      current.next = next;
    }
    current = next;
  }
  
  return first;
};

sharedHandlers = self.sharedHandlers = new self.Handlers();

sharedHandlers.urlPrefix = '/';

sharedHandlers.add('ifModifiedSince', function() {
  var that = {};
  
  that.handle = function(file, request, callback) {
    var files, scanner;
    
    var Scanner = function(files, callback) {
      var that = this;
      
      that.count = files.length;
      
      that.maxMtime = 0;
      
      that.callbackIfDone = function() {
        if (that.count <= 0) callback(that.maxMtime);
      };
      
      that.scan = function() {
        files.forEach(function(file) {
          if (file.isVirtual) {
            that.count -= 1;
            that.callbackIfDone();
          } else {
            l.fs.stat(file.path, function(err, stats) {
              that.count -= 1;
              if (err) {
                l.util.puts('WARNING: ' + err.message);
                that.callbackIfDone();
              } else {
                if (stats.mtime > that.maxMtime) {
                  that.maxMtime = stats.mtime;
                }
                that.callbackIfDone();
              }
            });
          }
        });
        that.callbackIfDone();
      };
    };
    
    if (file.isDirectory()) {
      files = file.children;
    } else {
      files = [file];
    }
    
    scanner = new Scanner(files, function(mtime) {
      if (!request || request.headers['if-modified-since'] === undefined || mtime > Date.parse(request.headers['if-modified-since'])) {
        that.next.handle(file, request, function(response) {
          response.lastModified = mtime === 0 ? undefined : mtime;
          callback(response);
        });
      } else {
        callback({ status: 304 });
      }
    });
    
    scanner.scan();
  };

  return that;
});

sharedHandlers.add('cache', function() {
  var that = {};
  
  that.cache = {};
  
  that.handle = function(file, request, callback) {
    if (that.cache[file.path] === undefined) {
      that.next.handle(file, request, function(response) {
        that.cache[file.path] = response;
        callback(response);
      });
    } else {
      callback(that.cache[file.path]);
    }
  };
  
  return that;
});

sharedHandlers.add('contentType', function(contentType) {
  var that = {};
  
  that.contentType = contentType;
  
  that.contentTypes = {
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.json': 'application/json',
    '.svg': 'image/svg+xml'
  };
  
  that.handle = function(file, request, callback) {
    that.next.handle(file, request, function(response) {
      response.contentType = that.contentType === undefined ? that.contentTypes[file.extname()] : that.contentType;
      callback(response);
    });
  };

  return that;
});

sharedHandlers.add('minify', function() {
  var that = {};
  
  that.handle = function(file, request, callback) {
    that.next.handle(file, request, function(response) {
      if (file.isStylesheet()) {
        var data = '',
            min;
        
        min = l.spawn('java', ['-jar', l.path.join(__dirname, '..', 'bin', 'yuicompressor-2.4.2.jar'), '--type', 'css']);

        min.stdout.on('data', function(newData) {
          data += newData;
        });

        min.stderr.on('data', function(data) {
          l.sys.print(data);
        });

        min.on('exit', function(code) {
          if (code !== 0) {
            l.sys.puts('ERROR: Minifier exited with code ' + code);
          } else {
            response.data = data;
          }

          callback(response);
        });

        min.stdin.write(response.data);
        min.stdin.end();
        
      } else if (file.isScript()) {
        var ast;
        
        ast = l.uglify.parser.parse(response.data);
        ast = l.uglify.processor.ast_mangle(ast);
        ast = l.uglify.processor.ast_squeeze(ast);
        response.data = l.uglify.processor.gen_code(ast);
        
        callback(response);
      }
    });
  };
  
  return that;
});

sharedHandlers.add('rewriteSuper', function() {
  var that = {};

  that.handle = function(file, request, callback) {
    that.next.handle(file, request, function(response) {
      if (/sc_super\(\s*[^\)\s]+\s*\)/.test(response.data)) {
        l.util.puts('ERROR in ' + file.path + ': sc_super() should not be called with arguments. Modify the arguments array instead.');
      }
      response.data = response.data.replace(/sc_super\(\)/g, 'arguments.callee.base.apply(this,arguments)');
      callback(response);
    });
  };

  return that;
});

sharedHandlers.add('rewriteStatic', function(format) {
  var that = {};
  
  that.format = format || "'%@'";

  that.handle = function(file, request, callback) {
    that.next.handle(file, request, function(response) {
      var re = new RegExp("(sc_static|static_url)\\(\\s*['\"](resources\/){0,1}(.+?)['\"]\\s*\\)"),
          dirname = file.framework.url();
            
      response.data = response.data.toString('utf8').gsub(re, function(match) {
        var path = l.path.join(dirname, match[3]);
        
        // if the resource was not found, try to guess its location
        if (!file.framework.server.files[path]) {
          
          // try the root folder directly, then images/
          ['', 'images'].some(function(prefix) {
            
            // try every resources extensions (.png, .jpg, etc.)
            return File.resourceExtensions.some(function(extname) {
              var alternatePath = l.path.join(dirname, prefix, match[3] + extname);
              if (file.framework.server.files[alternatePath]) {
                path = alternatePath;
                return true;
              } else {
                return false;
              }
            });
            
          });
                        
          if (!file.framework.server.files[path]) {
            l.util.puts('WARNING: ' + path + ' referenced in ' + file.path + ' but was not found.');
          }
        }
        
        return that.format.replace('%@', l.path.join(sharedHandlers.urlPrefix, path));
      });
      callback(response);
    });
  };

  return that;
});

sharedHandlers.add('rewriteFile', function(format) {
  var that = {};
  
  that.handle = function(file, request, callback) {
    that.next.handle(file, request, function(response) {
      response.data = response.data.replace(/__FILE__/g, file.url());
      callback(response);
    });
  };

  return that;
});

sharedHandlers.add('wrapTest', function(format) {
  var that = {};
  
  that.handle = function(file, request, callback) {
    that.next.handle(file, request, function(response) {
      response.data = [
        '(function() {',
          'SC.filename = "__FILE__";',
          response.data,
        '})();'
      ].join('\n');
      
      callback(response);
    });
  };

  return that;
});

sharedHandlers.add('join', function() {
  var that = {};
    
  that.handle = function(file, request, callback) {
    var data = [],
        files, count;
        
    if (file.children === null) {
      files = [file];
    } else {
      files = file.children;
    }
    
    count = files.length;
    
    if (count === 0) {
      callback({ data: '' });
      
    } else {
      files.forEach(function(file, i) {
        var next = that.next ? that.next : file.handler;
                
        next.handle(file, request, function(d) {
          data[i] = d.data;
          count -= 1;
          if (count === 0) {
            callback({ data: data.join('\n') });
          }
        });
      });
    }
  };

  return that;
});

sharedHandlers.add('file', function() {    
  var that = {};

  that.handle = function(file, request, callback) {
    file.content(function(err, data) {
      if (err) {
        throw err;
      } else {
        callback({ data: data.length === 0 ? '' : data });
      }
    });
  };

  return that;
});

sharedHandlers.add('symlink', function() {    
  var that = {};

  that.handle = function(file, request, callback) {
    file.symlink.handler.handle(file.symlink, request, callback);
  };

  return that;
});

sharedHandlers.add('jslint', function() {
  var that = {};
  
  that.handle = function(file, request, callback) {
    that.next.handle(file, request, function(response) {
      var i, e, data,
      options = {
        bitwise: true,
        eqeqeq: true,
        immed: true,
        newcap: true,
        nomen: true,
        onevar: true,
        plusplus: true,
        regexp: true,
        undef: true,
        white: true,
        rhino: true
      };
      
      if (!l.jslint(response.data.toString(), options)) {
        for (i = 0; i < l.jslint.errors.length; ++i) {
          e = l.jslint.errors[i];
          if (e) {
            l.util.puts('WARNING: jslint error at line ' + e.line + ' character ' + e.character + ': ' + e.reason);
            l.util.puts('         ' + (e.evidence || '').replace(/^\s*(\S*(\s+\S+)*)\s*$/, "$1"));
            l.util.puts('');
          }
        }
      }
      
      
      callback(response);
    });
  };
  
  return that;
});

sharedHandlers.add('less', function(format) {
  var that = {};
  
  that.handle = function(file, request, callback) {
    that.next.handle(file, request, function(response) {
      var parser;
      
      if (l.less && file.extname() === '.less') {        
        parser = new l.less.Parser({
          optimization: 0,
          paths: [file.framework.path]
        });

        parser.parse(response.data, function(err, tree) {
          if (err) {
            l.util.puts('ERROR: ' + err.message);
            console.log(err);
          } else {
            try {
              response.data = tree.toCSS();
            } catch (e) {
              l.util.puts('ERROR: ' + e.message);
              console.log(e);
            }
          }
          callback(response);
        });
      } else {
        callback(response);
      }
    });
  };

  return that;
});

sharedHandlers.add('handlebars', function(format) {
  var that = {};

  that.handle = function(file, request, callback) {
    that.next.handle(file, request, function(response) {
      var parser;

      if (file.extname() === '.handlebars') {
        var re = /[^\/]+\/templates\/(.+)\.handlebars/,
            filename = re.exec(file.url())[1];

        response.data = [
          "SC.TEMPLATES['", filename, "'] =",
          "SC.Handlebars.compile(", JSON.stringify(response.data.toString('utf8')), ");"
        ].join('');
        callback(response);
      } else {
        callback(response);
      }
    });
  };

  return that;
});
