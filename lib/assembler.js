/* global module, escape */
'use strict';

var SilentError = require('silent-error');
var ES3SafeFilter = require('broccoli-es3-safe-recast');
var upstreamMergeTrees = require('broccoli-merge-trees');
var cleanBaseURL = require('clean-base-url');
var TreeDescriptor = require('./models/tree-descriptor');
var Cache = require('./cache');
// TODO: this is now passed in
var Project = require('ember-cli/lib/models/project');
// TODO: this actually need to be passed in
var preprocessors = require('ember-cli-preprocess-registry/preprocessors');
var merge = require('lodash-node/modern/object/merge');
var defaults = require('merge-defaults');
var fs = require('fs');
var path = require('path');
var unwatchedTree = require('broccoli-unwatched-tree');
var configLoader = require('ember-cli/lib/broccoli/broccoli-config-loader');
var configReplace = require('ember-cli/lib/broccoli/broccoli-config-replace');
var babel = require('broccoli-babel-transpiler');
var stew = require('broccoli-stew');
var funnel = require('broccoli-funnel');
var amdNameResolver = require('amd-name-resolver');
var loadPath = require('./load-path');
var chalk = require('chalk');
var existsSync = require('exists-sync');
var walkSync = require('walk-sync');
var preprocessJs  = preprocessors.preprocessJs;
var preprocessTemplates = preprocessors.preprocessTemplates;
var preprocessCss = preprocessors.preprocessCss;
var preprocessMinifyCss = preprocessors.preprocessMinifyCss;
var rename = stew.rename;
var mv = stew.mv;
var find = stew.find;
var rm = stew.rm;

function Assembler(options) {
  options = options || {};

  this._initProject(options);

  this.env  = Assembler.env();
  this.name = options.name || this.project.name();
  this.registry = options.registry || preprocessors.defaultRegistry(this);

  var isProduction = this.env === 'production';

  this._initTestsAndHinting(options, isProduction);
  this._initOptions(options, isProduction);
  this.trees = this.options.trees;
  this.testPath = this.name + '/' + this.trees.tests;
  this.legacyTrees = [];
  this._importTrees = [];
  this.legacyImports = [];
  this.cache = new Cache();

  // @deprecated
  this.bowerDirectory = this.project.bowerDirectory;

  preprocessors.setupRegistry(this);
  this._notifyAddonIncluded();
}

// TODO needs better deprecation
Assembler.prototype.import = function(asset, options) {
  var assetPath = this._getAssetPath(asset);

  if (!assetPath) {
    return;
  }

  options = defaults(options || {}, {
    type: 'vendor',
    prepend: false
  });

  var directory    = path.dirname(assetPath);
  var subdirectory = directory.replace(new RegExp('^vendor/|' + this.bowerDirectory), '');
  var extension    = path.extname(assetPath);

  if (!extension) {
    throw new Error('You must pass a file to `app.import`. For directories specify them to the constructor under the `trees` option.');
  }

  this._importAssetTree(directory, subdirectory);

  if (options.exports) {
    Object.keys(options.exports).forEach(function(exportName) {
      this.legacyImports.push(exportName);
    }, this);
  }
};

Assembler.prototype.dependencies = function(pkg) {
  return this.project.dependencies(pkg);
};

/**
  @private
  @method _importAssetTree
  @param {String} directory
  @param {String} subdirectory
 */
Assembler.prototype._importAssetTree = function(directory, subdirectory) {
  if (existsSync(directory) && this._importTrees.indexOf(directory) === -1) {
    var tree = new funnel(directory, {
      srcDir: '/',
      destDir: subdirectory
    });

    var legacyDesc = new TreeDescriptor({
      name: directory,
      treeType: 'legacy',
      tree: tree
    });

    this.cache.set(directory, legacyDesc);
  }
};

/**
  @private
  @method _getAssetPath
  @param {(Object|String)} asset
  @return {(String|undefined)} assetPath
 */
Assembler.prototype._getAssetPath = function(asset) {
  /** @type {String} */
  var assetPath;

  if (typeof asset === 'object') {
    if (this.env in asset) {
      assetPath = asset[this.env];
    } else {
      assetPath = asset.development;
    }
  } else {
    assetPath = asset;
  }

  if (!assetPath) {
    return;
  }

  assetPath = assetPath.replace(path.sep, '/');

  if (assetPath.split('/').length < 2) {
    console.log(chalk.red('Using `app.import` with a file in the root of `vendor/` causes a significant performance penalty. Please move `'+ assetPath + '` into a subdirectory.'));
  }

  if (/[\*\,]/.test(assetPath)) {
    throw new Error('You must pass a file path (without glob pattern) to `app.import`.  path was: `' + assetPath + '`');
  }

  return assetPath;
};

Assembler.prototype._initProject = function(options) {
  this.project = options.project || Project.closestSync(process.cwd());

  if (options.configPath) {
    this.project.configPath = function() { return options.configPath; };
  }
};

Assembler.prototype._initTestsAndHinting = function(options, isProduction) {
  var testsEnabledDefault = process.env.EMBER_CLI_TEST_COMMAND || !isProduction;

  this.tests   = options.hasOwnProperty('tests')   ? options.tests   : testsEnabledDefault;
  this.hinting = options.hasOwnProperty('hinting') ? options.hinting : testsEnabledDefault;
};

Assembler.prototype._initOptions = function(options, isProduction) {
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

Assembler.prototype._notifyAddonIncluded = function() {
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

Assembler.prototype.initializeAddons = function() {
  this.project.initializeAddons();
};

Assembler.prototype._configTree = function() {
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

Assembler.prototype._contentForHead = function(content, config) {
  content.push(calculateBaseTag(config));

  if (this.options.storeConfigInMeta) {
    content.push('<meta name="' + config.modulePrefix + '/config/environment" ' +
                 'content="' + escape(JSON.stringify(config)) + '" />');
  }
};

Assembler.prototype._contentForConfigModule = function(content, config) {
  if (this.options.storeConfigInMeta) {
    content.push('var prefix = \'' + config.modulePrefix + '\';');
    var lib = require.resolve('ember-cli').replace('cli/index.js', '');
    content.push(fs.readFileSync( lib + 'broccoli/app-config-from-meta.js'));
  } else {
    content.push('return { \'default\': ' + JSON.stringify(config) + '};');
  }
};

Assembler.prototype.contentFor = function(config, match, type) {
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

Assembler.prototype._contentForAppBoot = function(content, config) {
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

Assembler.prototype.testIndex = function() {
  var tree = mv(configReplace(this.trees.tests, this._configTree(), {
    configPath: path.join(this.name, 'config', 'environments', 'test.json'),
    files: [ 'index.html' ],
    env: 'test',
    patterns: this._configReplacePatterns()
  }), this.testPath);

  var testDesc = new TreeDescriptor({
    name: this.testPath,
    tree: tree,
    treeType: 'index',
    root: this.project.root,
    nodeModulesPath: this.project.nodeModulesPath,
    pkg: this.project.pkg,
    packageName: this.project.pkg.name
  });

  this.cache.set(this.testPath, testDesc);
};

Assembler.prototype.testFiles = function() {
  var testemTree = unwatchedTree(path.join(__dirname, '..', 'node_modules/ember-cli/lib/broccoli'));
  // var testSupportPath = this.options.outputPaths.testSupport.js;
  // testSupportPath = testSupportPath.testSupport || testSupportPath;

  var tree = funnel(testemTree, {
    files: ['testem.js'],
    destDir: this.testPath
  });

  // var testSupport = funnel(testSupportPath);

  if (this.options.fingerprint && this.options.fingerprint.exclude) {
    this.options.fingerprint.exclude.push('testem');
  }

  var testSupportDesc = new TreeDescriptor({
    name: this.testPath,
    treeType: 'tests',
    tree: tree,
    root: this.project.root,
    nodeModulesPath: this.project.nodeModulesPath,
    pkg: this.project.pkg,
    packageName: this.project.pkg.name
  });

  this.cache.set(this.testPath, testSupportDesc);
};

Assembler.prototype.index = function() {
  var htmlName = this.options.outputPaths.app.html;
  var index = rename(this.trees.app, function(relativePath) {
    return relativePath === 'index.html' ? htmlName : relativePath;
  });

  var tree = mv(configReplace(index, this._configTree(), {
    configPath: path.join(this.name, 'config', 'environments', this.env + '.json'),
    files: [ htmlName ],
    patterns: this._configReplacePatterns()
  }), this.name + '/');

  var descriptor = new TreeDescriptor({
    name: this.name,
    treeType: 'index',
    tree: tree,
    root: this.project.root,
    nodeModulesPath: this.project.nodeModulesPath,
    pkg: this.project.pkg,
    packageName: this.project.pkg.name
  });

  this.cache.set(this.name, descriptor);
};

/**
 * Checks to see if the addon actually contains files
 * @param  {Object} addon An addon model
 * @param  {String} type  The type of tree we are verifing
 * @return {Boolean}
 */
Assembler.prototype._implementsTreeType = function(addon, type) {
  var typePath = path.join(addon.root, addon.treePaths[type]);

  if (existsSync(typePath)) {
    return walkSync(typePath).filter(function(relativePath) {
      return relativePath !== '.gitkeep';
    }).length > 0;
  }

  return false;
};

Assembler.prototype._fileTypesInTree = function(addon, type) {
  var typePath = path.join(addon.root, addon.treePaths[type]);
  if (existsSync(typePath)) {
    return uniq(walkSync(typePath).filter(byFile).map(byExtension));
  }

  return [];
};

Assembler.prototype.createAddonDescriptor = function(addon, type) {
  if (addon.treeFor) {
    if (this._implementsTreeType(addon, type)) {
      var tree = addon.treeFor(type);
      var descriptor = new TreeDescriptor({
        name: addon.name,
        tree: tree,
        treeType: type,
        packageName: addon.pkg.name,
        pkg: addon.pkg,
        nodeModulesPath: addon.nodeModulesPath,
        root: addon.root
      });

      this.cache.set(addon.name, descriptor);
    }
  }
};

Assembler.prototype.addonTreesFor = function(type) {
  return this.project.addons.map(function(addon) {
    if (addon.treeFor) {
      this.createAddonDescriptor(addon, type);
      return addon.treeFor(type);
    }
  }, this).filter(Boolean);
};

Assembler.prototype._podTemplatePatterns = function() {
  return this.registry.extensionsForType('template').map(function(extension) {
    return new RegExp('template.' + extension + '$');
  });
};

Assembler.prototype._filterAppTree = function() {
  if (this._cachedFilterAppTree) {
    return this._cachedFilterAppTree;
  }

  return this._cachedFilterAppTree = find(this.trees.app, {
    exclude: this._filterStylesAndTemplates()
  });
};

Assembler.prototype._filterStylesAndTemplates = function() {
  var podPatterns = this._podTemplatePatterns();
  return podPatterns.concat([
    // note: do not use path.sep here Funnel uses
    // walk-sync which always joins with `/` (not path.sep)
    new RegExp('^styles/'),
    new RegExp('^templates/'),
  ]);
};

Assembler.prototype._filteredAddonAppDir = function() {
  return this.cache.descriptorsByType('app').map(function(descriptor) {
    descriptor.trees.app = find(descriptor.trees.app, {
      exclude: this._filterStylesAndTemplates()
    });
    this.cache.set(descriptor.name, descriptor);

    return descriptor.trees.app;
  });
};

// Merges an addons app directory with the consuming app
Assembler.prototype._processedAppTree = function() {
  var filteredAddons = this._filteredAddonAppDir().concat(this._filterAppTree());
  return mv(mergeTrees(filteredAddons, {
    overwrite: true,
    description: 'TreeMerger (app)'
  }), this.name);
};

Assembler.prototype._processedTemplatesTree = function() {
  var addonTrees = this.addonTreesFor('templates');
  var addonPodTemplates = find(this.cache.treesByType('app'), 'pods/**/template.*');
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

Assembler.prototype.addonPostprocessTree = function(type, tree) {
  var workingTree = tree;
  this.project.addons.forEach(function(addon) {
    if (addon.postprocessTree) {
      workingTree = addon.postprocessTree(type, workingTree);
    }
  });
  return workingTree;
};

Assembler.prototype.addonLintTree = function(type, tree) {
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

Assembler.prototype.appJavascript = function() {
  var app = this._processedAppTree();
  var templates = this._processedTemplatesTree();

  if (this.options.es3Safe) {
    app = new ES3SafeFilter(app);
  }

  var preprocessedApp = preprocessJs(app, '/', this.name, {
    registry: this.registry
  });

  var postprocessedApp = this.addonPostprocessTree('js', preprocessedApp);

  var appTreeDescriptor = new TreeDescriptor({
    name: this.name,
    packageName: this.name,
    nodeModulesPath: this.project.nodeModulesPath,
    root: this.project.root,
    treeType: 'app',
    tree: mergeTrees([postprocessedApp, templates]),
    pkg: this.project.pkg
  });

  this.cache.set(this.name, appTreeDescriptor);
};

Assembler.prototype._processedTestsTree = function() {
    var testSupport = this.addonTreesFor('test-support').map(function(tree) {
      return mv(tree, '/test-support');
    }, this);
  return mv(mergeTrees(testSupport.concat(this.trees.tests)), this.testPath);
};

Assembler.prototype.appTests = function() {
  if (this.tests) {
    var tests = this._processedTestsTree();

    var preprocessedTests = preprocessJs(tests, '/tests', this.testPath, {
      registry: this.registry
    });

    var testTreeDescriptor = new TreeDescriptor({
      name: this.testPath,
      packageName: this.name,
      nodeModulesPath: this.project.nodeModulesPath,
      tree: preprocessedTests,
      root: this.project.root,
      treeType: 'tests',
      pkg: this.project.pkg
    });

    this.cache.set(this.testPath, testTreeDescriptor);
  }
};

Assembler.prototype.packagerFiles = function() {
  if (this._cachedEtherFiles) {
    return this._cachedEtherFiles;
  }

  var envFilePath = this.name + '/config/environment.js';
  var packager = '__packager__';

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
    destDir: '/' + packager
  });

  var envFile = rename(find(packagerFiles, { include: [packager + '/environment.js'] }), function() {
    return envFilePath;
  });

  packagerFiles = rm(packagerFiles, packager + '/environment.js');

  var envTreeDescriptor = new TreeDescriptor({
    name: envFilePath,
    tree: envFile,
    treeType: 'environment',
    root: this.project.root,
    nodeModulesPath: this.project.nodeModulesPath,
    pkg: this.project.pkg,
    packageName: this.name
  });

  var packageDescriptor = new TreeDescriptor({
    name: packager,
    treeType: 'packager',
    tree: packagerFiles,
    root: null,
    nodeModulesPath: null,
    pkg: null,
    packageName: packager
  });

  this.cache.set(packager, packageDescriptor);
  this.cache.set('environment', envTreeDescriptor);
};

Assembler.prototype.vendor = function() {
  this.addonTreesFor('vendor');

  this.cache.descriptorsByType('vendor').forEach(function(descriptor) {
    descriptor.trees.app = rename(descriptor.trees.app, function(relativePath) {
      return 'vendor/' + relativePath;
    });
    this.cache.set(descriptor.name, descriptor);
  }, this);
};

Assembler.prototype._mergeBabelOptions = function () {
  var defaultBabelOptions = {
    modules: 'amdStrict',
    moduleIds: true,
    exportModuleMetadata: true,
    sourceMaps: true,
    resolveModuleSource: amdNameResolver
  };
  var babelOptions = this.options.babel || {};

  this.babelOptions = defaults(babelOptions, defaultBabelOptions);

  return this.babelOptions;
};

Assembler.prototype.transpileTree = function(tree) {
  var babelOptions = this._mergeBabelOptions();

  return new babel(tree, babelOptions);
};

Assembler.prototype.populateCacheForJavascript = function() {
  this.packagerFiles();
  this.appJavascript();
  this.appTests();
  this.vendor();
  this.addonTreesFor('addon');
  this.addonTreesFor('dist');
};

Assembler.prototype.javascript = function() {
  this.populateCacheForJavascript();

  var cache = this.cache;
  var envFile = cache.get('environment');
  var appJavascript = cache.get(this.name);
  var appTests = cache.get(this.testPath);

  appJavascript.trees.app = this.transpileTree(
    mergeTrees([appJavascript.trees.app, envFile.trees.environment])
  );

  cache.set(this.name, appJavascript);
  cache.remove('environment');

  if (appTests) {
    appTests.tree = this.transpileTree(appTests.tree);
    cache.set(this.testPath, appTests);
  }

  cache.descriptorsByType('addon').forEach(function(descriptor) {
    descriptor.trees.addon = this.transpileTree(loadPath(descriptor.trees.addon, { name: descriptor.name }));
    cache.set(descriptor.name, descriptor);
  }, this);

};

Assembler.prototype._configReplacePatterns = function() {
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

Assembler.prototype.publicTree = function() {
  var trees = this.addonTreesFor('public').concat(this.trees.public ? this.trees.public : []);
  var tree = mv(mergeTrees(trees, {
    overwrite: true,
    description: 'TreeMerger (public)'
  }), this.name + '/');

  var publicDesc = new TreeDescriptor({
    name: this.name,
    treeType: 'public',
    tree: tree,
    root: this.project.root,
    nodeModulesPath: this.project.nodeModulesPath,
    pkg: this.project.pkg,
    packageName: this.project.pkg.name
  });

  this.cache.set(this.name, publicDesc);
};

Assembler.prototype.styles = function() {
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

  var preprocessedStyles = mv(preprocessCss(styles, '/app/styles', this.name, options), this.name + '/styles');

  if (this.options.minifyCSS.enabled === true) {
    options = this.options.minifyCSS.options || {};
    options.registry = this.registry;
    preprocessedStyles = preprocessMinifyCss(preprocessedStyles, options);
  }

  var styleDesc = new TreeDescriptor({
    name: this.name,
    treeType: 'styles',
    tree: preprocessedStyles,
    root: this.project.root,
    nodeModulesPath: this.project.nodeModulesPath,
    pkg: this.project.pkg,
    packageName: this.project.pkg.name
  });

  this.cache.set(this.name, styleDesc);
};

/**
 * Evicts addons that are now resident pieces to Ember CLI build pipeline
 * @return {Nil}
 */
Assembler.prototype.evictLegacyAddons = function() {
  this.registry.remove('javascript', 'ember-cli-babel');
};

Assembler.prototype.assemble = function() {
  this.evictLegacyAddons();
  this.index();
  this.javascript();
  this.publicTree();
  this.styles();
  this.testIndex();
  this.testFiles();
  return this.cache;
};

Assembler.env = function() {
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


function mergeTrees(inputTree, options) {
  var tree = upstreamMergeTrees(inputTree, options);
  tree.description = options && options.description;
  return tree;
}


function byFile(relativePath) {
  return relativePath.splice(-1) !== '/';
}

function byExtension(relativePath) {
  return path.extname(relativePath);
}

function uniq(array) {
  return array.filter(function(item, i, self) {
    return self.indexOf(item) === i;
  });
}

module.exports = Assembler;
