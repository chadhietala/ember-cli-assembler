'use strict';

var Cache = require('../../lib/cache');
var TreeDescriptor = require('ember-cli-tree-descriptor');
var expect = require('chai').expect;

describe('descriptor cache', function() {
  var cache;
  beforeEach(function() {
    cache = new Cache();
  });

  afterEach(function() {
    cache = null;
  });

  it('should set descriptors into the cache', function() {
    var desc = new TreeDescriptor({
      tree: { inputTree: {} },
      name: 'foo',
      packageName: 'fizz',
      treeType: 'app',
      root: '/',
      nodeModulesPath: '/node_modules',
      pkg: {name: 'fizz', version: '1.0.0'}
    });

    cache.set('foo', desc);

    expect(cache.store.foo).to.be.an('object');

    expect(cache.store.foo.trees).to.deep.eql({
      app: { inputTree: {} }
    });
    expect(cache.store.foo._treeTypes).to.deep.eql(['app']);
  });

  it('should only update trees if the key already exists', function() {
    var desc1 = new TreeDescriptor({
      tree: { inputTree: {} },
      name: 'foo',
      packageName: 'fizz',
      treeType: 'app',
      root: '/',
      nodeModulesPath: '/node_modules',
      pkg: {name: 'fizz', version: '1.0.0'}
    });

    var desc2 = new TreeDescriptor({
      tree: { inputTree: {} },
      name: 'foo',
      packageName: 'fizz',
      treeType: 'addon',
      root: '/',
      nodeModulesPath: '/node_modules',
      pkg: {name: 'fizz', version: '1.0.0'}
    });

    cache.set('foo', desc1);
    cache.set('foo', desc2);

    expect(cache.store.foo.trees).to.deep.eql({
      addon: { inputTree: {} },
      app: { inputTree: {} }
    });
  });

  it('should retrieve a descriptor by name', function() {
    var desc = new TreeDescriptor({
      tree: { inputTree: {} },
      name: 'foo',
      packageName: 'fizz',
      treeType: 'app',
      root: '/',
      nodeModulesPath: '/node_modules',
      pkg: {name: 'fizz', version: '1.0.0'}
    });

    cache.set('foo', desc);

    expect(cache.get('foo').name).to.eql('foo');
  });

  it('should retrieve a descriptor by name', function() {
    var desc1 = new TreeDescriptor({
      tree: { inputTree: {} },
      name: 'foo',
      packageName: 'fizz',
      treeType: 'app',
      root: '/',
      nodeModulesPath: '/node_modules',
      pkg: {name: 'fizz', version: '1.0.0'}
    });

    var desc2 = new TreeDescriptor({
      tree: { inputTree: {} },
      name: 'bar',
      packageName: 'bizz',
      treeType: 'app',
      root: '/',
      nodeModulesPath: '/node_modules',
      pkg: {name: 'bizz', version: '1.0.0'}
    });

    cache.set('foo', desc1);
    cache.set('bar', desc2);

    expect(Object.keys(cache.all())).to.eql(['foo', 'bar']);
  });

  it('should retrieve trees by a specific type', function() {
    var desc1 = new TreeDescriptor({
      tree: { inputTree: {} },
      name: 'foo',
      packageName: 'fizz',
      treeType: 'app',
      root: '/',
      nodeModulesPath: '/node_modules',
      pkg: {name: 'fizz', version: '1.0.0'}
    });

    var desc2 = new TreeDescriptor({
      tree: { inputTree: {}, __name: 'bar' },
      name: 'bar',
      packageName: 'bizz',
      treeType: 'addon',
      root: '/',
      nodeModulesPath: '/node_modules',
      pkg: {name: 'bizz', version: '1.0.0'}
    });

    cache.set('foo', desc1);
    cache.set('bar', desc2);

    expect(cache.treesByType('addon').length).to.eql(1);
    expect(cache.treesByType('addon')[0].__name).to.eql('bar');
  });

  it('should retrieve descriptors by a specific type', function() {
    var desc1 = new TreeDescriptor({
      tree: { inputTree: {} },
      name: 'foo',
      packageName: 'fizz',
      treeType: 'app',
      root: '/',
      nodeModulesPath: '/node_modules',
      pkg: {name: 'fizz', version: '1.0.0'}
    });

    var desc2 = new TreeDescriptor({
      tree: { inputTree: {}, __name: 'bar' },
      name: 'bar',
      packageName: 'bizz',
      treeType: 'addon',
      root: '/',
      nodeModulesPath: '/node_modules',
      pkg: {name: 'bizz', version: '1.0.0'}
    });

    cache.set('foo', desc1);
    cache.set('bar', desc2);

    expect(cache.descriptorsByType('addon').length).to.eql(1);
    expect(cache.descriptorsByType('addon')[0].name).to.eql('bar');
  });

  it('should remove descriptor', function() {
    var desc1 = new TreeDescriptor({
      tree: { inputTree: {} },
      name: 'foo',
      packageName: 'fizz',
      treeType: 'app',
      root: '/',
      nodeModulesPath: '/node_modules',
      pkg: {name: 'fizz', version: '1.0.0'}
    });

    cache.set('foo', desc1);
    cache.remove('foo');

    expect(Object.keys(cache.store).length).to.eql(0);
  });
});
