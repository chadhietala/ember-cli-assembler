'use strict';

var Builder = require('../../lib/builder');
var path = require('path');
var expect = require('chai').expect;

describe.only('Acceptance: Builder', function() {
  var cwd = process.cwd(),
      dummy = path.join(cwd, 'tests', 'fixtures', 'dummy'),
      builder;

  beforeEach(function() {
    process.chdir(dummy);
  });

  afterEach(function() {
    process.chdir(cwd);
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
    expect(trees.length).to.eql(5);
  });

});