'use strict';

var Assembler = require('../../lib/assembler');
var broccoli = require('broccoli');
var path = require('path');
var expect = require('chai').expect;
var mergeTrees = require('broccoli-merge-trees');
var fs = require('fs');
var walkSync = require('walk-sync');

function verifyFiles(files, expected) {
  expected.forEach(function(file) {
    expect(files.indexOf(file) > -1).to.be.ok;
  });
}

describe('Acceptance: Assembler', function() {
  var cwd = process.cwd(),
      dummy = path.join(cwd, 'tests', 'fixtures', 'dummy'),
      build,
      assembler;

  before(function() {
    process.stdout.setMaxListeners(0);
  });

  beforeEach(function() {
    process.chdir(dummy);
  });

  afterEach(function() {
    process.chdir(cwd);

    if (assembler) {
      assembler = null;
    }

    if (build) {
      return build.cleanup();
    }
  });

  it('should prime the assembler with trees and options', function() {
    assembler = new Assembler();
    expect(assembler.trees).to.be.an('object');
    expect(assembler.options).to.be.an('object');
  });

  it('should create an array of trees', function() {
    assembler = new Assembler();
    var trees = assembler.toTree();
    expect(trees).to.be.an('array');
  });

  it('addons should not override the consuming applications files if the same file exists', function () {
    assembler = new Assembler();
    var trees = assembler.toTree();
    build = new broccoli.Builder(mergeTrees(trees, { overwrite: true }));
    return build.build().then(function(results) {
      var basePath = path.join(results.directory, 'dummy/components');
      var containsAddon = fs.readFileSync(path.join(basePath, 'foo-bar.js'), 'utf8').indexOf('fromAddon') > -1;
      expect(!containsAddon).to.eql(true);
      containsAddon = fs.readFileSync(path.join(basePath, 'baz-bar.js'), 'utf8').indexOf('fromAddon') > -1;
      expect(containsAddon).to.eql(true);
    });
  });

  it('should have the index.html', function() {
    assembler = new Assembler();
    var trees = assembler.toTree();
    build = new broccoli.Builder(mergeTrees(trees, { overwrite: true }));
    return build.build().then(function(results) {
      var files = walkSync(results.directory);
      expect(files.indexOf('dummy/index.html') > -1).to.be.eql(true);
    });
  });

  it('should contain a dep-graph.json per tree', function() {
    assembler = new Assembler();
    var trees = assembler.toTree();
    build = new broccoli.Builder(mergeTrees(trees, { overwrite: true }));
    return build.build().then(function(results) {
      var files = walkSync(results.directory);
      expect(files.indexOf('dep-graph.json') > -1).to.be.eql(true);
    });
  });

  it('should allow for both addon structures', function() {
    assembler = new Assembler();
    var trees = assembler.toTree();
    build = new broccoli.Builder(mergeTrees(trees, { overwrite: true }));
    return build.build().then(function(results) {
      var files = walkSync(results.directory).filter(function(relativePath) {
        return relativePath.slice(-1) !== '/';
      });

      var newAddonStructure = ['ember.js', 'ember/resolver.js'];
      var newScopedAddonStructure = [
        '@scoped/some-other-package/bizz.js',
        '@scoped/some-other-package/helpers/t.js',
        '@scoped/some-other-package.js',
        '@scoped/some-package/helpers/t.js',
        '@scoped/some-package/bizz.js',
        '@scoped/some-package.js'
      ];
      var legacyAddonStructure = [
        'ember-cli-current-addon.js',
        'ember-cli-current-addon/foo.js',
        'ember-cli-current-addon/index.js'
      ];
      var legacyScopedStructure = [
        '@scoped/ember-scoped-legacy.js',
        '@scoped/ember-scoped-legacy/index.js',
        '@scoped/ember-scoped-legacy/helpers/foo.js'
      ];
      var noReexportNewStructure = [
        'no-reexport-new-structure/fizz.js',
        'no-reexport-new-structure/structure/fizz.js'
      ];
      var legacyWithoutReexport = [
        'legacy-without-reexport/filters/jobs.js',
        'legacy-without-reexport/foo.js'
      ];
      var legacyScopedWithoutReexport = [
        '@scoped/scoped-legacy-without-reexport/fizz.js',
        '@scoped/scoped-legacy-without-reexport/helpers/boo.js'
      ];

      verifyFiles(files, legacyScopedWithoutReexport);
      verifyFiles(files, newAddonStructure);
      verifyFiles(files, newScopedAddonStructure);
      verifyFiles(files, legacyAddonStructure);
      verifyFiles(files, legacyScopedStructure);
      verifyFiles(files, noReexportNewStructure);
      verifyFiles(files, legacyWithoutReexport);
    });
  });

  it('should include ember from the addon directory', function () {
    assembler = new Assembler();
    var trees = assembler.toTree();
    build = new broccoli.Builder(mergeTrees(trees, { overwrite: true }));
    return build.build().then(function(results) {
      var files = walkSync(results.directory);
      var folders = files.filter(function(item) {
        return item.slice(-1) === '/' && item.split('/').length === 2;
      });

      expect(files.indexOf('ember.js') > 0).to.eql(true);
      expect(folders).to.deep.eql([
        '@scoped/',
        '__packager__/',
        'dummy/',
        'ember/',
        'ember-cli-current-addon/',
        'legacy-without-reexport/',
        'no-reexport-new-structure/'
      ]);
    });
  });

  it('should preprocess templates with an installed pre-processor', function () {
    assembler = new Assembler();
    var trees = assembler.toTree();
    build = new broccoli.Builder(mergeTrees(trees, { overwrite: true }));
    return build.build().then(function(results) {
      var expected = fs.readFileSync(path.resolve('..', '..', 'expectations/templates/application.js'), 'utf8');
      var assertion = fs.readFileSync(results.directory + '/dummy/templates/application.js', 'utf8');
      expect(expected).to.eql(assertion);
    });
  });

  it('should contain tests if environment is development', function () {
    assembler = new Assembler();
    var trees = assembler.toTree();
    build = new broccoli.Builder(mergeTrees(trees, { overwrite: true }));
    return build.build().then(function(results) {
      var files = walkSync(results.directory);

      var expectactions = [
        'dummy/tests/',
        'dummy/tests/index.html',
        'dummy/tests/testem.js',
        'dummy/tests/unit/',
        'dummy/tests/unit/components/',
        'dummy/tests/unit/components/foo-bar-test.js',
      ];

      expect(assembler.env).to.eql('development');
      expectactions.forEach(function(file) {
        expect(files.indexOf(file) > -1).to.eql(true);
      });
    });
  });

  it('should contain the test index', function() {
    assembler = new Assembler();
    var trees = assembler.toTree();
    build = new broccoli.Builder(mergeTrees(trees, { overwrite: true }));
    return build.build().then(function(results) {
      var files = walkSync(results.directory);
      expect(files.indexOf('dummy/tests/index.html') > -1).to.eql(true);
    });
  });

  it('should not contain tests from the addon', function () {
    assembler = new Assembler();
    var trees = assembler.toTree();
    build = new broccoli.Builder(mergeTrees(trees, { overwrite: true }));
    return build.build().then(function(results) {
      var files = walkSync(results.directory);
      var expectactions = [
        'ember-cli-ember-tests/',
        'ember-cli-ember-tests/dep-graph.json',
        'ember-cli-ember-tests/unit/',
        'ember-cli-ember-tests/ember-test.js'
      ];
      expect(assembler.env).to.eql('development');
      expectactions.forEach(function(file) {
        expect(files.indexOf(file) > -1).to.eql(false);
      });
    });
  });

  it('should include styles', function() {
    assembler = new Assembler();
    var trees = assembler.toTree();
    build = new broccoli.Builder(mergeTrees(trees, { overwrite: true }));
    return build.build().then(function(results) {
      var files = walkSync(results.directory);
      expect(files.indexOf('dummy/styles/foo.css') > -1).to.eql(true);
    });
  });

  it('styles should have gone through the preprocessor', function() {
    assembler = new Assembler();
    var trees = assembler.toTree();
    build = new broccoli.Builder(mergeTrees(trees, { overwrite: true }));
    return build.build().then(function(results) {
      var expected = fs.readFileSync(path.resolve('..', '..', 'expectations/styles/foo.css'), 'utf8');
      var assertion = fs.readFileSync(results.directory + '/dummy/styles/foo.css', 'utf8');
      expect(expected).to.eql(assertion);
    });
  });
});
