/* global escape */
'use strict';

var fs        = require('fs');
var path      = require('path');
var Project   = require('ember-cli/lib/models/project');
var Assembler = require('../../lib/assembler');
var expect    = require('chai').expect;
var stub      = require('ember-cli/tests/helpers/stub').stub;

describe('assembler', function() {
  var project, projectPath, assembler, addonTreesForStub, addon;

  function setupProject(rootPath) {
    var packageContents = require(path.join(rootPath, 'package.json'));

    project = new Project(rootPath, packageContents);
    project.require = function() {
      return function() {};
    };
    project.initializeAddons = function() {
      this.addons = [];
    };

    return project;
  }

  beforeEach(function() {
    projectPath = path.resolve(__dirname, '../fixtures/addon/simple');
    project = setupProject(projectPath);
  });

  describe('constructor', function() {
    it('should override project.configPath if configPath option is specified', function() {
      project.configPath = function() { return 'original value'; };

      new Assembler({
        project: project,
        configPath: 'custom config path'
      });

      expect(project.configPath()).to.equal('custom config path');
    });

    describe('_notifyAddonIncluded', function() {
      beforeEach(function() {
        project.initializeAddons = function() { };
        project.addons = [{name: 'custom-addon'}];
      });

      it('should set the app on the addons', function() {
        var app = new Assembler({
          project: project
        });

        var addon = project.addons[0];
        expect(addon.app).to.deep.equal(app);
      });
    });
  });

  describe('contentFor', function() {
    var config, defaultMatch;

    beforeEach(function() {
      project._addonsInitialized = true;
      project.addons = [];

      assembler = new Assembler({
        project: project
      });

      config = {
        modulePrefix: 'cool-foo'
      };

      defaultMatch = '{{content-for \'head\'}}';
    });

    describe('contentFor from addons', function() {
      it('calls `contentFor` on addon', function() {
        var calledConfig, calledType;

        project.addons.push({
          contentFor: function(type, config) {
            calledType = type;
            calledConfig = config;

            return 'blammo';
          }
        });

        var actual = assembler.contentFor(config, defaultMatch, 'foo');

        expect(calledConfig).to.deep.equal(config);
        expect(calledType).to.equal('foo');
        expect(actual).to.equal('blammo');
      });

      it('calls `contentFor` on each addon', function() {
        project.addons.push({
          contentFor: function() {
            return 'blammo';
          }
        });

        project.addons.push({
          contentFor: function() {
            return 'blahzorz';
          }
        });

        var actual = assembler.contentFor(config, defaultMatch, 'foo');

        expect(actual).to.equal('blammo\nblahzorz');
      });
    });

    describe('contentFor("head")', function() {
      it('includes the `meta` tag in `head` by default', function() {
        var escapedConfig = escape(JSON.stringify(config));
        var metaExpected = '<meta name="cool-foo/config/environment" ' +
                           'content="' + escapedConfig + '" />';
        var actual = assembler.contentFor(config, defaultMatch, 'head');

        expect(true, actual.indexOf(metaExpected) > -1);
      });

      it('does not include the `meta` tag in `head` if storeConfigInMeta is false', function() {
        assembler.options.storeConfigInMeta = false;

        var escapedConfig = escape(JSON.stringify(config));
        var metaExpected = '<meta name="cool-foo/config/environment" ' +
                           'content="' + escapedConfig + '" />';
        var actual = assembler.contentFor(config, defaultMatch, 'head');

        expect(true, actual.indexOf(metaExpected) === -1);
      });

      it('includes the `base` tag in `head` if locationType is auto', function() {
        config.locationType = 'auto';
        config.baseURL = '/';
        var expected = '<base href="/" />';
        var actual = assembler.contentFor(config, defaultMatch, 'head');

        expect(true, actual.indexOf(expected) > -1);
      });

      it('includes the `base` tag in `head` if locationType is none (testem requirement)', function() {
        config.locationType = 'none';
        config.baseURL = '/';
        var expected = '<base href="/" />';
        var actual = assembler.contentFor(config, defaultMatch, 'head');

        expect(true, actual.indexOf(expected) > -1);
      });

      it('does not include the `base` tag in `head` if locationType is hash', function() {
        config.locationType = 'hash';
        config.baseURL = '/foo/bar';
        var expected = '<base href="/foo/bar/" />';
        var actual = assembler.contentFor(config, defaultMatch, 'head');

        expect(true, actual.indexOf(expected) === -1);
      });
    });

    describe('contentFor("config-module")', function() {
      it('includes the meta gathering snippet by default', function() {
        var expected = fs.readFileSync('./node_modules/ember-cli/lib/broccoli/app-config-from-meta.js', 'utf8');

        var actual = assembler.contentFor(config, defaultMatch, 'config-module');

        expect(true, actual.indexOf(expected) > -1);
      });

      it('includes the raw config if storeConfigInMeta is false', function() {
        assembler.options.storeConfigInMeta = false;

        var expected = JSON.stringify(config);
        var actual = assembler.contentFor(config, defaultMatch, 'config-module');

        expect(true, actual.indexOf(expected) > -1);
      });
    });

    it('has no default value other than `head`', function() {
      expect(assembler.contentFor(config, defaultMatch, 'foo')).to.equal('');
      expect(assembler.contentFor(config, defaultMatch, 'body')).to.equal('');
      expect(assembler.contentFor(config, defaultMatch, 'blah')).to.equal('');
    });
  });

  describe('addons', function() {
    describe('included hook', function() {
      it('included hook is called properly on instantiation', function() {
        var called = false;
        var passedApp;

        addon = {
          included: function(app) { called = true; passedApp = app; },
          treeFor: function() { }
        };

        project.initializeAddons = function() {
          this.addons = [ addon ];
        };

        assembler = new Assembler({
          project: project
        });

        expect(true, called);
        expect(passedApp).to.equal(assembler);
      });

      it('does not throw an error if the addon does not implement `included`', function() {
        delete addon.included;

        project.initializeAddons = function() {
          this.addons = [ addon ];
        };

        expect(function() {
          assembler = new Assembler({
            project: project
          });
        }).to.not.throw(/addon must implement the `included`/);
      });
    });

    describe('addonTreesFor', function() {
      beforeEach(function() {
        addon = {
          included: function() { },
          treeFor: function() { }
        };

        project.initializeAddons = function() {
          this.addons = [ addon ];
        };

      });

      it('addonTreesFor returns an empty array if no addons return a tree', function() {
        assembler = new Assembler({
          project: project
        });

        expect(assembler.addonTreesFor('blah')).to.deep.equal([]);
      });

      it('addonTreesFor calls treesFor on the addon', function() {
        assembler = new Assembler({
          project: project
        });

        var sampleAddon = project.addons[0];
        var actualTreeName;

        sampleAddon.treeFor = function(name) {
          actualTreeName = name;

          return 'blazorz';
        };

        expect(assembler.addonTreesFor('blah')).to.deep.equal(['blazorz']);
        expect(actualTreeName).to.equal('blah');
      });

      it('addonTreesFor does not throw an error if treeFor is not defined', function() {
        delete addon.treeFor;

        assembler = new Assembler({
          project: project
        });

        expect(function() {
          assembler.addonTreesFor('blah');
        }).not.to.throw(/addon must implement the `treeFor`/);
      });

      describe('addonTreesFor is called properly', function() {
        beforeEach(function() {
          assembler = new Assembler({
            project: project
          });

          addonTreesForStub = stub(assembler, 'addonTreesFor', ['batman']);
        });

        it('_processedAppTree calls addonTreesFor', function() {
          assembler._processedAppTree();

          expect(addonTreesForStub.calledWith[0][0]).to.equal('app');
        });

        it('styles calls addonTreesFor and merges with overwrite', function() {
          assembler.styles();

          expect(addonTreesForStub.calledWith[0][0]).to.equal('styles');
          //expect(true, trees.inputTrees[0].inputTree.inputTrees.indexOf('batman') !== -1, 'contains addon tree');
          //expect(trees.inputTrees[0].inputTree.options.overwrite).to.equal(true);
        });
      });
    });

    describe('import', function() {
      it('creates a legacy tree', function() {
        assembler = new Assembler({
        });
        assembler.import('vendor/moment.js', {type: 'vendor', exports: { moment: ['default'] } });
        expect(assembler.legacyImports.length).to.eql(1);
      });
    });

    describe('isEnabled is called properly', function() {
      beforeEach(function() {
        projectPath = path.resolve(__dirname, '../fixtures/addon/env-addons');
        var packageContents = require(path.join(projectPath, 'package.json'));
        project = new Project(projectPath, packageContents);
      });

      afterEach(function() {
        process.env.EMBER_ENV = undefined;
      });

      describe('with environment', function() {
        it('development', function() {
          process.env.EMBER_ENV = 'development';
          assembler = new Assembler({ project: project });
          expect(assembler.project.addons.length).to.equal(5);
        });

        it('foo', function() {
          process.env.EMBER_ENV = 'foo';
          assembler = new Assembler({ project: project });

          expect(assembler.project.addons.length).to.equal(6);
        });
      });

    });
  });
});