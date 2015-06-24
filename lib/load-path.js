'use strict';

var walkSync = require('walk-sync');
var fs       = require('fs-extra');
var path     = require('path');

function AddonLoadPath(inputTree, options) {
  this.inputTree = inputTree;
  this.name = options.name;
  this.description = 'LoadPath for ' + this.name;
}

AddonLoadPath.prototype.rebuild = function() {
  var paths = walkSync(this.inputPath);
  var isLegacyAddon = this._isLegacyAddon(paths);
  var files = paths.filter(function(relativePath) {
    return relativePath.slice(-1) !== '/';
  });

  if (isLegacyAddon) {
    this._legacyLoadPath(files);
  } else {
    this._setupLoadPath(files);
  }

  return this.outputPath;
};

AddonLoadPath.prototype._setupLoadPath = function(files) {
  files.forEach(function(relativePath) {
    var content = fs.readFileSync(this.inputPath + path.sep + relativePath, 'utf8');
    var parts = relativePath.split(path.sep);
    var hasScope = relativePath.charAt(0) === '@';
    var scope;
    var outputPath;

    if (hasScope) {
      scope = parts.shift(); // Store the scope
      parts.shift(); // Remove the extraneous namespace
      parts.unshift(scope); // Place the scope back on
    } else {
      parts.shift();
    }

    outputPath = this.outputPath + path.sep + parts.join(path.sep);

    fs.outputFileSync(outputPath, content);
  }, this);
};

/**
 * There is no concept of multiple loadpaths in the legacy world
 * so we can simply just write each item to the output path.
 *
 * @private
 * @param  {Array} files And array of relative paths
 * @return {Nil}
 */
AddonLoadPath.prototype._legacyLoadPath = function(files) {
  files.forEach(function(relativePath) {
    var hasScope = relativePath.charAt(0) === '@';
    var isReexport = relativePath === path.join(this.name, this.name + '.js');
    var content = fs.readFileSync(this.inputPath + path.sep + relativePath, 'utf8');
    var outputPath;

    if (hasScope && isReexport) {
      outputPath = this.outputPath + path.sep + this.name + '.js';
    } else {
      outputPath = this.outputPath + path.sep + relativePath;
    }

    fs.outputFileSync(outputPath, content);
  }, this);
};

AddonLoadPath.prototype._isLegacyAddon = function(relativePaths) {
  var hasIndexFile = relativePaths.indexOf(this.name + path.sep + 'index.js') > -1;
  var hasRexport = relativePaths.indexOf(this.name + path.sep  + this.name + '.js') > -1;
  return hasIndexFile && hasRexport;
};

module.exports = function(inputTree, options) {
  return new AddonLoadPath(inputTree, options);
};