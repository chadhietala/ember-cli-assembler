/* global module, escape */
'use strict';

var SilentError  = require('ember-cli/lib/errors/silent');
var ES3SafeFilter = require('broccoli-es3-safe-recast');
var upstreamMergeTrees = require('broccoli-merge-trees');
var cleanBaseURL = require('ember-cli/lib/utilities/clean-base-url');
var Project = require('ember-cli/lib/models/project');
var preprocessors = require('ember-cli/lib/preprocessors');
var merge = require('lodash-node/modern/object/merge');
var defaults = require('lodash-node/modern/object/defaults');
var fs = require('fs');
var path = require('path');
var unwatchedTree = require('broccoli-unwatched-tree');
var configLoader = require('ember-cli/lib/broccoli/broccoli-config-loader');
var configReplace = require('ember-cli/lib/broccoli/broccoli-config-replace');
var ES6Modules = require('broccoli-es6modules');
var stew = require('broccoli-stew');
var funnel = require('broccoli-funnel');
var preprocessJs  = preprocessors.preprocessJs;
var preprocessTemplates = preprocessors.preprocessTemplates;
var preprocessCss = preprocessors.preprocessCss;
var preprocessMinifyCss = preprocessors.preprocessMinifyCss;
var rename = stew.rename;
var mv = stew.mv;
var find = stew.find;
var rm = stew.rm;

function zipTrees(trees1, trees2) {
  return trees1.map(function(tree1, i) {
    var tree2 = trees2[i];
    var tree = mergeTrees([tree1, tree2]);
    tree.name = tree2.name;
    return tree;
  });
}

function mergeTrees(inputTree, options) {
  var tree = upstreamMergeTrees(inputTree, options);
  tree.description = options && options.description;
  return tree;
}

function flatten(arr) {
  return [].concat.apply([], arr);
}

function Builder(options) {
  options = options || {};

  this._initProject(options);

  this.env  = Builder.env();
  this.name = options.name || this.project.name();
  this.registry = options.registry || preprocessors.defaultRegistry(this);

  var isProduction = this.env === 'production';

  this._initTestsAndHinting(options, isProduction);
  this._initOptions(options, isProduction);
  this.trees = this.options.trees;
  this.testPath = this.name + '/' + this.trees.tests;

  preprocessors.setupRegistry(this);
  this._notifyAddonIncluded();
}

// TODO needs better deprecation
Builder.prototype.import = function(file) {
  console.log('[Deprecated]', file);
};

Builder.prototype._initProject = function(options) {
  this.project = options.project || Project.closestSync(process.cwd());

  if (options.configPath) {
    this.project.configPath = function() { return options.configPath; };
  }
};

Builder.prototype._initTestsAndHinting = function(options, isProduction) {
  var testsEnabledDefault = process.env.EMBER_CLI_TEST_COMMAND || !isProduction;

  this.tests   = options.hasOwnProperty('tests')   ? options.tests   : testsEnabledDefault;
  this.hinting = options.hasOwnProperty('hinting') ? options.hinting : testsEnabledDefault;
};

Builder.prototype._initOptions = function(options, isProduction) {
  this.options = merge(options, {
    es3Safe: true,
    storeConfigInMeta: true,
    autoRun: true,
    outputPaths: {},
    minifyCSS: {
      enabled: !!isProduction,
      options: { relativeTo: 'app/styles' }
    },
    minifyJS: {
      enabled: !!isProduction,
    },
    sourcemaps: {},
    trees: {},
    jshintrc: {},
    'ember-cli-qunit': {
      disableContainerStyles: false
    }
  }, defaults);

  // TODO
  // Do we really need this
  this.options.outputPaths = merge(this.options.outputPaths, {
    app: {
      html: 'index.html',
      css: {
        'app': '/assets/' + this.name + '.css'
      },
      js: '/assets/' + this.name + '.js'
    },
    vendor: {
      css: '/assets/vendor.css',
      js: '/assets/vendor.js'
    }
  }, defaults);

  this.options.sourcemaps = merge(this.options.sourcemaps, {
    enabled: !isProduction,
    extensions: ['js']
  }, defaults);

  this.options.trees = merge(this.options.trees, {
    app:       'app',
    tests:     'tests',
    styles:    unwatchedTree('app/styles'),
    templates: fs.existsSync('app/templates') ? unwatchedTree('app/templates') : null,
    vendor: fs.existsSync('vendor') ? unwatchedTree('vendor') : null,
    public: fs.existsSync('public') ? 'public' : null
  }, defaults);

  this.options.jshintrc = merge(this.options.jshintrc, {
    app: this.project.root,
    tests: path.join(this.project.root, 'tests'),
  }, defaults);
};

Builder.prototype._notifyAddonIncluded = function() {
  this.initializeAddons();
  this.project.addons = this.project.addons.filter(function(addon) {
    addon.app = this;

    if (!addon.isEnabled || addon.isEnabled()) {

      if (addon.included) {
        addon.included(this);
      }

      return addon;
    }
  }, this);
};

Builder.prototype.initializeAddons = function() {
  this.project.initializeAddons();
};

Builder.prototype._configTree = function() {
  if (this._cachedConfigTree) {
    return this._cachedConfigTree;
  }

  var configPath = this.project.configPath();
  var configTree = configLoader(path.dirname(configPath), {
    env: this.env,
    tests: this.tests,
    project: this.project
  });

  this._cachedConfigTree = mv(configTree, this.name + '/config');
  return this._cachedConfigTree;
};

Builder.prototype._contentForHead = function(content, config) {
  content.push(calculateBaseTag(config));

  if (this.options.storeConfigInMeta) {
    content.push('<meta name="' + config.modulePrefix + '/config/environment" ' +
                 'content="' + escape(JSON.stringify(config)) + '" />');
  }
};

Builder.prototype._contentForConfigModule = function(content, config) {
  if (this.options.storeConfigInMeta) {
    content.push('var prefix = \'' + config.modulePrefix + '\';');
    content.push(fs.readFileSync(path.join(__dirname,'..', 'node_modules/ember-cli/lib/broccoli/app-config-from-meta.js')));
  } else {
    content.push('return { \'default\': ' + JSON.stringify(config) + '};');
  }
};

Builder.prototype.contentFor = function(config, match, type) {
  var content = [];

  switch (type) {
    case 'head':          this._contentForHead(content, config);         break;
    case 'config-module': this._contentForConfigModule(content, config); break;
    case 'app-boot':      this._contentForAppBoot(content, config);      break;
  }

  content = this.project.addons.reduce(function(content, addon) {
    var addonContent = addon.contentFor ? addon.contentFor(type, config) : null;
    if (addonContent) {
      return content.concat(addonContent);
    }

    return content;
  }, content);

  return content.join('\n');
};

Builder.prototype._contentForAppBoot = function(content, config) {
  content.push('if (runningTests) {');
  content.push('  require("' +
    config.modulePrefix +
    '/tests/index");');
  if (this.options.autoRun) {
    content.push('} else {');
    content.push('  require("' +
      config.modulePrefix +
      '/app")["default"].create(' +
      calculateAppConfig(config) +
      ');');
  }
  content.push('}');
};

Builder.prototype.dependencies = function(pkg) {
  return this.project.dependencies(pkg);
};

Builder.prototype.testIndex = function() {
  return mv(configReplace(this.trees.tests, this._configTree(), {
    configPath: path.join(this.name, 'config', 'environments', 'test.json'),
    files: [ 'index.html' ],
    env: 'test',
    patterns: this._configReplacePatterns()
  }), this.testPath);
};

Builder.prototype.testFiles = function() {
  var testemTree = unwatchedTree(path.join(__dirname, '..', 'node_modules/ember-cli/lib/broccoli'));
  // var testSupportPath = this.options.outputPaths.testSupport.js;
  // testSupportPath = testSupportPath.testSupport || testSupportPath;

  var testem = funnel(testemTree, {
    files: ['testem.js'],
    destDir: this.testPath
  });

  // var testSupport = funnel(testSupportPath);

  if (this.options.fingerprint && this.options.fingerprint.exclude) {
    this.options.fingerprint.exclude.push('testem');
  }

  return [
    testem
    // testSupport
  ];
};

Builder.prototype.index = function() {
  var htmlName = this.options.outputPaths.app.html;
  var index = rename(this.trees.app, function(relativePath) {
    return relativePath === 'index.html' ? htmlName : relativePath;
  });

  var self = this;

  return mv(configReplace(index, this._configTree(), {
    configPath: path.join(this.name, 'config', 'environments', this.env + '.json'),
    files: [ htmlName ],
    patterns: this._configReplacePatterns()
  }), self.name + '/');
};

Builder.prototype.addonTreesFor = function(type) {
  return this.project.addons.map(function(addon) {
    if (addon.treeFor) {
      var tree = addon.treeFor(type);
      
      if (tree && addon.pkg) {
        tree.name = addon.pkg.name;
      }

      return tree;
    }
  }, this).filter(Boolean);
};

Builder.prototype._podTemplatePatterns = function() {
  return this.registry.extensionsForType('template').map(function(extension) {
    return new RegExp('template.' + extension + '$');
  });
};

Builder.prototype._filterAppTree = function() {
  if (this._cachedFilterAppTree) {
    return this._cachedFilterAppTree;
  }

  var podPatterns = this._podTemplatePatterns();
  var excludePatterns = podPatterns.concat([
    // note: do not use path.sep here Funnel uses
    // walk-sync which always joins with `/` (not path.sep)
    new RegExp('^styles/'),
    new RegExp('^templates/'),
  ]);

  return this._cachedFilterAppTree = find(this.trees.app, {
    exclude: excludePatterns
  });
};

// Merges an addons app directory with the consuming app
Builder.prototype._processedAppTree = function() {
  var filteredAddons = this.addonTreesFor('app').concat(this._filterAppTree());
  return mv(mergeTrees(filteredAddons, {
    overwrite: true,
    description: 'TreeMerger (app)'
  }), this.name);
};

Builder.prototype._processedTemplatesTree = function() {
  var addonTrees = this.addonTreesFor('templates');
  var addonPodTemplates = find(this.addonTreesFor('app'), 'pods/**/template.*');
  var mergedTrees = this.trees.templates ? addonTrees.concat(this.trees.templates) : addonTrees;
  var mergedTemplates = mergeTrees(mergedTrees, {
    overwrite: true,
    description: 'TreeMerger (templates)'
  });

  var standardTemplates = mv(mergedTemplates, this.name + '/templates');

  var podTemplates = mv(find(mergeTrees([addonPodTemplates, this.trees.app], {
    overwrite: true
  }), {
    include: this._podTemplatePatterns(),
    exclude: [ /^templates/ ]
  }), this.name + '/');

  return preprocessTemplates(mergeTrees([standardTemplates, podTemplates]), {
    registry: this.registry,
    description: 'TreeMerger (pod & standard templates)'
  });
};

Builder.prototype.addonPostprocessTree = function(type, tree) {
  var workingTree = tree;
  this.project.addons.forEach(function(addon) {
    if (addon.postprocessTree) {
      workingTree = addon.postprocessTree(type, workingTree);
    }
  });
  return workingTree;
};

Builder.prototype.addonLintTree = function(type, tree) {
  var output = [];
  this.project.addons.forEach(function(addon) {
    if (addon.lintTree) {
      output.push(addon.lintTree(type, tree));
    }
  });
  return mergeTrees(output,{
    overwrite: true,
    description: 'TreeMerger (lint)'
  });
};

Builder.prototype.appJavascript = function() {
  var app = this._processedAppTree();
  var templates = this._processedTemplatesTree();

  if (!this.registry.availablePlugins['ember-cli-babel'] && this.options.es3Safe) {
    app = new ES3SafeFilter(app);
  }

  var preprocessedApp = preprocessJs(app, '/', this.name, {
    registry: this.registry
  });

  var postprocessedApp = this.addonPostprocessTree('js', preprocessedApp);

  return mergeTrees([postprocessedApp, templates]);
};

Builder.prototype.addonJavascript = function() {
  return this.addonTreesFor('addon');
};

Builder.prototype._processedTestsTree = function() {
    var testSupport = this.addonTreesFor('test-support').map(function(tree) {
      return mv(tree, '/test-support');
    }, this);
  return mv(mergeTrees(testSupport.concat(this.trees.tests)), this.testPath);
};

Builder.prototype.appTests = function() {
  var testTrees = [];

  if (this.tests) {
    var tests = this._processedTestsTree();

    var preprocessedTests = preprocessJs(tests, '/tests', this.testPath, {
      registry: this.registry
    });

    preprocessedTests.name = this.testPath;

    testTrees.push(preprocessedTests);
  }

  return testTrees;
};

Builder.prototype.packagerFiles = function() {
  if (this._cachedEtherFiles) {
    return this._cachedEtherFiles;
  }

  var envFilePath = this.name + '/config/environment.js';

  // TODO we need the loader in here
  var files = [
    'environment.js',
    'vendor-prefix.js',
    'vendor-suffix.js',
    'app-prefix.js',
    'app-suffix.js',
    'app-boot.js',
    'test-support-prefix.js',
    'test-support-suffix.js'
  ];

  var inputTree = unwatchedTree(path.join(__dirname, '..', 'node_modules/ember-cli/lib/broccoli'));

  var packagerFiles = configReplace(inputTree, this._configTree(), {
    configPath: path.join(this.name, 'config', 'environments', this.env + '.json'),
    files: files,
    patterns: this._configReplacePatterns()
  });

  packagerFiles = funnel(packagerFiles, {
    files: files,
    srcDir: '/',
    destDir: '/__packager__'
  });

  var envFile = rename(find(packagerFiles, { include: ['__packager__/environment.js'] }), function() {
    return envFilePath;
  });

  packagerFiles = rm(packagerFiles, '__packager__/environment.js');

  return mergeTrees([packagerFiles, envFile]);
};

Builder.prototype.dist = function() {
  return this.addonTreesFor('dist');
};

Builder.prototype.setAddonLoadPath = function(tree, name) {
  var self = this;

  return rename(tree, function(relativePath) {
    var parts = relativePath.split('/');
    if (relativePath === name + '/dep-graph.json') {
      return relativePath;
    } else if (relativePath.slice(-1) !== '/' && parts[0] !== self.name) {
      if (parts.length > 1) {
        parts.shift();
        return parts.join('/');
      }
      return relativePath;
    }
    return relativePath;
  });
};

Builder.prototype.transpileTree = function(tree) {
  return new ES6Modules(tree, {
    description: 'ES6: App Tree',
    extensions: ['js'],
    exportDepGraph: true,
    esperantoOptions: {
      absolutePaths: true,
      strict: true,
      _evilES3SafeReExports: this.options.es3Safe
    }
  });
};

Builder.prototype.javascript = function() {
  var appTrees = [];
  var packagerFiles = this.packagerFiles();
  var appJavascript = this.appJavascript();
  var appTests;

  appJavascript.name = this.name;
  packagerFiles.name = '__packager__';
  appTests = this.appTests();

  appTrees = appTrees.concat(
    appJavascript,
    appTests
  );

  var transpiledAppTrees = appTrees.map(function(tree) {
    var name = tree.name;
    var depGraph = '/dep-graph.json';
    var transpiledTree = this.transpileTree(tree);

    if (name === this.testPath) {
      transpiledTree = mv(transpiledTree, this.name + depGraph, this.testPath + depGraph);
    }

    transpiledTree.name = name;

    return transpiledTree;
  }, this).concat(packagerFiles);

  var transpiledAddonTrees = this.addonJavascript().map(function(tree) {
    var name = tree.name;
    var transpiledTree = this.transpileTree(this.setAddonLoadPath(tree, name));
    transpiledTree.name = name;
    return transpiledTree;
  }, this);

  var addonTrees = zipTrees(this.dist(), transpiledAddonTrees);
  var trees = transpiledAppTrees.concat(addonTrees);
  return trees;
};

Builder.prototype._configReplacePatterns = function() {
  return [{
    match: /\{\{EMBER_ENV\}\}/g,
    replacement: calculateEmberENV
  }, {
    match: /\{\{content-for ['"](.+)["']\}\}/g,
    replacement: this.contentFor.bind(this)
  }, {
    match: /\{\{MODULE_PREFIX\}\}/g,
    replacement: calculateModulePrefix
  }];
};

Builder.prototype.publicTree = function() {
  var trees = this.addonTreesFor('public');

  if (this.trees.public) {
    trees.push(this.trees.public);
  }

  return mv(mergeTrees(trees, {
    overwrite: true,
    description: 'TreeMerger (public)'
  }), this.name + '/');
};

Builder.prototype.styles = function() {
  if (fs.existsSync('app/styles/' + this.name + '.css')) {
    throw new SilentError('Style file cannot have the name of the application - ' + this.name);
  }

  var styleTrees = [];
  styleTrees = styleTrees.concat(
    this.addonTreesFor('styles'),
    this.trees.styles
  );

  var styles = mergeTrees(styleTrees, {
    description: 'TreeMerger (stylesAndAddons)',
    overwrite: true
  });

  var options = { outputPaths: this.options.outputPaths.app.css };

  options.registry = this.registry;

  var preprocessedStyles = preprocessCss(styles, '/', this.name + '/', options);

  if (this.options.minifyCSS.enabled === true) {
    options = this.options.minifyCSS.options || {};
    options.registry = this.registry;
    preprocessedStyles = preprocessMinifyCss(preprocessedStyles, options);
  }

  return mv(this.addonPostprocessTree('css', preprocessedStyles), this.name + '/styles');
};

Builder.prototype.collectTreeDescriptors = function() {
  var treeDescriptors = {};
  var appName = this.project.pkg.name;
  var appTest = appName + '/tests';
  var appAndTests = [appName, appTest];

  this.project.addons.forEach(function(addon) {
    treeDescriptors[addon.pkg.name] = {
      packageName: addon.pkg.name,
      root: addon.root,
      pkg: addon.pkg,
      nodeModulesPath: addon.nodeModulesPath
    };
    if (addon.parent) {
      treeDescriptors[addon.pkg.name].parent = {
        packageName: addon.parent.name(),
        pkg: addon.parent.pkg,
        root: addon.parent.root,
        nodeModulesPath: addon.parent.nodeModulesPath
      };
    }
  });

  appAndTests.forEach(function(name) {
    treeDescriptors[name] = {
      packageName: name,
      pkg: this.project.pkg,
      root: this.project.root,
      nodeModulesPath: this.project.nodeModulesPath
    };
  }, this);

  treeDescriptors['__packager__'] = {};

  this.treeDescriptors = treeDescriptors;
};

Builder.prototype.toArray = function() {
  var sourceTrees = [
    this.index(),
    this.javascript(),
    this.publicTree(),
    this.styles()
  ];

  if (this.tests) {
    sourceTrees = sourceTrees.concat(this.testIndex(), this.testFiles());
  }

  this.collectTreeDescriptors();

  return sourceTrees;
};

Builder.prototype.toTree = function(additionalTrees) {
  return flatten(this.toArray()).concat(additionalTrees || []);
};

Builder.env = function() {
  return process.env.EMBER_ENV || 'development';
};

function calculateBaseTag(config){
  var baseURL      = cleanBaseURL(config.baseURL);
  var locationType = config.locationType;

  if (locationType === 'hash') {
    return '';
  }

  if (baseURL) {
    return '<base href="' + baseURL + '" />';
  } else {
    return '';
  }
}

function calculateEmberENV(config) {
  return JSON.stringify(config.EmberENV || {});
}

function calculateModulePrefix(config) {
  return config.modulePrefix;
}

function calculateAppConfig(config) {
  return JSON.stringify(config.APP || {});
}

module.exports = Builder;
