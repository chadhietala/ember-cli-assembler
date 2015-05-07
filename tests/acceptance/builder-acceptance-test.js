'use strict';

var Builder = require('../../lib/builder');
var broccoli = require('broccoli');
var path = require('path');
var expect = require('chai').expect;
var mergeTrees = require('broccoli-merge-trees');
var fs = require('fs');
var walkSync = require('walk-sync');

describe('Acceptance: Builder', function() {
  var cwd = process.cwd(),
      dummy = path.join(cwd, 'tests', 'fixtures', 'dummy'),
      build,
      builder;

  before(function() {
    process.stdout.setMaxListeners(0);
  });

  beforeEach(function() {
    process.chdir(dummy);
  });

  afterEach(function() {
    process.chdir(cwd);

    if (builder) {
      builder = null;
    }
    
    if (build) {
      return build.cleanup();
    }
  });

  it('should prime the builder with trees and options', function() {
    builder = new Builder();
    expect(builder.trees).to.be.an('object');
    expect(builder.options).to.be.an('object');
  });

  it('should create an array of trees', function() {
    builder = new Builder();
    var trees = builder.toTree();
    expect(trees).to.be.an('array');
  });

  it('addons should not override the consuming applications files if the same file exists', function () {
    builder = new Builder();
    var trees = builder.toTree();
    build = new broccoli.Builder(mergeTrees(trees));
    return build.build().then(function(results) {
      var basePath = path.join(results.directory, 'dummy/components');
      var containsAddon = fs.readFileSync(path.join(basePath, 'foo-bar.js'), 'utf8').indexOf('fromAddon') > -1;
      expect(!containsAddon).to.eql(true);
      containsAddon = fs.readFileSync(path.join(basePath, 'baz-bar.js'), 'utf8').indexOf('fromAddon') > -1;
      expect(containsAddon).to.eql(true);
    }); 
  });

  it('should have the index.html', function() {
    builder = new Builder();
    var trees = builder.toTree();
    build = new broccoli.Builder(mergeTrees(trees));
    return build.build().then(function(results) {
      var files = walkSync(results.directory);
      expect(files.indexOf('dummy/index.html') > -1).to.be.eql(true);
    });
  });

  it('should include the addon directory', function () {
    builder = new Builder();
    var trees = builder.toTree();
    build = new broccoli.Builder(mergeTrees(trees));
    return build.build().then(function(results) {
      var files = walkSync(results.directory);
      var folders = files.filter(function(item) {
        return item.slice(-1) === '/' && item.split('/').length === 2;
      });
      expect(folders).to.deep.eql(['dummy/', 'dummy-tests/', 'ember-cli-ember/']);
    });
  });

  it('should preprocess templates with an installed pre-processor', function () {
    builder = new Builder();
    var trees = builder.toTree();
    build = new broccoli.Builder(mergeTrees(trees));
    return build.build().then(function(results) {
      var expected = fs.readFileSync(path.resolve('..', '..', 'expectations/templates/application.js'), 'utf8');
      var assertion = fs.readFileSync(results.directory + '/dummy/templates/application.js', 'utf8');
      expect(expected).to.eql(assertion);  
    });
  });

  it('should contain tests if environment is development', function () {
    builder = new Builder();
    var trees = builder.toTree();
    build = new broccoli.Builder(mergeTrees(trees));
    return build.build().then(function(results) {
      var files = walkSync(results.directory);
      var expectactions = [
        'dummy-tests/',
        'dummy-tests/dep-graph.json',
        'dummy-tests/unit/',
        'dummy-tests/unit/components/',
        'dummy-tests/unit/components/foo-bar-test.js'
      ];
      expect(builder.env).to.eql('development');
      expectactions.forEach(function(file) {
        expect(files.indexOf(file) > -1).to.eql(true);
      });
    });
  });

  it('should contain the test index', function() {
    builder = new Builder();
    var trees = builder.toTree();
    build = new broccoli.Builder(mergeTrees(trees));
    return build.build().then(function(results) {
      var files = walkSync(results.directory);
      expect(files.indexOf('dummy-tests/index.html') > -1).to.eql(true);
    });
  });

  it('should not contain tests from the addon', function () {
    builder = new Builder();
    var trees = builder.toTree();
    build = new broccoli.Builder(mergeTrees(trees));
    return build.build().then(function(results) {
      var files = walkSync(results.directory);
      var expectactions = [
        'ember-cli-ember-tests/',
        'ember-cli-ember-tests/dep-graph.json',
        'ember-cli-ember-tests/unit/',
        'ember-cli-ember-tests/ember-test.js'
      ];
      expect(builder.env).to.eql('development');
      expectactions.forEach(function(file) {
        expect(files.indexOf(file) > -1).to.eql(false);
      });
    });
  });

  it('should include styles', function() {
    builder = new Builder();
    var trees = builder.toTree();
    build = new broccoli.Builder(mergeTrees(trees));
    return build.build().then(function(results) {
      var files = walkSync(results.directory);
      expect(files.indexOf('dummy/styles/foo.css') > -1).to.eql(true);
    });
  });

  it('styles should have gone through the preprocessor', function() {
    builder = new Builder();
    var trees = builder.toTree();
    build = new broccoli.Builder(mergeTrees(trees));
    return build.build().then(function(results) {
      var expected = fs.readFileSync(path.resolve('..', '..', 'expectations/styles/foo.css'), 'utf8');
      var assertion = fs.readFileSync(results.directory + '/dummy/styles/foo.css', 'utf8');
      expect(expected).to.eql(assertion);
    });
  });
});