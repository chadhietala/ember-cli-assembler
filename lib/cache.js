'use strict';

function DescriptorCache() {
  this.store = Object.create(null);
}

DescriptorCache.prototype.get = function(key) {
  return this.store[key];
};

DescriptorCache.prototype.all = function() {
  return this.store;
};

DescriptorCache.prototype.set = function(key, value) {
  if (!this._contains(key)) {
    this.store[key] = value;
  } else {
    this.store[key].update(value);
  }
};

DescriptorCache.prototype._treeByType = function(key, treeType) {
  if (this.store[key]) {
    return this.store[key].trees[treeType];
  }

  throw new Error(key + ' was not found in the descriptor cache.');
};

DescriptorCache.prototype.treesByType = function(treeType) {
  return Object.keys(this.store).map(function(key) {
    return this._treeByType(key, treeType);
  }, this).filter(Boolean);
};

DescriptorCache.prototype.descriptorsByType = function(treeType) {
  return Object.keys(this.store).filter(function(key) {
    return Object.keys(this.store[key].trees).indexOf(treeType) > -1;
  }, this).map(function(key) {
    return this.store[key];
  }, this);
};

DescriptorCache.prototype._contains = function(key) {
  return !!this.store[key];
};

DescriptorCache.prototype.remove = function(key) {
  delete this.store[key];
};

module.exports = DescriptorCache;
